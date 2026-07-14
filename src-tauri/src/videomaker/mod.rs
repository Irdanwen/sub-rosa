//! Videomaker film production (ADR-0010) — fork module, desktop only.
//!
//! Sub Rosa drives the first-party Videomaker Studio REST API
//! (`https://studio.furetier.com/api`) to produce complete short films. This
//! module owns:
//! - the Studio wallet (see [`wallet`]) and the `vmk_` personal access token,
//!   both in the OS keychain, never exposed to the webview;
//! - the activation chain (SIWE → register the `cdm_` key → mint the PAT),
//!   see [`auth`];
//! - a typed client with the money-safety rails (cost-confirmation handshake,
//!   idempotency keys, error taxonomy), see [`client`];
//! - non-secret settings persisted to `videomaker.json` (base URL, PAT id,
//!   consent timestamp, watched film-project slugs).
//!
//! Everything here bills the user's Carpe Diem key in DIEM — the module never
//! handles money itself, it only makes spend explicit and confirmed.

pub mod auth;
pub mod brief;
pub mod client;
pub mod commands;
pub mod director;
pub mod events;
pub mod projects;
pub mod wallet;

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::Manager;

const SETTINGS_FILE: &str = "videomaker.json";
pub const DEFAULT_BASE_URL: &str = "https://studio.furetier.com";
const KEYCHAIN_WALLET_ACCOUNT: &str = "wallet-key";
const KEYCHAIN_TOKEN_ACCOUNT: &str = "api-token";
// Same service split as the Carpe Diem store: a dedicated keychain service,
// with a `-dev` variant so debug builds never touch release credentials.
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa.videomaker";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa-dev.videomaker";
const MAX_BASE_URL_CHARS: usize = 2_048;

static SETTINGS: OnceLock<Mutex<VideomakerSettings>> = OnceLock::new();

/// Non-secret settings persisted to `videomaker.json`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct VideomakerSettings {
    #[serde(default)]
    pub base_url: String,
    /// Id of the minted `vmk_` PAT (the token itself is in the keychain).
    /// Needed to revoke it server-side on deactivation.
    #[serde(default)]
    pub token_id: Option<String>,
    /// RFC3339 timestamp of the user's consent to registering their Carpe
    /// Diem key with Videomaker. Absent = never consented.
    #[serde(default)]
    pub consent_at: Option<String>,
    /// Film projects the app watches for progress (resumed on app start —
    /// production continues server-side while the app is closed).
    #[serde(default)]
    pub watched_slugs: Vec<String>,
    /// Finished films already downloaded into the artifacts gallery
    /// (slug → absolute artifact path). Guards against re-downloading on
    /// every reconnect, and survives Videomaker's 7-day purge.
    #[serde(default)]
    pub exported_films: std::collections::BTreeMap<String, String>,
}

/// What the frontend sees. Secrets never leave the Rust process; the wallet
/// address is public-by-design (it is the account id).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideomakerSettingsDto {
    pub base_url: String,
    pub default_base_url: String,
    pub activated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_address: Option<String>,
    pub has_carpe_diem_key: bool,
}

pub struct VideomakerState {
    config_path: PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    let loaded = load_from_disk(path.as_ref());
    replace_mirror(loaded);
    app.manage(VideomakerState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
    events::resume_watchers(app.handle());
}

// --- settings accessors ------------------------------------------------------

/// Current Videomaker base URL (scheme + host, no trailing slash).
pub fn base_url() -> String {
    let guard = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    let value = guard.base_url.trim().trim_end_matches('/').to_string();
    drop(guard);
    if value.is_empty() {
        DEFAULT_BASE_URL.to_string()
    } else {
        value
    }
}

/// The REST root (`{base}/api`).
pub fn api_root() -> String {
    format!("{}/api", base_url())
}

pub fn settings_snapshot() -> VideomakerSettings {
    mirror()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

/// Mutate + persist the non-secret settings in one step.
pub fn update_settings<F: FnOnce(&mut VideomakerSettings)>(
    app: &tauri::AppHandle,
    mutate: F,
) -> Result<VideomakerSettings, AppError> {
    let mut guard = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    mutate(&mut guard);
    let snapshot = guard.clone();
    drop(guard);
    let path = app
        .try_state::<VideomakerState>()
        .map(|state| state.config_path.clone())
        .unwrap_or_else(|| PathBuf::from(SETTINGS_FILE));
    persist(&path, &snapshot)?;
    Ok(snapshot)
}

// --- keychain ----------------------------------------------------------------

pub fn stored_wallet_hex() -> Option<String> {
    keychain_read(KEYCHAIN_WALLET_ACCOUNT)
}

pub fn stored_token() -> Option<String> {
    keychain_read(KEYCHAIN_TOKEN_ACCOUNT)
}

pub fn is_activated() -> bool {
    stored_token().is_some()
}

fn keychain_read(account: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub async fn keychain_write(account: &'static str, value: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYCHAIN_SERVICE, account).and_then(|entry| entry.set_password(&value))
    })
    .await
    .map_err(|error| AppError::new("videomaker_keychain", error.to_string()))?
    .map_err(|error| AppError::new("videomaker_keychain", error.to_string()))
}

pub async fn keychain_delete(account: &'static str) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, account) {
            // Absent entry is not an error — clearing an unset secret is a no-op.
            let _ = entry.delete_credential();
        }
    })
    .await
    .map_err(|error| AppError::new("videomaker_keychain", error.to_string()))
}

pub async fn store_wallet(hex_key: String) -> Result<(), AppError> {
    keychain_write(KEYCHAIN_WALLET_ACCOUNT, hex_key).await
}

pub async fn store_token(token: String) -> Result<(), AppError> {
    keychain_write(KEYCHAIN_TOKEN_ACCOUNT, token).await
}

pub async fn clear_token() -> Result<(), AppError> {
    keychain_delete(KEYCHAIN_TOKEN_ACCOUNT).await
}

// --- DTO ----------------------------------------------------------------------

pub fn dto() -> VideomakerSettingsDto {
    let wallet_address = stored_wallet_hex()
        .and_then(|raw| wallet::Wallet::from_hex(&raw).ok())
        .map(|wallet| wallet.address());
    VideomakerSettingsDto {
        base_url: base_url(),
        default_base_url: DEFAULT_BASE_URL.to_string(),
        activated: is_activated(),
        wallet_address,
        has_carpe_diem_key: crate::carpe_diem::settings::is_configured(),
    }
}

// --- Carpe Diem key lifecycle hooks -------------------------------------------

/// Called (desktop only) after the user saves a new `cdm_` key: Videomaker
/// bills whatever key is registered server-side, so a rotated key must be
/// re-pushed or films silently keep billing the old one. Best-effort.
pub fn on_carpe_diem_key_changed(app: &tauri::AppHandle) {
    if !is_activated() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = auth::register_carpe_diem_key(&app).await {
            eprintln!(
                "videomaker: failed to re-register the rotated Carpe Diem key: {}",
                error.message
            );
        }
    });
}

/// Called (desktop only) after the user removes their `cdm_` key: delete the
/// server-side copy so nothing can bill it anymore. Best-effort.
pub fn on_carpe_diem_key_cleared(app: &tauri::AppHandle) {
    if !is_activated() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = auth::delete_carpe_diem_key(&app).await {
            eprintln!(
                "videomaker: failed to delete the server-side Carpe Diem key: {}",
                error.message
            );
        }
    });
}

// --- internals -----------------------------------------------------------------

fn mirror() -> &'static Mutex<VideomakerSettings> {
    SETTINGS.get_or_init(|| Mutex::new(VideomakerSettings::default()))
}

fn replace_mirror(settings: VideomakerSettings) {
    let mut current = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    *current = settings;
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&PathBuf>) -> VideomakerSettings {
    let Some(path) = path else {
        return VideomakerSettings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<VideomakerSettings>(&raw).ok())
        .unwrap_or_default()
}

fn persist(path: &PathBuf, settings: &VideomakerSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("videomaker_settings_save", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("videomaker_settings_save", error.to_string()))?;
    fs::write(path, serialized)
        .map_err(|error| AppError::new("videomaker_settings_save", error.to_string()))
}

pub fn validate_base_url(raw: &str) -> Result<String, AppError> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err(AppError::new(
            "videomaker_base_url_required",
            "Enter a base URL.",
        ));
    }
    if !(value.starts_with("http://") || value.starts_with("https://")) {
        return Err(AppError::new(
            "videomaker_base_url_invalid",
            "The base URL must start with http:// or https://.",
        ));
    }
    if value.chars().count() > MAX_BASE_URL_CHARS
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(AppError::new(
            "videomaker_base_url_invalid",
            "That base URL is not valid.",
        ));
    }
    if host_of(value).is_empty() {
        return Err(AppError::new(
            "videomaker_base_url_invalid",
            "The base URL is missing a host.",
        ));
    }
    Ok(value.to_string())
}

/// The authority part of the base URL — the SIWE `domain` binding.
pub fn host_of(base: &str) -> String {
    base.strip_prefix("https://")
        .or_else(|| base.strip_prefix("http://"))
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_validation_mirrors_carpe_diem_rules() {
        assert_eq!(
            validate_base_url("  https://studio.furetier.com/  ").unwrap(),
            "https://studio.furetier.com"
        );
        assert!(validate_base_url("studio.furetier.com").is_err());
        assert!(validate_base_url("https://").is_err());
        assert!(validate_base_url("https://a b/c").is_err());
    }

    #[test]
    fn host_of_extracts_the_siwe_domain() {
        assert_eq!(
            host_of("https://studio.furetier.com"),
            "studio.furetier.com"
        );
        assert_eq!(host_of("http://localhost:8000"), "localhost:8000");
        assert_eq!(
            host_of("https://studio.furetier.com/deep/path"),
            "studio.furetier.com"
        );
    }

    #[test]
    fn settings_deserialize_tolerates_missing_fields() {
        let settings: VideomakerSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings, VideomakerSettings::default());
        let settings: VideomakerSettings =
            serde_json::from_str(r#"{"base_url":"https://x.test","watched_slugs":["a"]}"#).unwrap();
        assert_eq!(settings.base_url, "https://x.test");
        assert_eq!(settings.watched_slugs, vec!["a"]);
    }
}
