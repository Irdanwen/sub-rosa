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
use tauri::{AppHandle, Emitter};

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

/// Stream a studio URL straight into the artifacts gallery directory.
///
/// Shared by the export path and by the bring-home rescue (R0): both pull
/// signed URLs that need no bearer, both must survive a large file without
/// buffering it, and both write where `listArtifacts` will find the file. The
/// webview still has to index what lands here (`registerDownloadedArtifact`) —
/// the gallery index is localStorage, and Rust cannot write it.
async fn stream_into_gallery(
    app: &AppHandle,
    url: &str,
    extension: &str,
) -> Result<FilmArtifactDto, AppError> {
    let mut response = super::client::http_client()
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::new("videomaker_download_failed", error.to_string()))?;

    let dir = crate::carpe_diem::media::artifacts_dir(app)?;
    let file_name = format!("{}.{extension}", uuid::Uuid::new_v4());
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
            "The downloaded file is empty.",
        ));
    }
    Ok(FilmArtifactDto {
        path: path.to_string_lossy().to_string(),
        file_name,
        bytes: byte_count,
    })
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

    let artifact = stream_into_gallery(app, &url, "mp4").await?;
    let file_name = artifact.file_name;
    let byte_count = artifact.bytes;
    let absolute = artifact.path;
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

// --- bring home (R0: the rescue window before Videomaker is removed) ----------

/// Webview event while a film is being pulled down: `{ slug, downloaded, label }`.
///
/// A large film is sixty downloads over several minutes. Without this the
/// button says "Bringing it home..." and nothing else, which reads as hung -
/// and a rescue the user kills half way through is a rescue that did not
/// happen, with no second chance after the removal.
pub const BRING_HOME_EVENT: &str = "june://videomaker-bring-home";

fn emit_progress(app: &AppHandle, slug: &str, downloaded: usize, label: &str) {
    let _ = app.emit(
        BRING_HOME_EVENT,
        json!({ "slug": slug, "downloaded": downloaded, "label": label }),
    );
}

/// One downloaded piece of a film: the master, a rendered shot, or a
/// storyboard frame. `path` is where Rust wrote it in the gallery directory —
/// the webview still has to index it (`registerDownloadedArtifact`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroughtHomePieceDto {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    /// `master`, `clip` or `frame`.
    pub kind: String,
    pub scene_title: Option<String>,
    pub shot_id: Option<String>,
    pub prompt: Option<String>,
    pub duration_seconds: Option<f64>,
}

/// Everything a film leaves behind, pulled off the studio in one call.
///
/// Nothing here fails the whole rescue: a film with no final cut, a shot whose
/// signed URL has expired, a transcript the studio no longer keeps — each
/// records its own error and the rest still comes home. A partial rescue is
/// worth infinitely more than a clean failure, because after R4 there is no
/// second attempt.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroughtHomeFilmDto {
    pub slug: String,
    pub title: String,
    pub brief: Option<String>,
    pub state: Option<String>,
    pub created_at: Option<String>,
    pub spent_diem: Option<f64>,
    pub pieces: Vec<BroughtHomePieceDto>,
    /// Director-mode transcript, oldest first: `(role, content)`.
    pub transcript: Vec<(String, String)>,
    /// What could not be brought home, in the user's words.
    pub problems: Vec<String>,
}

/// Read a string from any of several plausible keys. The studio's overview has
/// grown organically and the brief has lived under more than one name.
fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|found| !found.is_empty())
            .map(str::to_string)
    })
}

/// The file extension a signed URL implies, defaulted per kind. Studio URLs
/// carry a query string, so the path has to be isolated first.
fn extension_of(url: &str, fallback: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or_else(|| fallback.to_string())
}

/// Bring one film home: master, rendered shots, storyboard frames, brief and
/// director transcript, all into the gallery directory and a returned DTO.
///
/// This is the R0 rescue window (see `docs/plan-films-locaux-2026-08-24.md`).
/// It exists so that removing Videomaker in R4 costs the user nothing. It is
/// deliberately best-effort and deliberately re-runnable.
#[tauri::command]
pub async fn videomaker_bring_home(
    app: AppHandle,
    slug: String,
) -> Result<BroughtHomeFilmDto, AppError> {
    let mut problems: Vec<String> = Vec::new();

    let overview = send(&app, Request::get(format!("/projects/{slug}"))).await?;
    let title = first_string(&overview, &["title"]).unwrap_or_else(|| slug.clone());
    let brief = first_string(&overview, &["brief", "concept", "logline", "premise"]);
    let state = first_string(&overview, &["state"]);
    let created_at = first_string(&overview, &["created_at"]);

    let mut pieces: Vec<BroughtHomePieceDto> = Vec::new();
    let mut spent_diem: Option<f64> = None;

    // The master. A project that never finished simply has none.
    match download_export(&app, &slug).await {
        Ok(artifact) => {
            pieces.push(BroughtHomePieceDto {
                path: artifact.path,
                file_name: artifact.file_name,
                bytes: artifact.bytes,
                kind: "master".to_string(),
                scene_title: None,
                shot_id: None,
                prompt: None,
                duration_seconds: None,
            });
            emit_progress(&app, &slug, pieces.len(), "the final cut");
        }
        Err(error) => problems.push(format!(
            "The final cut did not come home: {}",
            error.message
        )),
    }

    // The board: every rendered shot, and the storyboard frame behind it.
    let base = super::base_url();
    match send(&app, Request::get(format!("/projects/{slug}/board"))).await {
        Ok(board) => {
            spent_diem = board
                .get("totals")
                .and_then(|totals| totals.get("spent_diem"))
                .and_then(Value::as_f64);
            let scenes = board
                .get("scenes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for scene in scenes {
                let scene_title = first_string(&scene, &["title", "scene_id"]);
                let shots = scene
                    .get("shots")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for shot in shots {
                    let shot_id = first_string(&shot, &["shot_id"]);
                    let prompt = first_string(&shot, &["prompt"]);
                    let duration_seconds = shot.get("duration_sec").and_then(Value::as_f64);
                    for (key, kind, fallback_ext) in
                        [("clip_url", "clip", "mp4"), ("frame_url", "frame", "png")]
                    {
                        let Some(raw) = first_string(&shot, &[key]) else {
                            continue;
                        };
                        let url = resolve_url(&base, &raw);
                        let extension = extension_of(&url, fallback_ext);
                        match stream_into_gallery(&app, &url, &extension).await {
                            Ok(artifact) => {
                                pieces.push(BroughtHomePieceDto {
                                    path: artifact.path,
                                    file_name: artifact.file_name,
                                    bytes: artifact.bytes,
                                    kind: kind.to_string(),
                                    scene_title: scene_title.clone(),
                                    shot_id: shot_id.clone(),
                                    prompt: prompt.clone(),
                                    duration_seconds,
                                });
                                let label = match shot_id.as_deref() {
                                    Some(id) => format!("{kind} of shot {id}"),
                                    None => kind.to_string(),
                                };
                                emit_progress(&app, &slug, pieces.len(), &label);
                            }
                            Err(error) => problems.push(format!(
                                "{} of shot {} did not come home: {}",
                                kind,
                                shot_id.clone().unwrap_or_else(|| "?".to_string()),
                                error.message
                            )),
                        }
                    }
                }
            }
        }
        Err(error) => problems.push(format!(
            "The shot board did not come home: {}",
            error.message
        )),
    }

    let transcript = match send(&app, Request::get(format!("/projects/{slug}/transcript"))).await {
        Ok(value) => value
            .get("messages")
            .and_then(Value::as_array)
            .map(|messages| {
                messages
                    .iter()
                    .filter_map(|message| {
                        let role = message.get("role").and_then(Value::as_str)?;
                        if role != "user" && role != "assistant" {
                            return None;
                        }
                        let content = message
                            .get("content")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|content| !content.is_empty())?;
                        Some((role.to_string(), content.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Err(error) => {
            problems.push(format!(
                "The director transcript did not come home: {}",
                error.message
            ));
            Vec::new()
        }
    };

    Ok(BroughtHomeFilmDto {
        slug,
        title,
        brief,
        state,
        created_at,
        spent_diem,
        pieces,
        transcript,
        problems,
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

    #[test]
    fn brings_home_reads_the_brief_wherever_it_lives() {
        // The overview grew organically and the brief has had more than one
        // name. A rescue that only knows the current one loses the older films,
        // which are exactly the ones most at risk.
        let concept = json!({ "concept": "a lighthouse keeper" });
        assert_eq!(
            first_string(&concept, &["brief", "concept"]).as_deref(),
            Some("a lighthouse keeper")
        );
        // Blank is not a value: it must fall through to the next key.
        let blank = json!({ "brief": "   ", "logline": "two sisters" });
        assert_eq!(
            first_string(&blank, &["brief", "logline"]).as_deref(),
            Some("two sisters")
        );
        assert_eq!(first_string(&json!({}), &["brief"]), None);
    }

    #[test]
    fn brings_home_names_files_from_the_url_not_the_query_string() {
        // Studio URLs are signed, so the extension is followed by a query.
        assert_eq!(
            extension_of("https://s.example/a/b/shot-3.mp4?sig=abc&x=1", "bin"),
            "mp4"
        );
        assert_eq!(extension_of("https://s.example/frame.PNG", "bin"), "png");
        // No extension, a path segment that only looks like one, or something
        // absurdly long: fall back rather than write a file nothing can open.
        assert_eq!(extension_of("https://s.example/download", "mp4"), "mp4");
        assert_eq!(
            extension_of("https://s.example/f.superlongext", "png"),
            "png"
        );
        assert_eq!(extension_of("https://s.example/f.m p4", "mp4"), "mp4");
    }
}
