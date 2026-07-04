//! Carpe Diem media proxy — the fork-only IPC surface behind the Studio views
//! (image, video, music, workflows).
//!
//! The webview never sees the API key: every upstream call goes through these
//! commands, which read the key from the OS keychain ([`super::settings`]) and
//! forward the request to the configured backend (Carpe Diem for `cdm_` keys,
//! Venice direct otherwise — both expose the same Venice-shaped media surface).
//!
//! Three groups of commands:
//! - [`carpe_diem_media_request`] — a generic JSON proxy restricted to an
//!   allowlist of media paths (`/image/*`, `/video/*`, `/audio/*`, catalogs).
//!   Binary responses (TTS audio, edited images) come back base64-encoded.
//! - [`carpe_diem_media_catalog`] — the merged model catalog. Carpe Diem's
//!   `/v1/models` is authoritative for availability, tier, and voices, but has
//!   no per-model generation constraints; those (aspect ratios, durations,
//!   resolutions, steps, prompt limits) are enriched from Venice's public
//!   catalog, which shares the exact same model ids. Per-model flat prices in
//!   credits come from Carpe Diem's public `/pricing`.
//! - `carpe_diem_media_*_artifact` — the on-disk gallery under
//!   `$APPDATA/studio-media/`, so generations survive restarts without
//!   stuffing base64 blobs into localStorage.

use crate::domain::types::AppError;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::OnceLock, time::Duration};
use tauri::{AppHandle, Manager};

use super::settings;

/// Media generations can be slow (sync image endpoints run up to the ~60 s
/// edge cap; queue polls are fast). One generous timeout for the whole proxy.
const MEDIA_HTTP_TIMEOUT: Duration = Duration::from_secs(300);
/// Downloads (video files) can be large; give them longer.
const DOWNLOAD_HTTP_TIMEOUT: Duration = Duration::from_secs(600);
/// Venice's public catalog carries `model_spec.constraints` for media models.
/// It is fetched without auth and only used to enrich the Carpe Diem catalog.
const VENICE_PUBLIC_CATALOG_URL: &str = "https://api.venice.ai/api/v1/models?type=all";
/// On-disk gallery directory, inside the app data dir.
const ARTIFACTS_DIR: &str = "studio-media";

static MEDIA_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DOWNLOAD_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

// --- generic proxy ----------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRequestDto {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResponseDto {
    pub status: u16,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

#[tauri::command]
pub async fn carpe_diem_media_request(
    request: MediaRequestDto,
) -> Result<MediaResponseDto, AppError> {
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => {
            return Err(AppError::new(
                "media_method_not_allowed",
                format!("Method {other} is not allowed on the media proxy."),
            ));
        }
    };
    if !path_allowed(&method, &request.path) {
        return Err(AppError::new(
            "media_path_not_allowed",
            format!("Path {} is not allowed on the media proxy.", request.path),
        ));
    }
    let Some(key) = settings::api_key() else {
        return Err(AppError::new(
            "media_no_api_key",
            "No API key is stored yet.",
        ));
    };
    let url = format!("{}{}", settings::base_url(), request.path);
    let mut builder = media_http_client().request(method, &url).bearer_auth(&key);
    if let Some(body) = &request.body {
        builder = builder.json(body);
    }
    let response = builder.send().await.map_err(|error| {
        AppError::new(
            "media_request_failed",
            if error.is_timeout() {
                format!("The media request to {} timed out.", request.path)
            } else {
                format!("Couldn't reach the media backend: {error}")
            },
        )
    })?;
    map_response(response).await
}

/// Whether the proxy forwards `method path`. Only media-family paths are
/// reachable — key management, provider provisioning, and account endpoints
/// stay off-limits by construction.
fn path_allowed(method: &reqwest::Method, path: &str) -> bool {
    if !path.starts_with('/') || path.len() > 256 {
        return false;
    }
    if path.contains("..")
        || path
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '?' || c == '#')
    {
        return false;
    }
    match *method {
        reqwest::Method::GET => matches!(path, "/models" | "/image/styles"),
        reqwest::Method::POST => {
            // `/chat/completions` powers the workflow chat node (non-streamed,
            // JSON only). Everyday agent chat still goes through the sidecar.
            path == "/chat/completions"
                || path.starts_with("/image/")
                || path.starts_with("/video/")
                || path.starts_with("/audio/")
        }
        _ => false,
    }
}

async fn map_response(response: reqwest::Response) -> Result<MediaResponseDto, AppError> {
    let status = response.status();
    let retry_after_ms = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.saturating_mul(1_000));
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let bytes = response.bytes().await.map_err(|error| {
        AppError::new(
            "media_request_failed",
            format!("Reading the response failed: {error}"),
        )
    })?;
    let is_json = content_type
        .as_deref()
        .map(|value| value.contains("json"))
        .unwrap_or(false);
    // Error bodies are JSON even on binary endpoints; success bodies on binary
    // endpoints (TTS, image edit) are raw bytes.
    let json = if is_json || !status.is_success() {
        serde_json::from_slice::<serde_json::Value>(&bytes).ok()
    } else {
        None
    };
    let body_base64 = if json.is_none() {
        Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
    } else {
        None
    };
    Ok(MediaResponseDto {
        status: status.as_u16(),
        ok: status.is_success(),
        json,
        body_base64,
        content_type,
        retry_after_ms,
    })
}

// --- merged model catalog ---------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaModelDto {
    pub id: String,
    /// `image | imageEdit | video | imageToVideo | music | tts | upscale |
    /// text | asr | embedding | other` — Carpe Diem's `carpe_diem_type`
    /// vocabulary, derived from Venice's `type` + constraints when the stored
    /// key talks to Venice directly.
    pub media_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
    pub offline: bool,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub voices: Vec<String>,
    /// Venice `model_spec.constraints`, verbatim (aspect ratios, durations,
    /// resolutions, steps, prompt limits...). Absent when Venice doesn't
    /// publish constraints for the model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub model_sets: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub traits: Vec<String>,
    /// Venice `model_spec.pricing`, verbatim (per-generation USD, per-duration
    /// brackets for music...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<serde_json::Value>,
    /// Flat per-generation price in credits, when the backend publishes one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_credits: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCatalogDto {
    /// `carpe-diem` or `venice`, by stored key prefix.
    pub backend: String,
    /// Today's global price multiplier (fraction of the upstream Venice rate);
    /// 1.0 on the Venice-direct path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_multiplier: Option<f64>,
    pub models: Vec<MediaModelDto>,
}

#[tauri::command]
pub async fn carpe_diem_media_catalog() -> Result<MediaCatalogDto, AppError> {
    let Some(key) = settings::api_key() else {
        return Err(AppError::new(
            "media_no_api_key",
            "No API key is stored yet.",
        ));
    };
    let base = settings::base_url();
    let client = media_http_client();

    if key.starts_with("cdm_") {
        let operator_root = base.strip_suffix("/v1").unwrap_or(&base).to_string();
        let models_url = format!("{base}/models");
        let pricing_url = format!("{operator_root}/pricing");
        let (primary, venice, pricing) = tokio::join!(
            fetch_json(client, &models_url, Some(&key)),
            fetch_json(client, VENICE_PUBLIC_CATALOG_URL, None),
            fetch_json(client, &pricing_url, None),
        );
        let primary = primary?;
        // Enrichment sources are best-effort: without Venice constraints the
        // studio still works with free-form params, and without pricing it
        // just hides cost estimates.
        let venice = venice.ok();
        let pricing = pricing.ok();
        Ok(MediaCatalogDto {
            backend: "carpe-diem".to_string(),
            price_multiplier: pricing.as_ref().and_then(pricing_multiplier),
            models: merge_carpe_diem_catalog(&primary, venice.as_ref(), pricing.as_ref()),
        })
    } else {
        let catalog = fetch_json(client, &format!("{base}/models?type=all"), Some(&key)).await?;
        Ok(MediaCatalogDto {
            backend: "venice".to_string(),
            price_multiplier: Some(1.0),
            models: venice_catalog_models(&catalog),
        })
    }
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    bearer: Option<&str>,
) -> Result<serde_json::Value, AppError> {
    let mut builder = client.get(url);
    if let Some(bearer) = bearer {
        builder = builder.bearer_auth(bearer);
    }
    builder
        .send()
        .await
        .map_err(|error| AppError::new("media_catalog_unreachable", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("media_catalog_failed", error.to_string()))?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| AppError::new("media_catalog_failed", error.to_string()))
}

/// Carpe Diem's flat `/v1/models` entries, enriched with Venice `model_spec`
/// (matched by identical model id) and Carpe Diem `fixedCost` credit prices.
fn merge_carpe_diem_catalog(
    primary: &serde_json::Value,
    venice: Option<&serde_json::Value>,
    pricing: Option<&serde_json::Value>,
) -> Vec<MediaModelDto> {
    let specs = venice.map(venice_specs_by_id).unwrap_or_default();
    let costs = pricing.map(fixed_costs_by_id).unwrap_or_default();
    entries(primary)
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_string();
            let spec = specs.get(id.as_str()).copied();
            let media_type = entry
                .get("carpe_diem_type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("other")
                .to_string();
            Some(MediaModelDto {
                name: spec
                    .and_then(|spec| spec.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| id.clone()),
                tier: string_field(entry, "tier"),
                privacy: string_field(entry, "privacy"),
                offline: false,
                voices: string_list(entry.get("voices")),
                constraints: spec
                    .and_then(|spec| spec.get("constraints"))
                    .filter(|value| !value.is_null())
                    .cloned(),
                model_sets: string_list(spec.and_then(|spec| spec.get("model_sets"))),
                traits: string_list(spec.and_then(|spec| spec.get("traits"))),
                pricing: spec
                    .and_then(|spec| spec.get("pricing"))
                    .filter(|value| !value.is_null())
                    .cloned(),
                cost_credits: costs.get(id.as_str()).copied(),
                id,
                media_type,
            })
        })
        .collect()
}

/// Venice's `/models?type=all` entries mapped straight to the DTO (the
/// Venice-direct key path). Prices convert at 1 credit = $0.01.
fn venice_catalog_models(catalog: &serde_json::Value) -> Vec<MediaModelDto> {
    entries(catalog)
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_string();
            let spec = entry.get("model_spec");
            let constraints = spec
                .and_then(|spec| spec.get("constraints"))
                .filter(|value| !value.is_null());
            let pricing = spec
                .and_then(|spec| spec.get("pricing"))
                .filter(|value| !value.is_null());
            Some(MediaModelDto {
                media_type: venice_media_type(entry, constraints),
                name: spec
                    .and_then(|spec| spec.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| id.clone()),
                tier: None,
                privacy: None,
                offline: spec
                    .and_then(|spec| spec.get("offline"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                voices: string_list(
                    spec.and_then(|spec| spec.get("voices"))
                        .or_else(|| entry.get("voices")),
                ),
                model_sets: string_list(spec.and_then(|spec| spec.get("model_sets"))),
                traits: string_list(spec.and_then(|spec| spec.get("traits"))),
                cost_credits: pricing.and_then(flat_generation_usd).map(|usd| usd * 100.0),
                constraints: constraints.cloned(),
                pricing: pricing.cloned(),
                id,
            })
        })
        .collect()
}

/// Venice `type` → Carpe Diem type vocabulary. Video models split into
/// text-to-video and image-to-video by their constraints.
fn venice_media_type(entry: &serde_json::Value, constraints: Option<&serde_json::Value>) -> String {
    let venice_type = entry
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("other");
    match venice_type {
        "inpaint" => "imageEdit".to_string(),
        "video" => {
            let model_type = constraints
                .and_then(|value| value.get("model_type"))
                .and_then(serde_json::Value::as_str);
            if model_type == Some("image-to-video") {
                "imageToVideo".to_string()
            } else {
                "video".to_string()
            }
        }
        other => other.to_string(),
    }
}

fn entries(catalog: &serde_json::Value) -> Vec<&serde_json::Value> {
    catalog
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|models| models.iter().collect())
        .unwrap_or_default()
}

fn venice_specs_by_id(catalog: &serde_json::Value) -> HashMap<&str, &serde_json::Value> {
    entries(catalog)
        .iter()
        .filter_map(|entry| {
            Some((
                entry.get("id")?.as_str()?,
                entry.get("model_spec").filter(|value| !value.is_null())?,
            ))
        })
        .collect()
}

/// Flat per-generation credit prices from Carpe Diem's `/pricing` `fixedCost`
/// section (media models only; text models bill per token).
fn fixed_costs_by_id(pricing: &serde_json::Value) -> HashMap<String, f64> {
    pricing
        .get("fixedCost")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some((
                entry.get("model")?.as_str()?.to_string(),
                entry.get("costCredits")?.as_f64()?,
            ))
        })
        .collect()
}

fn pricing_multiplier(pricing: &serde_json::Value) -> Option<f64> {
    ["fixedCost", "models"].iter().find_map(|section| {
        pricing
            .get(section)?
            .as_array()?
            .iter()
            .find_map(|entry| entry.get("multiplier").and_then(serde_json::Value::as_f64))
    })
}

fn flat_generation_usd(pricing: &serde_json::Value) -> Option<f64> {
    pricing
        .get("generation")
        .and_then(|generation| generation.get("usd"))
        .and_then(serde_json::Value::as_f64)
}

fn string_field(entry: &serde_json::Value, field: &str) -> Option<String> {
    entry
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect()
}

// --- on-disk artifact gallery -----------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArtifactRequest {
    pub base64: String,
    pub extension: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchArtifactRequest {
    pub url: String,
    pub extension: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArtifactRequest {
    pub path: String,
    pub destination: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArtifactRequest {
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDto {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
}

/// Persists a base64 payload (a generated image, TTS audio...) into the
/// gallery directory and returns its absolute path for `convertFileSrc`.
#[tauri::command]
pub async fn carpe_diem_media_save_artifact(
    app: AppHandle,
    request: SaveArtifactRequest,
) -> Result<ArtifactDto, AppError> {
    let extension = validate_extension(&request.extension)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.base64.as_bytes())
        .map_err(|error| AppError::new("media_artifact_invalid", error.to_string()))?;
    if bytes.is_empty() {
        return Err(AppError::new(
            "media_artifact_invalid",
            "The artifact is empty.",
        ));
    }
    let dir = artifacts_dir(&app)?;
    let file_name = format!("{}.{extension}", uuid::Uuid::new_v4());
    let path = dir.join(&file_name);
    let byte_count = bytes.len() as u64;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| AppError::new("media_artifact_write_failed", error.to_string()))?;
    Ok(ArtifactDto {
        path: path.to_string_lossy().to_string(),
        file_name,
        bytes: byte_count,
    })
}

/// Downloads a generated file (video, music) into the gallery. Relative URLs
/// resolve against the backend per Carpe Diem's join rule: absolute paths join
/// the origin, bare paths join the operator root (the base URL minus `/v1`).
#[tauri::command]
pub async fn carpe_diem_media_fetch_artifact(
    app: AppHandle,
    request: FetchArtifactRequest,
) -> Result<ArtifactDto, AppError> {
    let extension = validate_extension(&request.extension)?;
    let base = settings::base_url();
    let url = resolve_media_url(&base, &request.url);
    let mut builder = download_http_client().get(&url);
    // Only attach the key to the backend's own host — a signed CDN URL on
    // another host must not receive it.
    if let (Some(key), true) = (settings::api_key(), same_host(&base, &url)) {
        builder = builder.bearer_auth(key);
    }
    let mut response = builder
        .send()
        .await
        .map_err(|error| AppError::new("media_download_failed", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("media_download_failed", error.to_string()))?;

    let dir = artifacts_dir(&app)?;
    let file_name = format!("{}.{extension}", uuid::Uuid::new_v4());
    let path = dir.join(&file_name);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|error| AppError::new("media_artifact_write_failed", error.to_string()))?;
    let mut byte_count: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| AppError::new("media_download_failed", error.to_string()))?
    {
        byte_count += chunk.len() as u64;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| AppError::new("media_artifact_write_failed", error.to_string()))?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|error| AppError::new("media_artifact_write_failed", error.to_string()))?;
    if byte_count == 0 {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(AppError::new(
            "media_download_failed",
            "The downloaded file is empty.",
        ));
    }
    Ok(ArtifactDto {
        path: path.to_string_lossy().to_string(),
        file_name,
        bytes: byte_count,
    })
}

/// Copies a gallery artifact to a destination the user picked in a save
/// dialog. The source must live inside the gallery directory.
#[tauri::command]
pub async fn carpe_diem_media_export_artifact(
    app: AppHandle,
    request: ExportArtifactRequest,
) -> Result<(), AppError> {
    let dir = artifacts_dir(&app)?;
    let source = PathBuf::from(&request.path);
    if !is_within(&dir, &source) {
        return Err(AppError::new(
            "media_artifact_invalid",
            "Only gallery files can be exported.",
        ));
    }
    let destination = PathBuf::from(&request.destination);
    if !destination.is_absolute() {
        return Err(AppError::new(
            "media_artifact_invalid",
            "The export destination must be an absolute path.",
        ));
    }
    tokio::fs::copy(&source, &destination)
        .await
        .map_err(|error| AppError::new("media_artifact_export_failed", error.to_string()))?;
    Ok(())
}

/// Removes a gallery artifact. Deleting a file that is already gone is a
/// no-op, so the frontend can prune its index without racing the disk.
#[tauri::command]
pub async fn carpe_diem_media_delete_artifact(
    app: AppHandle,
    request: DeleteArtifactRequest,
) -> Result<(), AppError> {
    let dir = artifacts_dir(&app)?;
    let path = PathBuf::from(&request.path);
    if !is_within(&dir, &path) {
        return Err(AppError::new(
            "media_artifact_invalid",
            "Only gallery files can be deleted.",
        ));
    }
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::new(
            "media_artifact_delete_failed",
            error.to_string(),
        )),
    }
}

/// Reads a gallery artifact back as base64, so a generated image can feed the
/// edit/upscale endpoints (the webview can't read arbitrary files itself).
#[tauri::command]
pub async fn carpe_diem_media_read_artifact(
    app: AppHandle,
    request: DeleteArtifactRequest,
) -> Result<String, AppError> {
    let dir = artifacts_dir(&app)?;
    let path = PathBuf::from(&request.path);
    if !is_within(&dir, &path) {
        return Err(AppError::new(
            "media_artifact_invalid",
            "Only gallery files can be read.",
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| AppError::new("media_artifact_read_failed", error.to_string()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Lists gallery files (name, path, size, mtime ms) so the frontend can
/// reconcile its localStorage index with what actually survived on disk.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListEntryDto {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    pub modified_ms: Option<u64>,
}

#[tauri::command]
pub async fn carpe_diem_media_list_artifacts(
    app: AppHandle,
) -> Result<Vec<ArtifactListEntryDto>, AppError> {
    let dir = artifacts_dir(&app)?;
    let mut entries = Vec::new();
    let mut read_dir = match tokio::fs::read_dir(&dir).await {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(error) => {
            return Err(AppError::new(
                "media_artifact_list_failed",
                error.to_string(),
            ));
        }
    };
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        entries.push(ArtifactListEntryDto {
            path: entry.path().to_string_lossy().to_string(),
            file_name: entry.file_name().to_string_lossy().to_string(),
            bytes: metadata.len(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64),
        });
    }
    Ok(entries)
}

// --- internals ---------------------------------------------------------------

fn artifacts_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("media_artifact_dir_failed", error.to_string()))?
        .join(ARTIFACTS_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::new("media_artifact_dir_failed", error.to_string()))?;
    Ok(dir)
}

/// Containment check without touching the filesystem: normalized component
/// prefixes. Gallery file names are generated UUIDs, so symlink tricks inside
/// the directory are not a concern; rejecting `..` keeps traversal out.
fn is_within(dir: &std::path::Path, path: &std::path::Path) -> bool {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return false;
    }
    path.starts_with(dir)
}

fn validate_extension(raw: &str) -> Result<String, AppError> {
    let value = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    let valid = (1..=5).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric());
    if !valid {
        return Err(AppError::new(
            "media_artifact_invalid",
            "That file extension is not valid.",
        ));
    }
    Ok(value)
}

/// Resolves the `video_url`/`audio_url` a retrieve response returns. Absolute
/// URLs pass through; absolute paths join the backend origin; bare paths join
/// the operator root (Carpe Diem's join rule: files live under `/api/operator`,
/// not under `/api/operator/v1`).
fn resolve_media_url(base_url: &str, raw: &str) -> String {
    let raw = raw.trim();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_string();
    }
    let base = base_url.trim_end_matches('/');
    if let Some(path) = raw.strip_prefix('/') {
        return format!("{}/{path}", origin(base));
    }
    let operator_root = base.strip_suffix("/v1").unwrap_or(base);
    format!("{operator_root}/{raw}")
}

/// `scheme://host[:port]` of a URL, without any path.
fn origin(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let after_scheme = &url[scheme_end + 3..];
    match after_scheme.find('/') {
        Some(path_start) => url[..scheme_end + 3 + path_start].to_string(),
        None => url.to_string(),
    }
}

fn same_host(base_url: &str, url: &str) -> bool {
    host_of(base_url)
        .zip(host_of(url))
        .map(|(a, b)| a == b)
        .unwrap_or(false)
}

fn host_of(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    let host_port = after_scheme.split('/').next()?;
    let host = host_port.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn media_http_client() -> &'static reqwest::Client {
    MEDIA_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(MEDIA_HTTP_TIMEOUT)
            .user_agent("sub-rosa-studio/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn download_http_client() -> &'static reqwest::Client {
    DOWNLOAD_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(DOWNLOAD_HTTP_TIMEOUT)
            .user_agent("sub-rosa-studio/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allowlist_admits_media_paths_only() {
        let get = reqwest::Method::GET;
        let post = reqwest::Method::POST;
        assert!(path_allowed(&get, "/models"));
        assert!(path_allowed(&get, "/image/styles"));
        assert!(!path_allowed(&get, "/credits"));
        assert!(!path_allowed(&get, "/image/generate"));

        assert!(path_allowed(&post, "/image/generate"));
        assert!(path_allowed(&post, "/image/generate/queue"));
        assert!(path_allowed(&post, "/image/edit"));
        assert!(path_allowed(&post, "/image/upscale"));
        assert!(path_allowed(&post, "/video/queue"));
        assert!(path_allowed(&post, "/video/retrieve"));
        assert!(path_allowed(&post, "/video/quote"));
        assert!(path_allowed(&post, "/audio/queue"));
        assert!(path_allowed(&post, "/audio/speech"));

        assert!(path_allowed(&post, "/chat/completions"));
        assert!(!path_allowed(&post, "/api_keys"));
        assert!(!path_allowed(&post, "/chat/completions/extra"));
        assert!(!path_allowed(&post, "/models"));
        assert!(!path_allowed(&post, "image/generate"), "must start with /");
        assert!(!path_allowed(&post, "/image/../api_keys"));
        assert!(!path_allowed(&post, "/image/generate?x=1"));
        assert!(!path_allowed(&post, "/image/gen erate"));
        assert!(!path_allowed(&reqwest::Method::DELETE, "/image/generate"));
    }

    #[test]
    fn resolve_media_url_applies_the_operator_join_rule() {
        let base = "https://carpe-diem.xyz/api/operator/v1";
        // Absolute URLs pass through untouched.
        assert_eq!(
            resolve_media_url(base, "https://cdn.example.com/file.mp4"),
            "https://cdn.example.com/file.mp4"
        );
        // Absolute paths join the origin.
        assert_eq!(
            resolve_media_url(base, "/api/operator/files/abc.mp4"),
            "https://carpe-diem.xyz/api/operator/files/abc.mp4"
        );
        // Bare paths join the operator root, not the /v1 API root.
        assert_eq!(
            resolve_media_url(base, "files/abc.mp4"),
            "https://carpe-diem.xyz/api/operator/files/abc.mp4"
        );
    }

    #[test]
    fn same_host_gates_the_bearer_token() {
        let base = "https://carpe-diem.xyz/api/operator/v1";
        assert!(same_host(
            base,
            "https://carpe-diem.xyz/api/operator/files/a.mp4"
        ));
        // Ports are ignored on purpose: the host is what decides key custody.
        assert!(same_host(base, "https://carpe-diem.xyz:443/files/a.mp4"));
        assert!(!same_host(base, "https://cdn.example.com/a.mp4"));
    }

    #[test]
    fn merge_uses_carpe_diem_availability_and_venice_constraints() {
        let primary = json!({ "data": [
            {
                "id": "kling-2.5-turbo-pro-text-to-video",
                "carpe_diem_type": "video",
                "tier": "premium",
                "privacy": "anonymized"
            },
            {
                "id": "elevenlabs-tts-multilingual-v2",
                "carpe_diem_type": "tts",
                "tier": "frontier",
                "voices": ["Aria", "Roger"]
            },
            { "id": "cd-only-model", "carpe_diem_type": "image" }
        ]});
        let venice = json!({ "data": [
            {
                "id": "kling-2.5-turbo-pro-text-to-video",
                "type": "video",
                "model_spec": {
                    "name": "Kling 2.5 Turbo Pro",
                    "constraints": {
                        "model_type": "text-to-video",
                        "durations": ["5s", "10s"],
                        "aspect_ratios": ["16:9"]
                    },
                    "model_sets": ["cinematic"]
                }
            },
            { "id": "venice-only-model", "type": "image", "model_spec": {} }
        ]});
        let pricing = json!({ "fixedCost": [
            {
                "model": "kling-2.5-turbo-pro-text-to-video",
                "type": "video",
                "costUsd": 0.35,
                "costCredits": 35.0,
                "multiplier": 0.15
            }
        ]});

        let models = merge_carpe_diem_catalog(&primary, Some(&venice), Some(&pricing));

        // Only models available on Carpe Diem appear.
        assert_eq!(models.len(), 3);
        assert!(models.iter().all(|model| model.id != "venice-only-model"));

        let kling = models
            .iter()
            .find(|model| model.id == "kling-2.5-turbo-pro-text-to-video")
            .expect("kling present");
        assert_eq!(kling.name, "Kling 2.5 Turbo Pro");
        assert_eq!(kling.media_type, "video");
        assert_eq!(kling.tier.as_deref(), Some("premium"));
        assert_eq!(kling.model_sets, vec!["cinematic"]);
        assert_eq!(kling.cost_credits, Some(35.0));
        assert_eq!(
            kling
                .constraints
                .as_ref()
                .and_then(|value| value.get("durations"))
                .and_then(|value| value.as_array())
                .map(|value| value.len()),
            Some(2)
        );

        let tts = models
            .iter()
            .find(|model| model.id == "elevenlabs-tts-multilingual-v2")
            .expect("tts present");
        assert_eq!(tts.voices, vec!["Aria", "Roger"]);
        // No Venice spec for this one in the fixture: the id is the name.
        assert_eq!(tts.name, "elevenlabs-tts-multilingual-v2");

        let unmatched = models
            .iter()
            .find(|model| model.id == "cd-only-model")
            .expect("cd-only present");
        assert!(unmatched.constraints.is_none());
        assert!(unmatched.cost_credits.is_none());
    }

    #[test]
    fn merge_survives_missing_enrichment_sources() {
        let primary = json!({ "data": [
            { "id": "seedream-v4", "carpe_diem_type": "image", "tier": "standard" }
        ]});
        let models = merge_carpe_diem_catalog(&primary, None, None);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].media_type, "image");
        assert!(models[0].constraints.is_none());
    }

    #[test]
    fn venice_models_split_video_by_constraint_model_type() {
        let catalog = json!({ "data": [
            {
                "id": "kling-i2v",
                "type": "video",
                "model_spec": {
                    "constraints": { "model_type": "image-to-video" },
                    "pricing": { "generation": { "usd": 0.25 } }
                }
            },
            {
                "id": "kling-t2v",
                "type": "video",
                "model_spec": { "constraints": { "model_type": "text-to-video" } }
            },
            { "id": "flux-dev-inpaint", "type": "inpaint", "model_spec": {} },
            { "id": "offline-model", "type": "image", "model_spec": { "offline": true } }
        ]});

        let models = venice_catalog_models(&catalog);

        assert_eq!(models[0].media_type, "imageToVideo");
        assert_eq!(models[0].cost_credits, Some(25.0));
        assert_eq!(models[1].media_type, "video");
        assert_eq!(models[2].media_type, "imageEdit");
        assert!(models[3].offline);
    }

    #[test]
    fn extension_validation_normalizes_and_rejects() {
        assert_eq!(validate_extension(" .PNG ").unwrap(), "png");
        assert_eq!(validate_extension("mp4").unwrap(), "mp4");
        assert!(validate_extension("").is_err());
        assert!(validate_extension("toolong").is_err());
        assert!(validate_extension("m p4").is_err());
        assert!(validate_extension("../x").is_err());
    }

    #[test]
    fn containment_rejects_traversal_and_outside_paths() {
        let dir = PathBuf::from("/data/studio-media");
        assert!(is_within(&dir, &dir.join("a.png")));
        assert!(!is_within(&dir, &PathBuf::from("/data/other/a.png")));
        assert!(!is_within(&dir, &dir.join("../secrets.json")));
    }

    #[test]
    fn pricing_multiplier_prefers_fixed_cost() {
        let pricing = json!({
            "models": [{ "model": "text", "multiplier": 0.2 }],
            "fixedCost": [{ "model": "img", "multiplier": 0.15 }]
        });
        assert_eq!(pricing_multiplier(&pricing), Some(0.15));
        assert_eq!(pricing_multiplier(&json!({})), None);
    }
}
