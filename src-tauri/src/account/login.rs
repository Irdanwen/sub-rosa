//! Signing in without leaving the app: it opens the real Sub Rosa page and the
//! browser hands the session straight back through the scheme the app
//! registered.
//!
//! What replaced the eight character code is a binding in two halves, carried
//! on two channels. The PKCE verifier proves which instance of the app started
//! the request and never leaves this device. The return code proves which
//! machine finished it: the service creates it only once somebody has actually
//! authenticated, and it travels only in the deep link. The exchange demands
//! both, so a stolen start link is one half short and an app squatting the
//! scheme is the other half short (ADR 0055).
use super::*;
use chrono::{DateTime, Utc};
use tauri::Emitter;

const PENDING: &str = "pending-login";
/// The keyring slot for a sign-in that has no account yet. A literal that
/// cannot collide with the account UUIDs every other slot is keyed by.
const NO_ACCOUNT: &str = "pending";

#[derive(Serialize, Deserialize)]
pub struct NativeLogin {
    pub request_id: String,
    pub start_url: String,
    pub expires_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredLogin {
    base: String,
    request_id: String,
    start_url: String,
    verifier: String,
    expires_at: String,
}

fn unsolicited() -> AppError {
    AppError::new(
        "account_login_unsolicited",
        "A sign-in finished that this app did not start. Nothing was connected.",
    )
}
fn alive(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|at| at.with_timezone(&Utc) > Utc::now())
}
fn read_pending(base: &str) -> Option<StoredLogin> {
    let stored = get_secret(base, NO_ACCOUNT, PENDING).ok().flatten()?;
    let login = serde_json::from_str::<StoredLogin>(stored.expose_str()).ok()?;
    (login.base == base && alive(&login.expires_at)).then_some(login)
}
/// Whether a sign-in this app started is still in flight.
pub(super) fn has_pending(base: &str) -> bool {
    read_pending(base).is_some()
}
/// Forgets a sign-in that was abandoned or has run out. The service request
/// expires on its own; nothing here can be approved without the verifier.
pub(super) fn forget_pending(base: &str) {
    let _ = remove_secret(base, NO_ACCOUNT, PENDING);
}

#[tauri::command]
pub async fn account_login_open(
    app: AppHandle,
    device_name: String,
) -> Result<NativeLogin, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(&app).await?;
    if device_name.trim().is_empty() || device_name.len() > 100 {
        return Err(error("account_device_name_invalid"));
    }
    let base = login_server(&pool).await?;
    let verifier = crypto::encode(&*crypto::random_key());
    let challenge = crypto::encode(&Sha256::digest(verifier.as_bytes()));
    // Signing in again on a machine that already holds a device secret should
    // reuse its row rather than leave a second entry in the person's list.
    let row = query("SELECT device_id,account_id FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?;
    let mut body = json!({"device_name":device_name,"challenge":challenge,"native":true});
    if let (Some(device), Some(account)) = (
        row.get::<Option<String>, _>("device_id"),
        row.get::<Option<String>, _>("account_id"),
    ) {
        if let Ok(Some(secret)) = get_secret(&base, &account, DEVICE) {
            body["device_id"] = json!(device);
            body["device_secret"] = json!(secret.expose_str());
        }
    }
    let result = request(
        &base,
        None,
        reqwest::Method::POST,
        "/api/v1/device-login",
        Some(body),
    )
    .await?;
    let login: NativeLogin =
        serde_json::from_value(result).map_err(|_| error("account_response_invalid"))?;
    // The start link has to come from the service we are talking to, and it has
    // to be a link at all.
    let start =
        reqwest::Url::parse(&login.start_url).map_err(|_| error("account_response_invalid"))?;
    let origin = reqwest::Url::parse(&base).map_err(|_| error("account_response_invalid"))?;
    if start.origin() != origin.origin() || !alive(&login.expires_at) {
        return Err(error("account_response_invalid"));
    }
    uuid::Uuid::parse_str(&login.request_id).map_err(|_| error("account_response_invalid"))?;
    // Durable before the browser opens: the person may quit the app while they
    // are signing in, and the half that lives here has to still be here when
    // they come back.
    let stored = Zeroizing::new(
        serde_json::to_string(&json!({
            "base": base,
            "request_id": login.request_id,
            "start_url": login.start_url,
            "verifier": verifier,
            "expires_at": login.expires_at,
        }))
        .map_err(|_| error("account_response_invalid"))?,
    );
    put_secret(&base, NO_ACCOUNT, PENDING, &stored)?;
    Ok(login)
}

/// Authenticate within the platform's passkey picker and complete the ordinary
/// PKCE-bound device exchange. The request is durable before any system UI is
/// shown, so an interrupted prompt leaves a recoverable browser fallback.
#[tauri::command]
pub async fn account_login_passkey(app: AppHandle, device_name: String) -> Result<(), AppError> {
    #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
    {
        let _ = (app, device_name);
        return Err(error("account_passkey_unavailable"));
    }
    #[cfg(any(target_os = "android", target_os = "ios", target_os = "macos"))]
    {
        let login = account_login_open(app.clone(), device_name).await?;
        let pool = pool(&app).await?;
        let base = login_server(&pool).await?;
        let pending = read_pending(&base).ok_or_else(unsolicited)?;
        let challenge = request(
            &base,
            None,
            reqwest::Method::POST,
            "/api/v1/passkeys/native/start",
            Some(json!({
                "request_id": login.request_id,
                "verifier": pending.verifier,
            })),
        )
        .await?;
        let attempt_id = challenge
            .get("attempt_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| error("account_response_invalid"))?;
        let options = challenge
            .get("options")
            .and_then(|value| value.get("publicKey"))
            .ok_or_else(|| error("account_response_invalid"))?
            .clone();
        let credential = tauri::async_runtime::spawn_blocking(move || {
            #[cfg(target_os = "android")]
            {
                crate::android::passkey_get(&options)
            }
            #[cfg(any(target_os = "ios", target_os = "macos"))]
            {
                crate::apple_passkey::get(&options)
            }
        })
        .await
        .map_err(|_| error("account_passkey_unavailable"))??;
        let answer = request(
            &base,
            None,
            reqwest::Method::POST,
            "/api/v1/passkeys/native/finish",
            Some(json!({"attempt_id": attempt_id, "credential": credential})),
        )
        .await?;
        let request_id = answer
            .get("request_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| error("account_response_invalid"))?;
        let return_code = answer
            .get("return_code")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| error("account_response_invalid"))?;
        if request_id != login.request_id || return_code.len() != 43 {
            return Err(error("account_response_invalid"));
        }
        finish(&app, request_id, return_code).await
    }
}

/// Lets the screen pick a sign-in back up after a restart, with the same link,
/// instead of showing a fresh one that would strand the request in flight.
#[tauri::command]
pub async fn account_login_pending(app: AppHandle) -> Result<Option<NativeLogin>, AppError> {
    let pool = pool(&app).await?;
    let Some(base) = query("SELECT server_url FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?
        .get::<Option<String>, _>("server_url")
    else {
        return Ok(None);
    };
    Ok(read_pending(&base).map(|login| NativeLogin {
        request_id: login.request_id,
        start_url: login.start_url,
        expires_at: login.expires_at,
    }))
}

#[tauri::command]
pub async fn account_login_cancel(app: AppHandle) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    if let Some(base) = query("SELECT server_url FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?
        .get::<Option<String>, _>("server_url")
    {
        forget_pending(&base);
    }
    Ok(())
}

/// The second half arriving. Called from the deep link handler, never from the
/// webview: the return code is spent here and is not something the interface
/// ever needs to hold.
pub(super) async fn finish(app: &AppHandle, request_id: &str, code: &str) -> Result<(), AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(app).await?;
    let row = query("SELECT server_url,account_id FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?;
    let base: String = row
        .get::<Option<String>, _>("server_url")
        .ok_or_else(unsolicited)?;
    let pending = read_pending(&base).ok_or_else(unsolicited)?;
    // A link that does not answer the request this app is waiting on is somebody
    // else's sign-in, or a stale one. Either way it connects nothing.
    if pending.request_id != request_id {
        return Err(unsolicited());
    }
    let result = request(
        &base,
        None,
        reqwest::Method::POST,
        "/api/v1/device-login/exchange",
        Some(json!({
            "request_id": request_id,
            "verifier": pending.verifier,
            "return_code": code,
        })),
    )
    .await?;
    install_session(
        &pool,
        &base,
        &row.get::<Option<String>, _>("account_id"),
        &result,
    )
    .await?;
    forget_pending(&base);
    // The same follow-up the code flow does, so a native sign-in does not land
    // on "create a vault" for an account that already has one.
    note_vault_presence(&pool).await;
    let _ = app.emit("subrosa://account-updated", ());
    Ok(())
}

/// The one link shape this owns. Anything else belongs to the webview's own
/// destination handling and is left alone here.
fn parse_callback(url: &str) -> Option<(String, Redacted<String>)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "subrosa"
        || parsed.host_str() != Some("auth")
        || parsed.path().trim_end_matches('/') != "/callback"
    {
        return None;
    }
    let mut request_id = None;
    let mut code = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "request" => request_id = Some(value.into_owned()),
            "code" => code = Some(Redacted::new(value.into_owned())),
            _ => {}
        }
    }
    let request_id = request_id?;
    uuid::Uuid::parse_str(&request_id).ok()?;
    Some((request_id, code?))
}

/// Every `subrosa://` link the account owns. Anything else belongs to the
/// webview's own destination handling and is left alone here.
pub(crate) fn on_deep_link(app: &AppHandle, url: &str) {
    let Some((request_id, code)) = parse_callback(url) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(failure) = finish(&app, &request_id, code.expose_str()).await {
            // Worth saying out loud: an unsolicited return means somebody sent
            // the person a sign-in link, and nothing was connected.
            let _ = app.emit("subrosa://account-login-failed", failure.code.clone());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST: &str = "0192f3c4-5d6e-7f80-9123-456789abcdef";

    #[test]
    fn a_callback_link_is_recognised_only_in_one_exact_shape() {
        let (request, code) = parse_callback(&format!(
            "subrosa://auth/callback?request={REQUEST}&code=abc"
        ))
        .expect("the shape the service sends");
        assert_eq!(request, REQUEST);
        assert_eq!(code.expose_str(), "abc");
        for other in [
            // Another scheme entirely.
            &format!("https://auth/callback?request={REQUEST}&code=abc"),
            // The app's own destination links, which belong to the webview.
            &format!("subrosa://note/{REQUEST}"),
            // Half a link is not a link: neither half is usable alone.
            &format!("subrosa://auth/callback?request={REQUEST}"),
            "subrosa://auth/callback?code=abc",
            // A request id that is not one at all.
            "subrosa://auth/callback?request=../../etc&code=abc",
        ] {
            assert!(
                parse_callback(other).is_none(),
                "should be ignored: {other}"
            );
        }
    }

    #[test]
    fn the_pending_slot_cannot_collide_with_an_account() {
        // Every other slot is keyed by an account UUID. A sign-in has no
        // account yet, so it uses a literal that can never parse as one.
        assert!(uuid::Uuid::parse_str(NO_ACCOUNT).is_err());
        assert_ne!(
            slot("https://example.test", NO_ACCOUNT, PENDING),
            slot("https://example.test", REQUEST, PENDING)
        );
    }
}
