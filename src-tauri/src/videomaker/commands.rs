//! Tauri command surface for the Films settings + account lifecycle.
//! Project/production commands live in [`super::projects`].

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBaseUrlRequest {
    pub base_url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateRequest {
    /// The UI shows the consent copy (the Carpe Diem key is sent to and
    /// stored by Videomaker, which bills it); activation is refused without
    /// it — defense in depth, not just a disabled button.
    pub consent: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatusDto {
    pub wallet_address: String,
    pub has_key: bool,
    /// Raw `/api/balance` body (DIEM figures; shape is Videomaker's).
    pub balance: serde_json::Value,
    /// Raw `/api/quota` body.
    pub quota: serde_json::Value,
}

#[tauri::command]
pub fn videomaker_get_settings() -> super::VideomakerSettingsDto {
    super::dto()
}

#[tauri::command]
pub fn videomaker_set_base_url(
    app: AppHandle,
    request: SetBaseUrlRequest,
) -> Result<super::VideomakerSettingsDto, AppError> {
    let base_url = super::validate_base_url(&request.base_url)?;
    // The PAT and the SIWE session are bound to the current host; switching
    // hosts under an active token would leave a half-broken account state.
    if super::is_activated() && base_url != super::base_url() {
        return Err(AppError::new(
            "videomaker_deactivate_first",
            "Deactivate film production before changing the studio URL.",
        ));
    }
    super::update_settings(&app, |settings| settings.base_url = base_url)?;
    Ok(super::dto())
}

/// The one-click onboarding: wallet → SIWE → key registration → PAT.
#[tauri::command]
pub async fn videomaker_activate(
    app: AppHandle,
    request: ActivateRequest,
) -> Result<super::VideomakerSettingsDto, AppError> {
    if !request.consent {
        return Err(AppError::new(
            "videomaker_consent_required",
            "Activation needs your consent to share the Carpe Diem key with Videomaker.",
        ));
    }
    if !crate::carpe_diem::settings::is_configured() {
        return Err(AppError::new(
            "videomaker_no_carpe_diem_key",
            "Add your Carpe Diem key first (Settings > Carpe Diem).",
        ));
    }
    super::auth::activate(&app).await?;
    Ok(super::dto())
}

/// Deactivate: best-effort remote cleanup (delete the server-side key, revoke
/// the PAT), then always clear local secrets. The wallet is kept — it is the
/// account id and holds nothing.
#[tauri::command]
pub async fn videomaker_deactivate(
    app: AppHandle,
) -> Result<super::VideomakerSettingsDto, AppError> {
    super::events::stop_all();
    if let Err(error) = super::auth::revoke_remote(&app).await {
        eprintln!(
            "videomaker: remote cleanup failed during deactivation (continuing): {}",
            error.message
        );
    }
    super::clear_token().await?;
    super::update_settings(&app, |settings| {
        settings.token_id = None;
        settings.consent_at = None;
    })?;
    Ok(super::dto())
}

/// Live account snapshot for the settings section: identity + server-side key
/// state + DIEM balance/quota under the user's Carpe Diem key.
#[tauri::command]
pub async fn videomaker_account_status(app: AppHandle) -> Result<AccountStatusDto, AppError> {
    let (me, balance, quota) = tokio::join!(
        super::client::send(&app, super::client::Request::get("/me")),
        super::client::send(&app, super::client::Request::get("/balance")),
        super::client::send(&app, super::client::Request::get("/quota")),
    );
    let me = me?;
    let balance = balance.unwrap_or(serde_json::Value::Null);
    let quota = quota.unwrap_or(serde_json::Value::Null);
    let wallet = super::auth::ensure_wallet().await?;
    Ok(AccountStatusDto {
        wallet_address: wallet.address(),
        has_key: me
            .get("has_key")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        balance,
        quota,
    })
}
