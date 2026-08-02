//! Durable Studio generations: queue → poll → download → notify, in Rust.
//!
//! Video, music and sound-effect models are asynchronous: the backend accepts
//! (and charges for) a job, then takes minutes to render it. That poll used to
//! live in the webview, which iOS freezes the instant the app leaves the
//! foreground — so locking the phone stalled a paid render until the user came
//! back to the exact screen that started it.
//!
//! Here the frontend only queues. Everything after the queue id is Rust:
//!
//! - the row goes into `media_jobs` before anything else, so the job survives a
//!   suspension, a kill, and a cold launch (`crate::background::sweep` picks up
//!   whatever is still `queued`/`processing`);
//! - the poll and the download hold a [`BackgroundTask`] guard, so they get the
//!   grace window after a screen lock and keep the app on the BGTaskScheduler's
//!   list of things worth waking up for;
//! - the finished file is written into the gallery directory by Rust, and a
//!   local notification tells the user, whether or not the app is on screen.
//!
//! The frontend then observes: it subscribes to [`MEDIA_JOB_EVENT`] while it is
//! awake, and reconciles through `media_job_list` on mount for everything that
//! landed while it was not. A completed row is kept until the UI acknowledges
//! it (`media_job_dismiss`), which is what makes "the render finished while the
//! app was closed" reach the gallery at all.

use crate::domain::types::{AppError, MediaJobDto, MediaJobStatus};
use crate::ios_background::BackgroundTask;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

/// Webview event carrying a [`MediaJobDto`] whenever a job changes state.
pub const MEDIA_JOB_EVENT: &str = "june://media-job";

/// Matches the cadence the backends expect for retrieve polling.
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// Give up entirely past this age. The backend has either lost the job or is
/// never going to answer, and an immortal row would be swept forever.
const MAX_JOB_AGE: chrono::Duration = chrono::Duration::hours(6);

static RUNNERS: OnceLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> =
    OnceLock::new();

fn runners() -> &'static Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    RUNNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    runners()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// Whether any generation is being polled right now. Feeds
/// [`crate::background::has_pending_work`], which decides whether iOS should be
/// asked for another background window.
pub fn has_active() -> bool {
    lock().values().any(|handle| !handle.inner().is_finished())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMediaJobRequest {
    /// The backend's queue id, from the queue call the frontend just made.
    pub queue_id: String,
    /// "video" | "music" | "image" | "sfx".
    pub kind: String,
    pub model: String,
    pub prompt: String,
    pub extension: String,
    pub retrieve_path: String,
    pub retrieve_body: serde_json::Value,
    /// Response fields to read the finished file's URL from, in order. A job
    /// whose retrieve streams the bytes instead falls back to the body.
    pub url_fields: Vec<String>,
    /// Gallery id of the clip this render continues, when it was started from
    /// a handoff frame.
    #[serde(default)]
    pub parent_artifact_id: Option<String>,
    /// Where in that clip the handoff frame was taken, in seconds.
    #[serde(default)]
    pub parent_handoff_seconds: Option<f64>,
    /// The quote this render was accepted at, in credits.
    #[serde(default)]
    pub cost_credits: Option<f64>,
}

/// Hand a freshly queued generation over to Rust. Returns as soon as the row
/// exists — the caller does not wait for the render.
#[tauri::command]
pub async fn media_job_start(
    app: AppHandle,
    request: StartMediaJobRequest,
) -> Result<MediaJobDto, AppError> {
    if request.queue_id.trim().is_empty() {
        return Err(AppError::new(
            "media_job_invalid",
            "The backend did not return a job id.",
        ));
    }
    let job = MediaJobDto {
        id: request.queue_id.clone(),
        kind: request.kind,
        model: request.model,
        prompt: request.prompt,
        extension: request.extension,
        status: MediaJobStatus::Queued,
        error: None,
        artifact_path: None,
        artifact_file_name: None,
        artifact_bytes: None,
        parent_artifact_id: request.parent_artifact_id,
        parent_handoff_seconds: request.parent_handoff_seconds,
        cost_credits: request.cost_credits,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let repos = crate::commands::repositories(&app).await?;
    repos
        .insert_media_job(
            &job,
            &request.retrieve_path,
            &request.retrieve_body.to_string(),
            &serde_json::json!(request.url_fields).to_string(),
        )
        .await?;
    let stored = repos
        .get_media_job(&job.id)
        .await?
        .ok_or_else(|| AppError::new("media_job_invalid", "The job could not be recorded."))?;
    spawn_runner(
        &app,
        stored.clone(),
        request.retrieve_path,
        request.retrieve_body,
        request.url_fields,
    );
    Ok(stored)
}

/// Every job the UI has not acknowledged yet, running or finished.
#[tauri::command]
pub async fn media_job_list(app: AppHandle) -> Result<Vec<MediaJobDto>, AppError> {
    Ok(crate::commands::repositories(&app)
        .await?
        .list_media_jobs()
        .await?)
}

/// Stop polling one job without abandoning it. The backend keeps rendering
/// (and has already billed), so the row stays and the next sweep resumes it.
#[tauri::command]
pub async fn media_job_stop(id: String) -> Result<(), AppError> {
    if let Some(handle) = lock().remove(&id) {
        handle.abort();
    }
    Ok(())
}

/// Forget a job for good: the UI has filed its artifact in the gallery, or the
/// user dismissed a failure.
#[tauri::command]
pub async fn media_job_dismiss(app: AppHandle, id: String) -> Result<(), AppError> {
    if let Some(handle) = lock().remove(&id) {
        handle.abort();
    }
    crate::commands::repositories(&app)
        .await?
        .delete_media_job(&id)
        .await?;
    Ok(())
}

/// Re-drive every unfinished generation. Idempotent: a job already being polled
/// keeps its runner instead of getting a second one.
pub async fn resume_all(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(active) = repos.active_media_jobs().await else {
        return;
    };
    for (job, retrieve_path, retrieve_body, url_fields) in active {
        if is_running(&job.id) {
            continue;
        }
        if expired(&job) {
            fail(app, &job.id, "The generation timed out.").await;
            continue;
        }
        let Ok(body) = serde_json::from_str::<serde_json::Value>(&retrieve_body) else {
            fail(app, &job.id, "The job's retrieve request is unreadable.").await;
            continue;
        };
        let fields =
            serde_json::from_str::<Vec<String>>(&url_fields).unwrap_or_else(|_| vec!["url".into()]);
        spawn_runner(app, job, retrieve_path, body, fields);
    }
}

fn is_running(id: &str) -> bool {
    lock()
        .get(id)
        .is_some_and(|handle| !handle.inner().is_finished())
}

fn expired(job: &MediaJobDto) -> bool {
    chrono::DateTime::parse_from_rfc3339(&job.created_at)
        .map(|created| chrono::Utc::now().signed_duration_since(created) > MAX_JOB_AGE)
        .unwrap_or(false)
}

fn spawn_runner(
    app: &AppHandle,
    job: MediaJobDto,
    retrieve_path: String,
    retrieve_body: serde_json::Value,
    url_fields: Vec<String>,
) {
    let id = job.id.clone();
    let app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run(app, job, retrieve_path, retrieve_body, url_fields).await;
    });
    let mut registry = lock();
    // Finished runners are only kept so `is_running` can answer; drop them
    // here so a long session doesn't accumulate one entry per generation.
    registry.retain(|_, handle| !handle.inner().is_finished());
    registry.insert(id, handle);
}

/// Poll one job until it settles. Ends by writing the row (completed or
/// failed), never by silently dropping the job: a suspension pauses this loop
/// mid-sleep, and the next sweep starts a fresh one from the same row.
async fn run(
    app: AppHandle,
    job: MediaJobDto,
    retrieve_path: String,
    retrieve_body: serde_json::Value,
    url_fields: Vec<String>,
) {
    // Held for the whole run: this is what buys the grace window after a
    // screen lock, and what tells `background::has_pending_work` we are busy.
    let _background = BackgroundTask::begin("media-job");
    let id = job.id.clone();
    // Second bound, in case the row's timestamp is unreadable: `Instant` is
    // monotonic, so this cannot be fooled by a clock change either.
    let started = std::time::Instant::now();
    let runtime_budget = MAX_JOB_AGE.to_std().unwrap_or(Duration::from_secs(21_600));
    let mut last_reported: Option<MediaJobStatus> = None;

    for attempt in 0.. {
        if attempt > 0 {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        if expired(&job) || started.elapsed() > runtime_budget {
            fail(&app, &id, "The generation timed out.").await;
            return;
        }
        let response = match super::media::send("POST", &retrieve_path, Some(&retrieve_body)).await
        {
            Ok(response) => response,
            // Transport failures are transient by construction (no network in
            // the background, sidecar asleep): keep polling.
            Err(_) => continue,
        };
        if !response.ok {
            // A 4xx means the job id is wrong or expired — no amount of
            // waiting fixes it. 5xx and rate limits are the backend catching
            // its breath.
            if (400..500).contains(&response.status) {
                fail(&app, &id, &backend_error(&response)).await;
                return;
            }
            continue;
        }

        // Some backends answer a finished job with the file itself and then
        // drop the job server-side, so this response IS the delivery: the next
        // poll would 404 and the paid result would be gone. Which also means a
        // failed write here cannot be retried by polling again.
        if let Some(base64) = response.body_base64.as_deref() {
            if !deliver(&app, &job, Payload::Base64(base64.to_string())).await {
                fail(&app, &id, "The finished file could not be saved.").await;
            }
            return;
        }
        let Some(payload) = response.json.as_ref() else {
            continue;
        };
        match status_of(payload) {
            Some(MediaJobStatus::Completed) => {
                let Some(url) = url_from(payload, &url_fields) else {
                    fail(&app, &id, "The job completed but returned no output.").await;
                    return;
                };
                // A download failure is worth another try: the job stays
                // completed upstream, so the next poll returns the same URL.
                if deliver(&app, &job, Payload::Url(url)).await {
                    return;
                }
                continue;
            }
            Some(MediaJobStatus::Failed) => {
                let reason = payload
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("The generation failed.");
                fail(&app, &id, reason).await;
                return;
            }
            // Only on the transition: this loop ticks every few seconds and
            // the UI does not need a write and an event each time.
            Some(status) if last_reported != Some(status) => {
                last_reported = Some(status);
                mark(&app, &id, status).await;
            }
            _ => {}
        }
    }
}

enum Payload {
    Url(String),
    Base64(String),
}

/// Write the finished file into the gallery, settle the row, tell the user.
/// Returns whether the artifact actually landed.
async fn deliver(app: &AppHandle, job: &MediaJobDto, payload: Payload) -> bool {
    let artifact = match payload {
        Payload::Url(url) => super::media::download(app, &url, &job.extension).await,
        Payload::Base64(base64) => super::media::save_base64(app, &base64, &job.extension).await,
    };
    match artifact {
        Ok(artifact) => {
            if let Ok(repos) = crate::commands::repositories(app).await {
                if let Ok(Some(updated)) = repos
                    .complete_media_job(
                        &job.id,
                        &artifact.path,
                        &artifact.file_name,
                        artifact.bytes as i64,
                    )
                    .await
                {
                    emit(app, &updated);
                }
            }
            notify(app, job, true);
            true
        }
        // The render succeeded but the file did not reach the disk. The row
        // stays where it is; the caller decides whether another poll can
        // recover it.
        Err(error) => {
            eprintln!("media job {}: delivery failed: {}", job.id, error.message);
            if let Ok(repos) = crate::commands::repositories(app).await {
                let _ = repos.bump_media_job_attempts(&job.id).await;
            }
            false
        }
    }
}

async fn mark(app: &AppHandle, id: &str, status: MediaJobStatus) {
    if let Ok(repos) = crate::commands::repositories(app).await {
        if let Ok(Some(job)) = repos.set_media_job_status(id, status, None).await {
            emit(app, &job);
        }
    }
}

async fn fail(app: &AppHandle, id: &str, reason: &str) {
    if let Ok(repos) = crate::commands::repositories(app).await {
        if let Ok(Some(job)) = repos
            .set_media_job_status(id, MediaJobStatus::Failed, Some(reason))
            .await
        {
            emit(app, &job);
            notify(app, &job, false);
        }
    }
}

fn emit(app: &AppHandle, job: &MediaJobDto) {
    let _ = app.emit(MEDIA_JOB_EVENT, job);
}

/// The point of the whole exercise: a render that lands while the user is in
/// another app still reaches them. Best-effort — permission is asked for in the
/// UI when the generation is queued, and a refusal is not an error here.
fn notify(app: &AppHandle, job: &MediaJobDto, success: bool) {
    let title = if success {
        match job.kind.as_str() {
            "video" => "Your video is ready",
            "music" => "Your track is ready",
            "sfx" => "Your sound effect is ready",
            _ => "Your image is ready",
        }
    } else {
        "Your generation failed"
    };
    let body = job
        .prompt
        .trim()
        .chars()
        .take(120)
        .collect::<String>()
        .trim()
        .to_string();
    let body = if body.is_empty() {
        "Open Sub Rosa to see it.".to_string()
    } else {
        body
    };
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Backends spell statuses differently (and in both cases): normalize.
fn status_of(payload: &serde_json::Value) -> Option<MediaJobStatus> {
    let raw = payload.get("status")?.as_str()?.trim().to_ascii_lowercase();
    match raw.as_str() {
        "queued" | "pending" | "waiting" => Some(MediaJobStatus::Queued),
        "processing" | "running" | "in_progress" | "generating" => Some(MediaJobStatus::Processing),
        "completed" | "complete" | "succeeded" | "success" | "done" => {
            Some(MediaJobStatus::Completed)
        }
        "failed" | "error" | "cancelled" | "canceled" => Some(MediaJobStatus::Failed),
        _ => None,
    }
}

fn url_from(payload: &serde_json::Value, fields: &[String]) -> Option<String> {
    fields.iter().find_map(|field| {
        payload
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn backend_error(response: &super::media::MediaResponseDto) -> String {
    response
        .json
        .as_ref()
        .and_then(|json| {
            json.get("error")
                .and_then(|error| error.as_str().or_else(|| error.get("message")?.as_str()))
                .or_else(|| json.get("message")?.as_str())
        })
        .map(str::to_string)
        .unwrap_or_else(|| format!("The backend returned status {}.", response.status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_status_spellings_the_backends_use() {
        for raw in ["Completed", "SUCCESS", "done"] {
            let payload = serde_json::json!({ "status": raw });
            assert_eq!(status_of(&payload), Some(MediaJobStatus::Completed));
        }
        let payload = serde_json::json!({ "status": "in_progress" });
        assert_eq!(status_of(&payload), Some(MediaJobStatus::Processing));
        let payload = serde_json::json!({ "status": "canceled" });
        assert_eq!(status_of(&payload), Some(MediaJobStatus::Failed));
        let payload = serde_json::json!({ "status": "who knows" });
        assert_eq!(status_of(&payload), None);
    }

    #[test]
    fn reads_the_first_non_empty_url_field_in_order() {
        let fields = vec!["video_url".to_string(), "url".to_string()];
        let payload = serde_json::json!({ "video_url": "  ", "url": "https://example/a.mp4" });
        assert_eq!(
            url_from(&payload, &fields).as_deref(),
            Some("https://example/a.mp4")
        );
        assert_eq!(url_from(&serde_json::json!({}), &fields), None);
    }

    #[test]
    fn surfaces_the_backends_own_error_message() {
        let response = super::super::media::MediaResponseDto {
            status: 400,
            ok: false,
            json: Some(serde_json::json!({ "error": "Unknown job id." })),
            body_base64: None,
            content_type: None,
            retry_after_ms: None,
        };
        assert_eq!(backend_error(&response), "Unknown job id.");
    }
}
