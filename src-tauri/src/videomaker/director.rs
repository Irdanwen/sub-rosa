//! Director-mode commands (ADR-0010, phase 3): drive a *gated* film project
//! by hand — talk to the studio crew, approve or reject phase gates, review
//! the shot board, and pick or re-render takes.
//!
//! The chat turn uses `POST /chat/stream` (the sync `/chat` endpoint times
//! out on asset-generation turns): tool progress is re-emitted to the webview
//! as [`CHAT_EVENT`] while the command stays pending, and the final `done`
//! payload (assistant reply + state delta) is the command's return value.
//! Streaming routes are exempt from idempotency keys by contract.

use crate::domain::types::AppError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::client::{send, Request};

/// Webview event: `{ slug, kind, data }` where kind is the stream's event
/// name (`tool`, `done`, `error`, ...).
pub const CHAT_EVENT: &str = "june://videomaker-chat";

/// The chat stream pings every ~10 s; a turn can legitimately stay quiet for
/// a while between tool boundaries, so only a dead transport should trip this.
const CHAT_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateDecisionRequest {
    pub slug: String,
    pub phase: String,
    pub decision_reason: Option<String>,
    /// Per-entity approval (asset_pack gate only).
    pub entity_id: Option<String>,
}

#[tauri::command]
pub async fn videomaker_gates(app: AppHandle, slug: String) -> Result<Value, AppError> {
    send(&app, Request::get(format!("/projects/{slug}/gates"))).await
}

#[tauri::command]
pub async fn videomaker_gate_approve(
    app: AppHandle,
    request: GateDecisionRequest,
) -> Result<Value, AppError> {
    gate_decision(&app, request, "approve").await
}

#[tauri::command]
pub async fn videomaker_gate_reject(
    app: AppHandle,
    request: GateDecisionRequest,
) -> Result<Value, AppError> {
    gate_decision(&app, request, "reject").await
}

async fn gate_decision(
    app: &AppHandle,
    request: GateDecisionRequest,
    action: &str,
) -> Result<Value, AppError> {
    let GateDecisionRequest {
        slug,
        phase,
        decision_reason,
        entity_id,
    } = request;
    let body = json!({ "decision_reason": decision_reason, "entity_id": entity_id });
    send(
        app,
        Request::post(format!("/projects/{slug}/gates/{phase}/{action}"), body),
    )
    .await
}

#[tauri::command]
pub async fn videomaker_board(app: AppHandle, slug: String) -> Result<Value, AppError> {
    send(&app, Request::get(format!("/projects/{slug}/board"))).await
}

#[tauri::command]
pub async fn videomaker_failures(app: AppHandle, slug: String) -> Result<Value, AppError> {
    send(&app, Request::get(format!("/projects/{slug}/failures"))).await
}

#[tauri::command]
pub async fn videomaker_transcript(app: AppHandle, slug: String) -> Result<Value, AppError> {
    send(&app, Request::get(format!("/projects/{slug}/transcript"))).await
}

#[tauri::command]
pub async fn videomaker_shot_takes(
    app: AppHandle,
    slug: String,
    shot_id: String,
) -> Result<Value, AppError> {
    send(
        &app,
        Request::get(format!("/projects/{slug}/shots/{shot_id}/takes")),
    )
    .await
}

/// Free: flips which rendered take the final cut uses.
#[tauri::command]
pub async fn videomaker_take_select(
    app: AppHandle,
    slug: String,
    shot_id: String,
    version: u32,
) -> Result<Value, AppError> {
    send(
        &app,
        Request::post(
            format!("/projects/{slug}/shots/{shot_id}/takes/{version}/select"),
            Value::Null,
        ),
    )
    .await
}

/// Re-render a shot (same refs/continuity, optionally adjusted prompt).
/// Spend-guarded server-side; costly, so idempotent.
#[tauri::command]
pub async fn videomaker_shot_retake(
    app: AppHandle,
    slug: String,
    shot_id: String,
    prompt: Option<String>,
) -> Result<Value, AppError> {
    let body = match prompt {
        Some(prompt) if !prompt.trim().is_empty() => json!({ "prompt": prompt }),
        _ => json!({}),
    };
    send(
        &app,
        Request::costly_post(format!("/projects/{slug}/shots/{shot_id}/retake"), body),
    )
    .await
}

/// Retry a failed shot as-is (costly, so idempotent).
#[tauri::command]
pub async fn videomaker_shot_requeue(
    app: AppHandle,
    slug: String,
    shot_id: String,
) -> Result<Value, AppError> {
    send(
        &app,
        Request::costly_post(
            format!("/projects/{slug}/shots/{shot_id}/requeue"),
            json!({}),
        ),
    )
    .await
}

/// Placeholder the shot and unblock the film (free).
#[tauri::command]
pub async fn videomaker_shot_skip(
    app: AppHandle,
    slug: String,
    shot_id: String,
) -> Result<Value, AppError> {
    send(
        &app,
        Request::post(format!("/projects/{slug}/shots/{shot_id}/skip"), json!({})),
    )
    .await
}

/// One streamed chat turn with the studio crew. Tool boundaries are emitted
/// live as [`CHAT_EVENT`]; the returned value is the terminal payload:
/// `{"type":"done", "reply", "state", ...}` (or the turn's error as `Err`).
#[tauri::command]
pub async fn videomaker_chat(
    app: AppHandle,
    slug: String,
    message: String,
) -> Result<Value, AppError> {
    if message.trim().is_empty() {
        return Err(AppError::new("videomaker_invalid", "Say something first."));
    }
    let Some(token) = super::stored_token() else {
        return Err(AppError::new(
            "videomaker_not_activated",
            "Film production is not activated yet. Activate it in Settings > Film studio.",
        ));
    };
    let url = format!("{}/projects/{slug}/chat/stream", super::api_root());
    let body = json!({ "message": message });
    let response = open_chat_stream(&url, &token, &body).await?;
    let mut response = if response.status().as_u16() == 401 {
        let token = super::auth::mint_and_store_token(&app).await?;
        open_chat_stream(&url, &token, &body).await?
    } else {
        response
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        return Err(super::client::error_for_status(status, body));
    }

    let mut buffer = String::new();
    loop {
        let chunk = match tokio::time::timeout(CHAT_IDLE_TIMEOUT, response.chunk()).await {
            Err(_) => {
                return Err(AppError::new(
                    "videomaker_chat_stalled",
                    "The studio stopped answering mid-turn. Send the message again.",
                ));
            }
            Ok(Err(error)) => {
                return Err(AppError::new("videomaker_unreachable", error.to_string()));
            }
            Ok(Ok(None)) => {
                // Stream closed without a terminal event: the turn continues
                // server-side; the transcript has the reply on next load.
                return Err(AppError::new(
                    "videomaker_chat_interrupted",
                    "The connection dropped mid-turn. The studio keeps working; reopen the project to see the reply.",
                ));
            }
            Ok(Ok(Some(chunk))) => chunk,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
        while let Some(end) = buffer.find("\n\n") {
            let block = buffer[..end].to_string();
            buffer.drain(..end + 2);
            let Some((kind, data)) = super::events::parse_sse_block(&block) else {
                continue;
            };
            if kind == "ping" {
                continue;
            }
            let _ = app.emit(
                CHAT_EVENT,
                json!({ "slug": slug, "kind": kind, "data": data }),
            );
            match kind.as_str() {
                "done" => return Ok(data),
                "error" => {
                    let detail = data
                        .get("detail")
                        .and_then(Value::as_str)
                        .unwrap_or("The studio hit an error during this turn.");
                    return Err(AppError::new("videomaker_chat_failed", detail.to_string()));
                }
                _ => {}
            }
        }
    }
}

async fn open_chat_stream(
    url: &str,
    token: &str,
    body: &Value,
) -> Result<reqwest::Response, AppError> {
    super::events::sse_client()
        .post(url)
        .bearer_auth(token)
        .header("Accept", "text/event-stream")
        .json(body)
        .send()
        .await
        .map_err(|error| {
            let base = super::base_url();
            if error.is_timeout() {
                AppError::new("videomaker_unreachable", format!("{base} timed out."))
            } else {
                AppError::new("videomaker_unreachable", format!("Couldn't reach {base}."))
            }
        })
}
