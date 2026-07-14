//! Film-project commands (ADR-0010): create, run, monitor, export, delete.
//!
//! The autonomous path (phase 2): create a project with a hard DIEM ceiling,
//! hand the brief to a one-shot run (`POST /runs` drives concept → bible →
//! assets → shotlist → storyboard → enqueue → produce), watch it over SSE,
//! and download the final cut into the artifacts gallery. Money moves only
//! through typed commands — the produce handshake echoes Videomaker's quoted
//! figure, and every costly POST carries an idempotency key (see `client`).

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

use super::client::{send, Request};

const DOWNLOAD_CHUNK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub title: String,
    pub aspect_ratio: Option<String>,
    pub target_duration_seconds: Option<u32>,
    pub autonomous: bool,
    pub budget_ceiling_diem: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub slug: String,
    pub brief: String,
    /// `None` stops the run at the production quote (`awaiting_confirmation`);
    /// the user then confirms through [`videomaker_produce`].
    pub max_cost_diem: Option<f64>,
    pub produce: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmArtifactDto {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
}

/// `GET /projects` — every film project on this install's Videomaker account.
#[tauri::command]
pub async fn videomaker_list_projects(app: AppHandle) -> Result<Value, AppError> {
    send(&app, Request::get("/projects")).await
}

/// Create a film project and start watching it. Autonomy is never unbounded:
/// Videomaker refuses `autonomous` without a positive ceiling, and so do we —
/// before any network call, with an actionable message.
#[tauri::command]
pub async fn videomaker_create_project(
    app: AppHandle,
    request: CreateProjectRequest,
) -> Result<Value, AppError> {
    let title = request.title.trim();
    if title.is_empty() {
        return Err(AppError::new(
            "videomaker_invalid",
            "Give the film a title.",
        ));
    }
    if request.autonomous && !request.budget_ceiling_diem.is_some_and(|cap| cap > 0.0) {
        return Err(AppError::new(
            "videomaker_invalid",
            "Autonomous production needs a positive DIEM budget ceiling.",
        ));
    }
    let mut body = json!({ "title": title, "autonomous": request.autonomous });
    if let Some(ratio) = &request.aspect_ratio {
        body["aspect_ratio"] = json!(ratio);
    }
    if let Some(seconds) = request.target_duration_seconds {
        body["target_duration_seconds"] = json!(seconds);
    }
    if let Some(ceiling) = request.budget_ceiling_diem {
        body["budget_ceiling_diem"] = json!(ceiling);
    }
    let created = send(&app, Request::costly_post("/projects", body)).await?;
    if let Some(slug) = created
        .get("project")
        .and_then(|project| project.get("slug"))
        .and_then(Value::as_str)
    {
        watch_slug(&app, slug)?;
    }
    Ok(created)
}

/// Permanent server-side delete (kills the daemon, purges files) + local
/// cleanup (watcher, persisted slug, exported marker — the downloaded film
/// stays in the gallery, it belongs to the user).
#[tauri::command]
pub async fn videomaker_delete_project(app: AppHandle, slug: String) -> Result<(), AppError> {
    let result = send(&app, Request::delete(format!("/projects/{slug}"))).await;
    match result {
        Ok(_) => {}
        // Already gone server-side (purged / double delete): still clean up.
        Err(error) if error.code == "videomaker_not_found" => {}
        Err(error) => return Err(error),
    }
    super::events::unwatch(&slug);
    super::update_settings(&app, |settings| {
        settings.watched_slugs.retain(|watched| watched != &slug);
        settings.exported_films.remove(&slug);
    })?;
    Ok(())
}

/// `GET /projects/{slug}` — the full display snapshot (concept, bible,
/// shotlist, scenes, spend).
#[tauri::command]
pub async fn videomaker_project_overview(app: AppHandle, slug: String) -> Result<Value, AppError> {
    send(&app, Request::get(format!("/projects/{slug}"))).await
}

/// `GET /projects/{slug}/status` — daemon liveness, queue, cost rollup.
#[tauri::command]
pub async fn videomaker_project_status(app: AppHandle, slug: String) -> Result<Value, AppError> {
    send(&app, Request::get(format!("/projects/{slug}/status"))).await
}

/// Launch (or resume — re-POSTing a paused/interrupted run resumes it) the
/// hands-off "brief → film" driver.
#[tauri::command]
pub async fn videomaker_start_run(
    app: AppHandle,
    request: StartRunRequest,
) -> Result<Value, AppError> {
    let body = json!({
        "brief": request.brief,
        "max_cost_diem": request.max_cost_diem,
        "produce": request.produce,
    });
    let slug = &request.slug;
    let started = send(
        &app,
        Request::costly_post(format!("/projects/{slug}/runs"), body),
    )
    .await?;
    watch_slug(&app, slug)?;
    Ok(started)
}

#[tauri::command]
pub async fn videomaker_list_runs(app: AppHandle, slug: String) -> Result<Value, AppError> {
    send(&app, Request::get(format!("/projects/{slug}/runs"))).await
}

#[tauri::command]
pub async fn videomaker_cancel_run(
    app: AppHandle,
    slug: String,
    run_id: String,
) -> Result<Value, AppError> {
    send(
        &app,
        Request::delete(format!("/projects/{slug}/runs/{run_id}")),
    )
    .await
}

/// The produce cost handshake, flattened for the UI:
/// - `confirmed_cost_diem: None` asks for the quote — Videomaker answers 409
///   (`needs_confirmation`, `projected_cost_diem`, ...) which comes back as a
///   plain `Ok` payload here, because a quote is a flow step, not a failure;
/// - `Some(cost)` echoes the quoted figure to actually start (a stale quote
///   > 2 % off yields a fresh quote payload the same way).
#[tauri::command]
pub async fn videomaker_produce(
    app: AppHandle,
    slug: String,
    confirmed_cost_diem: Option<f64>,
) -> Result<Value, AppError> {
    let body = match confirmed_cost_diem {
        None => json!({ "confirm": false }),
        Some(cost) => json!({ "confirm": true, "confirmed_cost_diem": cost }),
    };
    match send(
        &app,
        Request::costly_post(format!("/projects/{slug}/produce"), body),
    )
    .await
    {
        Ok(started) => Ok(started),
        Err(error) if error.code == "videomaker_confirm" => Ok(error
            .details
            .unwrap_or_else(|| json!({ "needs_confirmation": true }))),
        Err(error) => Err(error),
    }
}

/// Download the finished film into the artifacts gallery (manual trigger —
/// the watcher also calls [`download_export`] automatically on completion).
#[tauri::command]
pub async fn videomaker_export_film(
    app: AppHandle,
    slug: String,
) -> Result<FilmArtifactDto, AppError> {
    download_export(&app, &slug).await
}

#[tauri::command]
pub fn videomaker_watch_project(app: AppHandle, slug: String) -> Result<(), AppError> {
    watch_slug(&app, &slug)
}

#[tauri::command]
pub fn videomaker_unwatch_project(app: AppHandle, slug: String) -> Result<(), AppError> {
    super::events::unwatch(&slug);
    super::update_settings(&app, |settings| {
        settings.watched_slugs.retain(|watched| watched != &slug);
    })?;
    Ok(())
}

// --- shared with the watcher ---------------------------------------------------

/// Persist the slug and start (or keep) its watcher.
fn watch_slug(app: &AppHandle, slug: &str) -> Result<(), AppError> {
    super::update_settings(app, |settings| {
        if !settings.watched_slugs.iter().any(|watched| watched == slug) {
            settings.watched_slugs.push(slug.to_string());
        }
    })?;
    super::events::watch(app, slug);
    Ok(())
}

/// `GET /export` → signed URL → stream into the artifacts gallery → remember
/// the path in `exported_films`. The signed URL needs no bearer; it may be
/// relative to the studio origin.
pub async fn download_export(app: &AppHandle, slug: &str) -> Result<FilmArtifactDto, AppError> {
    if let Some(path) = super::settings_snapshot().exported_films.get(slug) {
        if std::path::Path::new(path).is_file() {
            let file_name = std::path::Path::new(path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            let bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            return Ok(FilmArtifactDto {
                path: path.clone(),
                file_name,
                bytes,
            });
        }
    }
    let export = send(app, Request::get(format!("/projects/{slug}/export"))).await?;
    let url = export
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("videomaker_invalid", "The export response has no URL."))?;
    let url = resolve_url(&super::base_url(), url);

    let mut response = super::client::http_client()
        .get(&url)
        .send()
        .await
        .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?;

    let dir = crate::carpe_diem::media::artifacts_dir(app)?;
    let file_name = format!("{}.mp4", uuid::Uuid::new_v4());
    let path = dir.join(&file_name);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?;
    let mut byte_count: u64 = 0;
    loop {
        let chunk = tokio::time::timeout(DOWNLOAD_CHUNK_TIMEOUT, response.chunk())
            .await
            .map_err(|_| AppError::new("videomaker_download_failed", "The download stalled."))?
            .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?;
        let Some(chunk) = chunk else { break };
        byte_count += chunk.len() as u64;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?;
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?;
    if byte_count == 0 {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(AppError::new(
            "videomaker_download_failed",
            "The downloaded film is empty.",
        ));
    }
    let absolute = path.to_string_lossy().to_string();
    super::update_settings(app, |settings| {
        settings
            .exported_films
            .insert(slug.to_string(), absolute.clone());
    })?;
    Ok(FilmArtifactDto {
        path: absolute,
        file_name,
        bytes: byte_count,
    })
}

/// Decoded-size cap for reference uploads; mirrors the studio's
/// `VIDEOMAKER_MAX_UPLOAD_BYTES` default so oversized picks fail fast and
/// locally instead of burning a 25 MB upload on a guaranteed 413.
const MAX_REF_BYTES: usize = 25 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRefRequest {
    pub slug: String,
    pub file_name: String,
    /// Raw base64 of the image bytes (no `data:` prefix). The studio
    /// MIME-sniffs server-side and only accepts png/jpg/webp.
    pub base64_data: String,
}

/// `POST /projects/{slug}/refs` — upload a reference image the crew anchors
/// characters, locations, or the visual style on. Returns the studio payload
/// (`relative_path`, signed `public_url`, `bytes`).
#[tauri::command]
pub async fn videomaker_upload_ref(
    app: AppHandle,
    request: UploadRefRequest,
) -> Result<Value, AppError> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.base64_data.trim())
        .map_err(|error| {
            AppError::new("videomaker_invalid", format!("Invalid image data: {error}"))
        })?;
    if bytes.is_empty() {
        return Err(AppError::new(
            "videomaker_invalid",
            "The reference image is empty.",
        ));
    }
    if bytes.len() > MAX_REF_BYTES {
        return Err(AppError::new(
            "videomaker_invalid",
            "Reference images must be 25 MB or less.",
        ));
    }
    let mime = sniff_image_mime(&bytes).ok_or_else(|| {
        AppError::new(
            "videomaker_invalid",
            "Reference images must be PNG, JPEG, or WebP.",
        )
    })?;
    super::client::upload(
        &app,
        &format!("/projects/{}/refs", request.slug),
        request.file_name.trim(),
        mime,
        bytes,
    )
    .await
}

/// Magic-byte sniff for the three formats the studio accepts. The server
/// re-sniffs authoritatively; this just refuses obvious junk before upload.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Join a possibly-relative signed URL against the studio origin.
fn resolve_url(base: &str, url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else if let Some(stripped) = url.strip_prefix('/') {
        format!("{base}/{stripped}")
    } else {
        format!("{base}/{url}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_export_urls_against_the_studio_origin() {
        let base = "https://studio.furetier.com";
        assert_eq!(
            resolve_url(base, "/assets/x.mp4?sig=abc"),
            "https://studio.furetier.com/assets/x.mp4?sig=abc"
        );
        assert_eq!(
            resolve_url(base, "assets/x.mp4"),
            "https://studio.furetier.com/assets/x.mp4"
        );
        assert_eq!(
            resolve_url(base, "https://cdn.example/x.mp4"),
            "https://cdn.example/x.mp4"
        );
    }

    #[test]
    fn sniffs_only_the_formats_the_studio_accepts() {
        assert_eq!(
            sniff_image_mime(b"\x89PNG\r\n\x1a\n0000"),
            Some("image/png")
        );
        assert_eq!(sniff_image_mime(b"\xff\xd8\xff\xe000"), Some("image/jpeg"));
        assert_eq!(
            sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image_mime(b"GIF89a000000"), None);
        assert_eq!(sniff_image_mime(b""), None);
    }
}
