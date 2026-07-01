//! Carpe Diem settings storage + IPC.
//!
//! Two pieces of configuration drive the fork:
//! - `base_url` (NOT secret) — persisted as JSON in the app config dir.
//! - `api_key` (`cdm_…`, secret) — stored in the OS keychain via the `keyring`
//!   crate, never written to disk in plaintext and never returned to the
//!   frontend once saved (only a `has_api_key` boolean is exposed).
//!
//! The `june-api` sidecar ([`super::sidecar`]) reads [`base_url`] and
//! [`api_key`] at spawn time to point the backend at Carpe Diem.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

use super::branding;

const SETTINGS_FILE: &str = "carpe-diem.json";
const KEYCHAIN_ACCOUNT: &str = "api-key";
// Dedicated keychain service (separate from the dormant OS Accounts store) so
// the Carpe Diem key is clearly scoped. Debug builds use a `-dev` service to
// keep development credentials isolated from a release install.
#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa.carpe-diem";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa-dev.carpe-diem";
const MAX_API_KEY_CHARS: usize = 4_096;
const MAX_BASE_URL_CHARS: usize = 2_048;
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

static SETTINGS: OnceLock<Mutex<CarpeDiemSettings>> = OnceLock::new();

/// Non-secret settings persisted to `carpe-diem.json`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CarpeDiemSettings {
    #[serde(default = "default_base_url")]
    pub base_url: String,
}

impl Default for CarpeDiemSettings {
    fn default() -> Self {
        Self {
            base_url: default_base_url(),
        }
    }
}

/// What the frontend sees. The API key itself is never included — only whether
/// one is stored.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CarpeDiemSettingsDto {
    pub base_url: String,
    pub default_base_url: String,
    pub has_api_key: bool,
}

/// Result of the "Test connection" button — success plus an actionable message.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_count: Option<usize>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBaseUrlRequest {
    pub base_url: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetApiKeyRequest {
    pub api_key: String,
}

/// Managed state: only the on-disk path. The live values live in [`SETTINGS`]
/// (base URL) and the OS keychain (API key).
pub struct CarpeDiemState {
    config_path: PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    let loaded = load_from_disk(path.as_ref());
    set_mirror(loaded);
    app.manage(CarpeDiemState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
}

// --- Values read by the sidecar --------------------------------------------

/// Current Carpe Diem base URL (falls back to the default when unset/empty).
pub fn base_url() -> String {
    mirror()
        .lock()
        .ok()
        .map(|settings| settings.base_url.clone())
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_base_url)
}

/// The stored Carpe Diem API key, if any. Reads the OS keychain synchronously
/// (fine for the sidecar's setup path, which is not on the async runtime).
pub fn api_key() -> Option<String> {
    // Debug convenience: inject the key via env for `pnpm tauri:dev` without
    // touching the OS keychain (mirrors June's OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE
    // escape hatch). Never compiled into release builds.
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("SUBROSA_DEV_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

/// Whether the app has enough configuration to run (a key is present).
pub fn is_configured() -> bool {
    api_key().is_some()
}

// --- IPC commands ----------------------------------------------------------

#[tauri::command]
pub fn carpe_diem_get_settings() -> CarpeDiemSettingsDto {
    dto()
}

#[tauri::command]
pub fn carpe_diem_set_base_url(
    app: AppHandle,
    state: State<'_, CarpeDiemState>,
    request: SetBaseUrlRequest,
) -> Result<CarpeDiemSettingsDto, AppError> {
    let base_url = validate_base_url(&request.base_url)?;
    persist(
        &state.config_path,
        &CarpeDiemSettings {
            base_url: base_url.clone(),
        },
    )?;
    replace_mirror(CarpeDiemSettings { base_url });
    super::sidecar::on_settings_changed(&app);
    Ok(dto())
}

#[tauri::command]
pub async fn carpe_diem_set_api_key(
    app: AppHandle,
    request: SetApiKeyRequest,
) -> Result<CarpeDiemSettingsDto, AppError> {
    let key = normalize_api_key(&request.api_key)?;
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .and_then(|entry| entry.set_password(&key))
    })
    .await
    .map_err(|error| AppError::new("carpe_diem_keychain", error.to_string()))?
    .map_err(|error| AppError::new("carpe_diem_keychain", error.to_string()))?;
    super::sidecar::on_settings_changed(&app);
    Ok(dto())
}

#[tauri::command]
pub async fn carpe_diem_clear_api_key(app: AppHandle) -> Result<CarpeDiemSettingsDto, AppError> {
    tokio::task::spawn_blocking(|| {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            // Absent entry is not an error — clearing an unset key is a no-op.
            let _ = entry.delete_credential();
        }
    })
    .await
    .map_err(|error| AppError::new("carpe_diem_keychain", error.to_string()))?;
    super::sidecar::on_settings_changed(&app);
    Ok(dto())
}

#[tauri::command]
pub async fn carpe_diem_test_connection() -> Result<TestConnectionResult, AppError> {
    let base = base_url();
    let Some(key) = api_key() else {
        return Ok(TestConnectionResult {
            ok: false,
            model_count: None,
            message: "No API key set yet. Enter your Carpe Diem key (cdm_…) first.".to_string(),
            code: Some("no_api_key".to_string()),
        });
    };

    let client = reqwest::Client::builder()
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::new("carpe_diem_http_client", error.to_string()))?;
    let base = base.trim_end_matches('/').to_string();

    // 1) Reachability + catalog size (public on Carpe Diem, so proves the URL).
    let model_count = match client
        .get(format!("{base}/models"))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("data")
                    .and_then(|data| data.as_array())
                    .map(|models| models.len())
            }),
        Ok(_) => None,
        Err(error) => {
            return Ok(unreachable_result(&base, error.is_timeout(), None));
        }
    };

    // 2) A minimal authenticated completion validates the key AND credits.
    let body = serde_json::json!({
        "model": crate::providers::DEFAULT_GENERATION_MODEL,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
    });
    match client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Ok(TestConnectionResult {
            ok: true,
            model_count,
            message: match model_count {
                Some(count) => format!("Connected. {count} models available."),
                None => "Connected.".to_string(),
            },
            code: None,
        }),
        Ok(response) => {
            let (code, message) = match response.status().as_u16() {
                401 | 403 => (
                    "invalid_key",
                    "The API key was rejected. Check that you pasted the full cdm_ key.",
                ),
                402 => (
                    "insufficient_credits",
                    "The key is valid but has no credits. Add credits in the Carpe Diem dashboard.",
                ),
                404 => (
                    "endpoint_or_model",
                    "Endpoint or model not found. Check that the base URL is correct.",
                ),
                429 => ("rate_limited", "Rate limited. Try again in a moment."),
                _ => (
                    "upstream_error",
                    "The endpoint returned an error. Try again.",
                ),
            };
            Ok(TestConnectionResult {
                ok: false,
                model_count,
                message: message.to_string(),
                code: Some(code.to_string()),
            })
        }
        Err(error) => Ok(unreachable_result(&base, error.is_timeout(), model_count)),
    }
}

// --- internals -------------------------------------------------------------

fn unreachable_result(
    base: &str,
    timeout: bool,
    model_count: Option<usize>,
) -> TestConnectionResult {
    let message = if timeout {
        format!("{base} timed out. Check your connection and the base URL.")
    } else {
        format!("Couldn't reach {base}. Check the base URL and your connection.")
    };
    TestConnectionResult {
        ok: false,
        model_count,
        message,
        code: Some("unreachable".to_string()),
    }
}

fn dto() -> CarpeDiemSettingsDto {
    CarpeDiemSettingsDto {
        base_url: base_url(),
        default_base_url: default_base_url(),
        has_api_key: api_key().is_some(),
    }
}

fn default_base_url() -> String {
    branding::CARPE_DIEM_DEFAULT_BASE_URL.to_string()
}

fn mirror() -> &'static Mutex<CarpeDiemSettings> {
    SETTINGS.get_or_init(|| Mutex::new(CarpeDiemSettings::default()))
}

fn set_mirror(settings: CarpeDiemSettings) {
    replace_mirror(settings);
}

fn replace_mirror(settings: CarpeDiemSettings) {
    if let Ok(mut current) = mirror().lock() {
        *current = settings;
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&PathBuf>) -> CarpeDiemSettings {
    let Some(path) = path else {
        return CarpeDiemSettings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CarpeDiemSettings>(&raw).ok())
        .map(|settings| CarpeDiemSettings {
            base_url: {
                let trimmed = settings.base_url.trim().trim_end_matches('/');
                if trimmed.is_empty() {
                    default_base_url()
                } else {
                    trimmed.to_string()
                }
            },
        })
        .unwrap_or_default()
}

fn persist(path: &PathBuf, settings: &CarpeDiemSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("carpe_diem_settings_save", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("carpe_diem_settings_save", error.to_string()))?;
    fs::write(path, serialized)
        .map_err(|error| AppError::new("carpe_diem_settings_save", error.to_string()))
}

fn validate_base_url(raw: &str) -> Result<String, AppError> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err(AppError::new(
            "carpe_diem_base_url_required",
            "Enter a base URL.",
        ));
    }
    if !(value.starts_with("http://") || value.starts_with("https://")) {
        return Err(AppError::new(
            "carpe_diem_base_url_invalid",
            "The base URL must start with http:// or https://.",
        ));
    }
    if value.chars().count() > MAX_BASE_URL_CHARS || value.chars().any(|c| c.is_control()) {
        return Err(AppError::new(
            "carpe_diem_base_url_invalid",
            "That base URL is not valid.",
        ));
    }
    Ok(value.to_string())
}

fn normalize_api_key(raw: &str) -> Result<String, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::new(
            "carpe_diem_api_key_required",
            "Enter your Carpe Diem API key (cdm_…).",
        ));
    }
    if value.chars().count() > MAX_API_KEY_CHARS || value.chars().any(|c| c.is_control()) {
        return Err(AppError::new(
            "carpe_diem_api_key_invalid",
            "That does not look like a valid API key.",
        ));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_base_url_trims_and_requires_scheme() {
        assert_eq!(
            validate_base_url("  https://carpe-diem.xyz/api/operator/v1/  ").unwrap(),
            "https://carpe-diem.xyz/api/operator/v1"
        );
        assert!(validate_base_url("carpe-diem.xyz").is_err());
        assert!(validate_base_url("   ").is_err());
    }

    #[test]
    fn normalize_api_key_rejects_empty_and_control_chars() {
        assert_eq!(normalize_api_key("  cdm_abc  ").unwrap(), "cdm_abc");
        assert!(normalize_api_key("").is_err());
        assert!(normalize_api_key("cdm_\nabc").is_err());
    }

    #[test]
    fn settings_default_uses_carpe_diem_base_url() {
        assert_eq!(
            CarpeDiemSettings::default().base_url,
            branding::CARPE_DIEM_DEFAULT_BASE_URL
        );
    }

    #[test]
    fn load_from_disk_falls_back_to_default_when_missing() {
        let missing = PathBuf::from("/nonexistent/carpe-diem.json");
        assert_eq!(
            load_from_disk(Some(&missing)).base_url,
            branding::CARPE_DIEM_DEFAULT_BASE_URL
        );
    }
}
