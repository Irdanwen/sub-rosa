//! The Videomaker auth chain (ADR-0010).
//!
//! Three-stage, fully silent after the consent click:
//! 1. SIWE cookie session (`/api/auth/verify`) — required by Videomaker for
//!    credential management (`/api/me/key` rejects PAT auth by design). The
//!    session lives in an in-memory reqwest cookie store and is dropped after
//!    use, never persisted.
//! 2. Register the user's Carpe Diem `cdm_` key (`POST /api/me/key`) so
//!    production bills the user's own DIEM balance.
//! 3. Mint a long-lived `vmk_` personal access token (`POST /api/auth/token`,
//!    scopes read+write+produce) for every other call. Stored in the OS
//!    keychain; its id is kept in `videomaker.json` for later revocation.
//!
//! Nonces are single-use, so each signature gets its own nonce fetch.

use super::wallet::Wallet;
use crate::domain::types::AppError;
use serde_json::json;
use std::time::Duration;

const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const TOKEN_LABEL: &str = "sub-rosa-desktop";

fn auth_client(with_cookies: bool) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(AUTH_TIMEOUT)
        .cookie_store(with_cookies)
        .build()
        .map_err(|error| AppError::new("videomaker_http_client", error.to_string()))
}

/// Load the Studio wallet from the keychain, generating (and storing) one on
/// first use. The wallet is the Videomaker account id — it is created once
/// and reused for the lifetime of the install.
pub async fn ensure_wallet() -> Result<Wallet, AppError> {
    if let Some(raw) = super::stored_wallet_hex() {
        return Wallet::from_hex(&raw);
    }
    let wallet = Wallet::generate();
    super::store_wallet(wallet.to_hex()).await?;
    Ok(wallet)
}

async fn fetch_nonce(client: &reqwest::Client, root: &str) -> Result<String, AppError> {
    let response = client
        .get(format!("{root}/auth/nonce"))
        .send()
        .await
        .map_err(|error| unreachable_error(&error))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|error| {
        AppError::new(
            "videomaker_auth_failed",
            format!("Bad nonce response: {error}"),
        )
    })?;
    if !status.is_success() {
        return Err(AppError::new(
            "videomaker_auth_failed",
            format!("The nonce endpoint returned {status}."),
        ));
    }
    body.get("nonce")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::new(
                "videomaker_auth_failed",
                "The nonce response is missing a nonce.",
            )
        })
}

/// Build + sign a fresh SIWE message (one nonce per signature).
async fn signed_siwe(
    client: &reqwest::Client,
    wallet: &Wallet,
) -> Result<(String, String), AppError> {
    let base = super::base_url();
    let root = super::api_root();
    let nonce = fetch_nonce(client, &root).await?;
    let issued_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let message = super::wallet::siwe_message(
        &super::host_of(&base),
        &wallet.address(),
        &base,
        &nonce,
        &issued_at,
    );
    let signature = wallet.sign_personal(&message)?;
    Ok((message, signature))
}

/// Open a short-lived cookie session (for the browser-only credential routes).
async fn open_cookie_session(wallet: &Wallet) -> Result<reqwest::Client, AppError> {
    let client = auth_client(true)?;
    let (message, signature) = signed_siwe(&client, wallet).await?;
    let response = client
        .post(format!("{}/auth/verify", super::api_root()))
        .json(&json!({ "message": message, "signature": signature }))
        .send()
        .await
        .map_err(|error| unreachable_error(&error))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(AppError::new(
            "videomaker_auth_failed",
            format!("Sign-in was rejected ({status}): {detail}"),
        ));
    }
    Ok(client)
}

/// Register (or re-register) the user's Carpe Diem key with Videomaker.
/// Cookie-session route by design. The configured Carpe Diem base URL is
/// forwarded when it differs from the default, so a custom operator keeps
/// working end to end.
pub async fn register_carpe_diem_key(_app: &tauri::AppHandle) -> Result<(), AppError> {
    let Some(api_key) = crate::carpe_diem::settings::api_key() else {
        return Err(AppError::new(
            "videomaker_no_carpe_diem_key",
            "Add your Carpe Diem key first (Settings > Carpe Diem).",
        ));
    };
    let wallet = ensure_wallet().await?;
    let client = open_cookie_session(&wallet).await?;
    let mut body = json!({ "api_key": api_key });
    let carpe_diem_base = crate::carpe_diem::settings::base_url();
    if carpe_diem_base != crate::carpe_diem::branding::CARPE_DIEM_DEFAULT_BASE_URL {
        body["base_url"] = json!(carpe_diem_base);
    }
    let response = client
        .post(format!("{}/me/key", super::api_root()))
        .json(&body)
        .send()
        .await
        .map_err(|error| unreachable_error(&error))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(AppError::new(
            "videomaker_key_registration_failed",
            format!("Videomaker rejected the Carpe Diem key ({status}): {detail}"),
        ));
    }
    Ok(())
}

/// Delete the server-side copy of the Carpe Diem key (cookie-session route).
pub async fn delete_carpe_diem_key(_app: &tauri::AppHandle) -> Result<(), AppError> {
    let wallet = ensure_wallet().await?;
    let client = open_cookie_session(&wallet).await?;
    let response = client
        .delete(format!("{}/me/key", super::api_root()))
        .send()
        .await
        .map_err(|error| unreachable_error(&error))?;
    // 404 = nothing registered; that is the desired end state.
    if !response.status().is_success() && response.status().as_u16() != 404 {
        let status = response.status();
        return Err(AppError::new(
            "videomaker_key_removal_failed",
            format!("Videomaker did not delete the key ({status})."),
        ));
    }
    Ok(())
}

/// Mint a fresh `vmk_` PAT and persist it (keychain) + its id (settings).
/// Also the 401 self-heal path: the wallet is still there, so a dead token
/// just gets re-minted.
pub async fn mint_and_store_token(app: &tauri::AppHandle) -> Result<String, AppError> {
    let wallet = ensure_wallet().await?;
    let client = auth_client(false)?;
    let (message, signature) = signed_siwe(&client, &wallet).await?;
    let response = client
        .post(format!("{}/auth/token", super::api_root()))
        .json(&json!({
            "message": message,
            "signature": signature,
            "label": TOKEN_LABEL,
            "scopes": ["read", "write", "produce"],
            "ttl_days": null,
        }))
        .send()
        .await
        .map_err(|error| unreachable_error(&error))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(AppError::new(
            "videomaker_auth_failed",
            format!("Token minting was rejected ({status}): {body}"),
        ));
    }
    let token = body
        .get("api_token")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::new(
                "videomaker_auth_failed",
                "The token response is missing api_token.",
            )
        })?;
    let token_id = body.get("id").and_then(|id| {
        id.as_str()
            .map(str::to_string)
            .or_else(|| id.as_i64().map(|n| n.to_string()))
    });
    super::store_token(token.clone()).await?;
    super::update_settings(app, |settings| settings.token_id = token_id)?;
    Ok(token)
}

/// The full activation chain (consent already checked by the command).
pub async fn activate(app: &tauri::AppHandle) -> Result<(), AppError> {
    register_carpe_diem_key(app).await?;
    mint_and_store_token(app).await?;
    super::update_settings(app, |settings| {
        settings.consent_at =
            Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    })?;
    Ok(())
}

/// Best-effort remote cleanup on deactivation: delete the server-side key and
/// revoke the PAT. Local secrets are cleared by the command regardless.
pub async fn revoke_remote(_app: &tauri::AppHandle) -> Result<(), AppError> {
    let wallet = ensure_wallet().await?;
    let client = open_cookie_session(&wallet).await?;
    let root = super::api_root();
    let key_result = client.delete(format!("{root}/me/key")).send().await;
    if let Some(token_id) = super::settings_snapshot().token_id {
        let _ = client
            .delete(format!("{root}/me/tokens/{token_id}"))
            .send()
            .await;
    }
    key_result
        .map_err(|error| unreachable_error(&error))
        .map(|_| ())
}

fn unreachable_error(error: &reqwest::Error) -> AppError {
    let base = super::base_url();
    if error.is_timeout() {
        AppError::new(
            "videomaker_unreachable",
            format!("{base} timed out. Check your connection."),
        )
    } else {
        AppError::new(
            "videomaker_unreachable",
            format!("Couldn't reach {base}. Check your connection."),
        )
    }
}
