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
    /// Which curated model set the film is produced with. Frozen at creation
    /// server-side — there is no way to change it afterwards, so an unknown
    /// value must never reach the studio: it ignores it silently and the film
    /// is born on the default set. See [`validated_model_set`].
    pub model_set: Option<String>,
}

/// The model sets the studio curates. The fork never picks individual models
/// (the studio owns that), it only picks WHICH locked set a film uses:
/// - `full_quality`: the default (a Claude writer, gpt-image frames);
/// - `uncensored`: swaps the writer and the explicit-scene frames for models
///   that don't refuse adult material. Video and audio are the same on both.
const MODEL_SETS: [&str; 2] = ["full_quality", "uncensored"];

/// Fail closed on an unknown set. The studio validates with `in MODEL_SETS`
/// and simply DROPS anything else — a typo would silently produce (and bill) a
/// film on the wrong set, with no way to change it after the fact.
fn validated_model_set(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if MODEL_SETS.contains(&value) {
        return Ok(Some(value.to_string()));
    }
    Err(AppError::new(
        "videomaker_invalid",
        format!(
            "Unknown model set \"{value}\". Pick {}.",
            MODEL_SETS.join(" or ")
        ),
    ))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub slug: String,
    pub brief: String,
    /// `None` stops the run at the production quote (`awaiting_confirmation`);
    /// the user then confirms through [`videomaker_produce`].
    pub max_cost_diem: Option<f64>,
    /// Hard DIEM envelope for the run itself (creative phases: the crew's
    /// reasoners, the asset and storyboard renders). The studio measures the
    /// project's ledger delta since the run started and parks the run at
    /// `awaiting_confirmation` (`reason: run_budget_exhausted`) once it is
    /// spent, instead of walking on. The project ceiling only guards the
    /// production enqueue, so without this a long creative phase can spend
    /// past what the user agreed to. `None` = unbounded run.
    pub budget_diem: Option<f64>,
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
    let model_set = validated_model_set(request.model_set.as_deref())?;
    let mut body = json!({ "title": title, "autonomous": request.autonomous });
    if let Some(set) = model_set {
        body["model_set"] = json!(set);
    }
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBudgetRequest {
    pub slug: String,
    pub ceiling_diem: f64,
}

/// Raise (or set) the hard DIEM spend ceiling on an existing project. The
/// studio's spend guard reads `budget_ceiling_diem` at every enqueue, so a
/// project that has spent up to its cap can't render or reshoot until the
/// ceiling is raised — this is the only in-app way to give it more room.
/// Goes through the studio's settings endpoint (persisted server-side); it
/// moves no money by itself.
#[tauri::command]
pub async fn videomaker_update_budget(
    app: AppHandle,
    request: UpdateBudgetRequest,
) -> Result<Value, AppError> {
    if !request.ceiling_diem.is_finite() || request.ceiling_diem <= 0.0 {
        return Err(AppError::new(
            "videomaker_invalid",
            "The budget ceiling must be greater than zero.",
        ));
    }
    send(
        &app,
        Request::post(
            format!("/projects/{}/model-prefs", request.slug),
            settings_body(json!({ "budget_ceiling_diem": request.ceiling_diem })),
        ),
    )
    .await
}

/// The studio's settings endpoint is the model picker's: `prefs` is REQUIRED
/// (a missing one is a 422, not a no-op), and an empty map means "change no
/// model, only these production settings" — the fork never picks models, the
/// studio's curated set does.
fn settings_body(settings: Value) -> Value {
    json!({ "prefs": {}, "settings": settings })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAutonomousRequest {
    pub slug: String,
    pub autonomous: bool,
    /// Passed through when switching a film TO autonomous — unattended production must keep a hard
    /// DIEM cap (the studio only enforces the ceiling requirement for agent/PAT callers, so we
    /// enforce it here for the human path too). Ignored when switching back to directed.
    pub budget_ceiling_diem: Option<f64>,
}

/// Switch an EXISTING film between directed (you approve each phase) and autonomous
/// (the studio self-approves and runs hands-off). Mirrors the create-time choice, so a
/// directed film you no longer want to babysit can be handed off mid-flight — the studio
/// resumes a gate-paused run on the flip. Autonomy is never unbounded: turning it on
/// requires a positive DIEM ceiling, exactly like creation. Moves no money by itself.
#[tauri::command]
pub async fn videomaker_set_autonomous(
    app: AppHandle,
    request: SetAutonomousRequest,
) -> Result<Value, AppError> {
    if request.autonomous && !request.budget_ceiling_diem.is_some_and(|cap| cap > 0.0) {
        return Err(AppError::new(
            "videomaker_invalid",
            "Autonomous production needs a positive DIEM budget ceiling.",
        ));
    }
    let mut settings = json!({ "autonomous": request.autonomous });
    if let Some(ceiling) = request.budget_ceiling_diem {
        if ceiling > 0.0 {
            settings["budget_ceiling_diem"] = json!(ceiling);
        }
    }
    send(
        &app,
        Request::post(
            format!("/projects/{}/model-prefs", request.slug),
            settings_body(settings),
        ),
    )
    .await
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
/// hands-off "brief → film" driver. A resume passes an empty brief: the driver
/// is state-based and picks the project up at its last saved phase without
/// re-paying for the phases already banked.
#[tauri::command]
pub async fn videomaker_start_run(
    app: AppHandle,
    request: StartRunRequest,
) -> Result<Value, AppError> {
    let mut body = json!({
        "brief": request.brief,
        "max_cost_diem": request.max_cost_diem,
        "produce": request.produce,
    });
    if let Some(envelope) = request.budget_diem {
        if envelope > 0.0 {
            body["budget_diem"] = json!(envelope);
        }
    }
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
        Err(error) if error.code == "videomaker_confirm" => Ok(flatten_quote(error.details)),
        Err(error) => Err(error),
    }
}

/// A studio 409 is `{"detail": {needs_confirmation, projected_cost_diem, ...}}`
/// (FastAPI wraps every `HTTPException` payload under `detail`). Callers — the
/// Films surface and the `june_films` MCP tool — read the quote fields at the
/// top level, so unwrap that envelope here: the wrapper is transport, not
/// domain. Always carries `needs_confirmation` so a caller can branch on the
/// flow without inspecting the status code it never sees.
fn flatten_quote(details: Option<Value>) -> Value {
    let mut quote = match details {
        Some(Value::Object(body)) => match body.get("detail") {
            Some(Value::Object(detail)) => Value::Object(detail.clone()),
            Some(Value::String(message)) => json!({ "message": message }),
            _ => Value::Object(body),
        },
        _ => json!({}),
    };
    if quote.get("needs_confirmation").is_none() {
        quote["needs_confirmation"] = json!(true);
    }
    quote
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
    // No cache short-circuit: a finished film can be re-finalized server-side
    // (reshoots, restored audio), so an explicit export must always fetch the
    // CURRENT master — returning the stale local copy is exactly the "I still
    // download the old version" bug. The watcher's auto-download stays
    // once-per-project via its own `exported_films` guard (events.rs::maybe_export).
    let previous = super::settings_snapshot().exported_films.get(slug).cloned();
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
    // Drop the previous local copy so a re-download doesn't leave a stale
    // duplicate in the disk-derived gallery.
    if let Some(old) = previous {
        if old != absolute {
            let _ = std::fs::remove_file(&old);
        }
    }
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
    fn model_sets_are_validated_before_they_can_be_frozen_in() {
        assert_eq!(validated_model_set(None).unwrap(), None);
        assert_eq!(validated_model_set(Some("  ")).unwrap(), None);
        assert_eq!(
            validated_model_set(Some(" uncensored ")).unwrap(),
            Some("uncensored".to_string())
        );
        // A typo would be dropped server-side and silently produce a film on
        // the default set, with no way to change it afterwards.
        let error = validated_model_set(Some("uncensored-xl")).unwrap_err();
        assert_eq!(error.code, "videomaker_invalid");
        assert!(error.message.contains("full_quality or uncensored"));
    }

    #[test]
    fn settings_always_carry_the_prefs_the_studio_requires() {
        let body = settings_body(json!({ "autonomous": true }));
        assert_eq!(body["prefs"], json!({}));
        assert_eq!(body["settings"]["autonomous"], json!(true));
    }

    #[test]
    fn flattens_the_studios_wrapped_quote() {
        let quote = flatten_quote(Some(json!({
            "detail": { "needs_confirmation": true, "projected_cost_diem": 412.5 }
        })));
        assert_eq!(quote["needs_confirmation"], json!(true));
        assert_eq!(quote["projected_cost_diem"], json!(412.5));
    }

    #[test]
    fn quote_flattening_tolerates_other_shapes() {
        // Already flat (a future studio, or a replayed idempotent response).
        let flat = flatten_quote(Some(json!({ "projected_cost_diem": 12.0 })));
        assert_eq!(flat["projected_cost_diem"], json!(12.0));
        assert_eq!(flat["needs_confirmation"], json!(true));
        // A plain-string detail keeps its message instead of vanishing.
        let text = flatten_quote(Some(json!({ "detail": "confirm to start" })));
        assert_eq!(text["message"], json!("confirm to start"));
        assert_eq!(text["needs_confirmation"], json!(true));
        // No body at all: still a confirmation, never an empty success.
        assert_eq!(flatten_quote(None), json!({ "needs_confirmation": true }));
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
