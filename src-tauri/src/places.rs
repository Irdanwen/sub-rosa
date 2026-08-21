//! Places settings and photo bytes (the premium half of the places card).
//!
//! The user's Google Places key follows the `cdm_` key's pattern exactly: OS
//! keychain, never a config file, never an env var in release builds. It is
//! consumed in two ways, both app-side:
//! - place SEARCHES forward it per request to the local june-api as the
//!   `x-places-google-key` header (see `june_api::forward_places_request`),
//!   which routes to the keyed provider — no restart, effective immediately;
//! - place PHOTOS are fetched here, straight from the app process, because
//!   the webview's CSP bars it from talking to Google and the key must never
//!   appear in the DOM. Bytes come back as a cached `data:` URL.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa.places";
#[cfg(debug_assertions)]
const KEYCHAIN_SERVICE: &str = "xyz.carpediem.subrosa-dev.places";
const KEYCHAIN_ACCOUNT: &str = "google-places-key";

const PHOTO_BASE_URL: &str = "https://places.googleapis.com/v1";
const PHOTO_MAX_WIDTH_DEFAULT: u32 = 96;
const PHOTO_MAX_WIDTH_CAP: u32 = 512;
const MAX_PHOTO_REF_LEN: usize = 512;
/// Photo bytes cap: a thumbnail that "weighs" more than this is not one.
const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;

/// The stored Google Places key, if any. Keychain reads are synchronous, so
/// async callers go through [`google_places_key_async`].
pub fn google_places_key() -> Option<String> {
    // Debug convenience, mirroring SUBROSA_DEV_API_KEY for the cdm_ key.
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("SUBROSA_DEV_PLACES_KEY") {
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

pub async fn google_places_key_async() -> Option<String> {
    tokio::task::spawn_blocking(google_places_key)
        .await
        .ok()
        .flatten()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacesSettingsDto {
    /// Only presence crosses IPC; the key itself never reaches the webview.
    pub google_key_present: bool,
}

fn dto() -> PlacesSettingsDto {
    PlacesSettingsDto {
        google_key_present: google_places_key().is_some(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGoogleKeyRequest {
    pub api_key: String,
}

fn normalize_key(raw: &str) -> Result<String, AppError> {
    let key = raw.trim().to_string();
    if key.is_empty() || key.len() > 256 || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::new(
            "places_key_invalid",
            "That does not look like a Google Places API key.",
        ));
    }
    Ok(key)
}

#[tauri::command]
pub async fn places_get_settings() -> Result<PlacesSettingsDto, AppError> {
    tokio::task::spawn_blocking(dto)
        .await
        .map_err(|error| AppError::new("places_keychain", error.to_string()))
}

#[tauri::command]
pub async fn places_set_google_key(
    request: SetGoogleKeyRequest,
) -> Result<PlacesSettingsDto, AppError> {
    let key = normalize_key(&request.api_key)?;
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .and_then(|entry| entry.set_password(&key))
    })
    .await
    .map_err(|error| AppError::new("places_keychain", error.to_string()))?
    .map_err(|error| AppError::new("places_keychain", error.to_string()))?;
    Ok(PlacesSettingsDto {
        google_key_present: true,
    })
}

#[tauri::command]
pub async fn places_clear_google_key() -> Result<PlacesSettingsDto, AppError> {
    tokio::task::spawn_blocking(|| {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            // Absent entry is not an error — clearing an unset key is a no-op.
            let _ = entry.delete_credential();
        }
    })
    .await
    .map_err(|error| AppError::new("places_keychain", error.to_string()))?;
    Ok(PlacesSettingsDto {
        google_key_present: false,
    })
}

// --- Photos -----------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacePhotoRequest {
    /// Opaque Google reference: `places/<id>/photos/<id>`.
    pub photo_ref: String,
    /// Logical pixels; fetched at 2x for retina.
    pub max_width: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacePhotoResponse {
    pub data_url: String,
}

fn valid_photo_ref(photo_ref: &str) -> bool {
    photo_ref.len() <= MAX_PHOTO_REF_LEN
        && photo_ref.starts_with("places/")
        && photo_ref.contains("/photos/")
        && photo_ref
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-'))
}

fn photo_cache_path(app: &AppHandle, photo_ref: &str, width: u32) -> Option<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (photo_ref, width).hash(&mut hasher);
    let dir = app.path().app_data_dir().ok()?;
    Some(
        dir.join("places-photos")
            .join(format!("{:016x}.txt", hasher.finish())),
    )
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

#[tauri::command]
pub async fn places_photo_data_url(
    app: AppHandle,
    request: PlacePhotoRequest,
) -> Result<PlacePhotoResponse, AppError> {
    if !valid_photo_ref(&request.photo_ref) {
        return Err(AppError::new(
            "places_photo_rejected",
            "That photo reference is not usable.",
        ));
    }
    let width = request
        .max_width
        .unwrap_or(PHOTO_MAX_WIDTH_DEFAULT)
        .clamp(32, PHOTO_MAX_WIDTH_CAP)
        * 2;
    let cache_path = photo_cache_path(&app, &request.photo_ref, width);
    if let Some(path) = &cache_path {
        if let Ok(cached) = tokio::fs::read_to_string(path).await {
            if cached.starts_with("data:") {
                return Ok(PlacePhotoResponse { data_url: cached });
            }
        }
    }
    let Some(key) = google_places_key_async().await else {
        return Err(AppError::new(
            "places_key_missing",
            "No Google Places key is configured.",
        ));
    };
    let url = format!(
        "{PHOTO_BASE_URL}/{}/media?maxWidthPx={width}",
        request.photo_ref
    );
    let response = http_client()
        .get(&url)
        .header("X-Goog-Api-Key", key)
        .send()
        .await
        .map_err(|error| AppError::new("places_photo_failed", error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "places_photo_failed",
            format!("photo answered {}", response.status()),
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    if !content_type.starts_with("image/") {
        return Err(AppError::new(
            "places_photo_failed",
            "The photo endpoint did not answer with an image.",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::new("places_photo_failed", error.to_string()))?;
    if bytes.len() > MAX_PHOTO_BYTES {
        return Err(AppError::new(
            "places_photo_failed",
            "The photo is unexpectedly large.",
        ));
    }
    use base64::Engine;
    let data_url = format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    if let Some(path) = cache_path {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&path, &data_url).await;
    }
    Ok(PlacePhotoResponse { data_url })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_normalized_and_garbage_is_refused() {
        assert_eq!(
            normalize_key("  AIzaExample123  ").unwrap(),
            "AIzaExample123"
        );
        assert!(normalize_key("").is_err());
        assert!(normalize_key("with space").is_err());
        assert!(normalize_key(&"a".repeat(400)).is_err());
    }

    #[test]
    fn photo_refs_are_shape_checked() {
        assert!(valid_photo_ref("places/abc-123/photos/def_456"));
        assert!(!valid_photo_ref("photos/def"));
        assert!(!valid_photo_ref("places/abc/photos/../../etc"));
        assert!(!valid_photo_ref(&format!(
            "places/a/photos/{}",
            "x".repeat(600)
        )));
    }
}
