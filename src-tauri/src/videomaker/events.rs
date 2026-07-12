//! Per-project SSE watchers (ADR-0010).
//!
//! One Rust task per watched film project consumes
//! `GET /api/projects/{slug}/events/stream` and re-emits every event to the
//! webview as [`FILM_EVENT`]. Reconnects with capped exponential backoff and
//! re-fetches `/status` on every (re)connect, so a broken stream degrades to
//! ~1-minute polling instead of silence. Watched slugs are persisted —
//! production continues server-side while the app is closed, and
//! [`resume_watchers`] picks monitoring back up on boot.
//!
//! Completion is load-bearing: Videomaker purges idle projects after 7 days,
//! so as soon as the final cut exists the watcher downloads it into the
//! Studio artifacts gallery (once — see `exported_films`).

use crate::domain::types::AppError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Webview event: `{ slug, kind, data }`. Kinds are Videomaker's SSE kinds
/// (`scene`, `ledger`, `phase_gate`, `run`, ...) plus the synthetic `status`
/// (a `/status` snapshot on every resync), `exported` (final film saved to
/// the gallery), `final_review` (export blocked on the final gate) and
/// `gone` (project no longer exists server-side).
pub const FILM_EVENT: &str = "june://videomaker-event";

/// The server pings every 15 s; a stream with no bytes for a minute is dead.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BACKOFF_SECS: u64 = 60;

static WATCHERS: OnceLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> =
    OnceLock::new();
static SSE_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Long-lived stream client: no total timeout (the default client's 120 s
/// would kill a healthy stream), liveness enforced per-chunk instead.
pub(super) fn sse_client() -> &'static reqwest::Client {
    SSE_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .expect("videomaker sse client")
    })
}

/// Resume watchers for the film projects recorded in `videomaker.json`.
pub fn resume_watchers(app: &AppHandle) {
    if !super::is_activated() {
        return;
    }
    for slug in super::settings_snapshot().watched_slugs {
        watch(app, &slug);
    }
}

/// Start watching a project (idempotent — a live watcher is kept).
pub fn watch(app: &AppHandle, slug: &str) {
    let mut guard = registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(handle) = guard.get(slug) {
        if !handle.inner().is_finished() {
            return;
        }
    }
    let app = app.clone();
    let task_slug = slug.to_string();
    let handle = tauri::async_runtime::spawn(async move {
        watch_loop(app, task_slug).await;
    });
    guard.insert(slug.to_string(), handle);
}

pub fn unwatch(slug: &str) {
    let mut guard = registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(handle) = guard.remove(slug) {
        handle.abort();
    }
}

/// Deactivation: drop every live watcher (the slugs stay persisted, so
/// re-activation resumes them).
pub fn stop_all() {
    let mut guard = registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    for (_, handle) in guard.drain() {
        handle.abort();
    }
}

async fn watch_loop(app: AppHandle, slug: String) {
    let mut backoff: u64 = 1;
    loop {
        // Resync on every (re)connect: events missed while disconnected (or
        // while the app was closed) are folded into one /status snapshot.
        match super::client::send(
            &app,
            super::client::Request::get(format!("/projects/{slug}/status")),
        )
        .await
        {
            Ok(status) => {
                emit(&app, &slug, "status", status);
                maybe_export(&app, &slug).await;
            }
            Err(error) if error.code == "videomaker_not_found" => {
                // Purged (7-day TTL) or deleted: stop for good.
                emit(&app, &slug, "gone", Value::Null);
                forget(&app, &slug);
                return;
            }
            Err(error) if error.code == "videomaker_not_activated" => return,
            Err(_) => {} // transient — the backoff below covers it
        }

        // A session that delivered real events was healthy: reconnect promptly.
        if let Ok(true) = stream_events(&app, &slug).await {
            backoff = 1;
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
    }
}

/// Consume one SSE session until the server closes it or it goes stale.
/// Returns whether any real (non-ping) event was received.
async fn stream_events(app: &AppHandle, slug: &str) -> Result<bool, AppError> {
    let Some(token) = super::stored_token() else {
        return Err(AppError::new("videomaker_not_activated", "not activated"));
    };
    let url = format!("{}/projects/{slug}/events/stream", super::api_root());
    let response = sse_client()
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|error| AppError::new("videomaker_unreachable", error.to_string()))?;
    let mut response = if response.status().as_u16() == 401 {
        // Same self-heal as the request client: the wallet outlives the PAT.
        let token = super::auth::mint_and_store_token(app).await?;
        sse_client()
            .get(&url)
            .bearer_auth(&token)
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(|error| AppError::new("videomaker_unreachable", error.to_string()))?
    } else {
        response
    };
    if !response.status().is_success() {
        return Err(super::client::error_for_status(
            response.status().as_u16(),
            Value::Null,
        ));
    }

    let mut buffer = String::new();
    let mut seen = false;
    loop {
        let chunk = match tokio::time::timeout(IDLE_TIMEOUT, response.chunk()).await {
            Err(_) => break,                    // stale: no bytes (not even a ping) in a minute
            Ok(Err(_)) | Ok(Ok(None)) => break, // transport error / server closed
            Ok(Ok(Some(chunk))) => chunk,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
        while let Some(end) = buffer.find("\n\n") {
            let block = buffer[..end].to_string();
            buffer.drain(..end + 2);
            let Some((kind, data)) = parse_sse_block(&block) else {
                continue;
            };
            if kind == "ping" {
                continue;
            }
            seen = true;
            emit(app, slug, &kind, data);
            // Run/gate transitions are the moments a final cut can appear.
            if kind == "run" || kind == "phase_gate" {
                maybe_export(app, slug).await;
            }
        }
    }
    Ok(seen)
}

/// One `event:`/`data:` block → (kind, parsed JSON payload). Shared with the
/// chat stream in [`super::director`].
pub(super) fn parse_sse_block(block: &str) -> Option<(String, Value)> {
    let mut kind: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            kind = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
        // id:/retry:/comment lines are irrelevant here.
    }
    let kind = kind?;
    let raw = data_lines.join("\n");
    let data = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
    Some((kind, data))
}

/// Download the final cut into the artifacts gallery, exactly once per
/// project. Quietly does nothing while the film isn't finished; a 423 (final
/// gate pending) is surfaced so the UI can ask for the approval.
async fn maybe_export(app: &AppHandle, slug: &str) {
    if super::settings_snapshot().exported_films.contains_key(slug) {
        return;
    }
    let Ok(overview) = super::client::send(
        app,
        super::client::Request::get(format!("/projects/{slug}")),
    )
    .await
    else {
        return;
    };
    let finished = overview
        .get("project")
        .and_then(|project| project.get("final_mp4"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !finished {
        return;
    }
    match super::projects::download_export(app, slug).await {
        Ok(artifact) => emit(app, slug, "exported", json!(artifact)),
        Err(error) if error.code == "videomaker_locked" => {
            emit(app, slug, "final_review", Value::Null);
        }
        Err(_) => {} // retried on the next resync
    }
}

/// Stop watching and drop the slug from the persisted list.
fn forget(app: &AppHandle, slug: &str) {
    let _ = super::update_settings(app, |settings| {
        settings.watched_slugs.retain(|watched| watched != slug);
    });
    let mut guard = registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    guard.remove(slug);
}

fn emit(app: &AppHandle, slug: &str, kind: &str, data: Value) {
    let _ = app.emit(
        FILM_EVENT,
        json!({ "slug": slug, "kind": kind, "data": data }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_videomaker_sse_block() {
        let block = "event: scene\ndata: {\"kind\":\"scene\",\"scene_id\":\"s1\"}";
        let (kind, data) = parse_sse_block(block).unwrap();
        assert_eq!(kind, "scene");
        assert_eq!(data["scene_id"], "s1");
    }

    #[test]
    fn parses_pings_and_ignores_unknown_fields() {
        let block = "id: 42\nretry: 3000\nevent: ping\ndata: {}";
        let (kind, data) = parse_sse_block(block).unwrap();
        assert_eq!(kind, "ping");
        assert_eq!(data, serde_json::json!({}));
    }

    #[test]
    fn joins_multiline_data_and_falls_back_to_raw_string() {
        let block = "event: turn\ndata: not\ndata: json";
        let (kind, data) = parse_sse_block(block).unwrap();
        assert_eq!(kind, "turn");
        assert_eq!(data, Value::String("not\njson".to_string()));
    }

    #[test]
    fn blocks_without_an_event_name_are_dropped() {
        assert!(parse_sse_block(": comment only").is_none());
        assert!(parse_sse_block("data: {\"orphan\":true}").is_none());
    }
}
