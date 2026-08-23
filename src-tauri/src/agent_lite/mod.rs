//! Agent-lite: the mobile chat brain.
//!
//! The desktop agent runs on the embedded Hermes runtime (a Python subprocess
//! with skills and MCP servers) — impossible on iOS. Agent-lite keeps the
//! product promise ("chat with an assistant over your notes") with what the
//! platform allows: a tool-loop over the June API's chat-completions proxy
//! (Carpe Diem upstream), with tools that run in-process.
//!
//! Reading:
//! - `search_notes`      — LIKE retrieval over the local SQLite notes/transcripts;
//! - `read_note`         — one note in full, note body plus transcript;
//! - `list_recent_notes` — the newest notes, for questions about a period;
//! - `search_memories`   — hybrid recall over remembered facts (memory on only);
//! - `web_search`        — the June API `/v1/web/search` passthrough;
//! - `places_search`     — `/v1/web/places`, real-world places for the
//!   `subrosa:places` chat block (ADR-0024);
//! - `fetch_page`        — `/v1/web/fetch`, the text of one page.
//!
//! Writing:
//! - `create_note`, `append_to_note` — the assistant can put something in the
//!   user's notes when asked, and the shell refreshes on
//!   [`AGENT_LITE_NOTES_CHANGED_EVENT`];
//! - `remember`          — store a durable fact on request (memory on only).
//!
//! Search returns a keyword window, never a whole note, so anything about what
//! a note *says* has to go through `read_note`. The system prompt says so
//! explicitly, because a model that only searches will confidently summarise
//! 700 characters as if they were the meeting.
//!
//! Sessions persist in the same `agent_tasks`/`agent_messages` tables the
//! desktop uses, so the data model stays one thing. Status streams to the UI
//! over `agent-lite://status`; completion over `agent-lite://done`.

use crate::{
    domain::types::{AgentMessageRole, AgentTaskStatus, AppError},
    june_api,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

pub const AGENT_LITE_STATUS_EVENT: &str = "agent-lite://status";
pub const AGENT_LITE_DONE_EVENT: &str = "agent-lite://done";
/// Reply text as it is generated, so the chat fills in instead of sitting on a
/// spinner for the length of the answer. Payload: `{ taskId, text }`, where
/// `text` is the fragment to append.
pub const AGENT_LITE_DELTA_EVENT: &str = "agent-lite://delta";

/// Hard cap on tool round-trips per user turn, so a confused model cannot
/// loop forever (each iteration is a paid completion). Three was enough when
/// the only tools were two searches; finding a note, reading it, and writing a
/// summary back is already three before the model has said anything.
const MAX_TOOL_ITERATIONS: usize = 8;
const SYSTEM_PROMPT: &str = "You are Sub Rosa's assistant on the user's device, and you can both read and write the user's notes.

Finding things: search_notes takes a short keyword query and returns a window around each match, with note ids. list_recent_notes answers questions about a period rather than a keyword. Neither gives you a note's full text: when the question is about what a note actually says (summarising it, listing its decisions, quoting it), call read_note with the id. Prefer looking in the notes before answering anything about the user's meetings, decisions, or plans. Call search_calendar when the question is about the user's day, a meeting, or who they are seeing. Call web_search when the question needs current or public information, then fetch_page on the most promising result when the snippets do not settle it. Cite the pages you used by name.

Acting: create_note when the user asks you to write something down or save a summary, append_to_note to add to an existing one, remember for a lasting preference or a fact they ask you to keep. Never use a write tool to answer a question, and never write without being asked.

Link cards: when your answer draws on web results, you may end it with one fenced code block whose info string is subrosa:links and whose body is a single JSON object shaped {\"v\":1,\"title\":\"Sources\",\"links\":[{\"title\":\"…\",\"url\":\"https://…\",\"snippet\":\"…\"}]}. The app renders it as a tappable card. Copy titles, urls and snippets verbatim from web_search results — never invent or edit a URL — keep it to the links you actually used (6 at most, https only), and write your prose normally around the block.

Place cards: when you answer with places_search results, embed them as one fenced block whose info string is subrosa:places and whose body is {\"v\":1,\"title\":\"…\",\"attribution\":\"<the tool result's provider>\",\"places\":[{\"name\",\"lat\",\"lng\",\"address\"?,\"category\"?,\"rating\"?,\"reviews\"?,\"url\"?,\"photoRef\"?,\"note\"?}]}. The app draws the map and the list. Copy name, lat, lng, address, category, rating, reviews, url and photoRef verbatim from the tool result; \"note\" is yours — one short helpful sentence per place at most. Never invent a place or a coordinate.

Note cards: when your answer rests on the user's own notes, you may end it with one fenced block whose info string is subrosa:notes and whose body is {\"v\":1,\"title\":\"From your notes\",\"notes\":[{\"id\":\"…\",\"title\":\"…\",\"snippet\":\"…\"}]}. The app opens the note when the user taps the card. Use the ids and titles exactly as search_notes, read_note or list_recent_notes returned them — never invent a note id — and list only the notes your answer actually used.

Follow-up cards: after a meeting note, or when the user agrees to something, you may end your reply with one fenced block whose info string is subrosa:proposal and whose body is {\"v\":1,\"proposalId\":\"<a new short id>\",\"title\":\"Follow-ups\",\"actions\":[{\"kind\":\"reminder\",\"id\":\"a1\",\"label\":\"…\",\"due\":\"<RFC3339>\"},{\"kind\":\"event\",\"id\":\"a2\",\"label\":\"…\",\"start\":\"<RFC3339>\"},{\"kind\":\"note\",\"id\":\"a3\",\"label\":\"…\",\"noteId\":\"<a real note id>\",\"text\":\"…\"}]}. Nothing happens until the user taps a card, so propose rather than announce: never write as if the reminder already exists. Five actions at most, only ones the conversation actually calls for, and never invent a note id.

Answer in the user's language, concisely, in plain prose or simple markdown. If a search comes back empty, say what you looked for.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiteStatusDto {
    pub task_id: String,
    /// "thinking" | "searching-notes" | "searching-web" | "searching-memory"
    /// | "searching-places" | "searching-calendar" | "reading-note"
    /// | "writing-note" | "remembering"
    /// | "reading-page"
    pub stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiteRunRequest {
    pub task_id: String,
    /// Chat model override; the proxy default applies when omitted.
    pub model: Option<String>,
    /// Attachments for the current turn only. Persisted messages keep a text
    /// marker; re-sending images on every later turn would multiply cost.
    pub attachments: Option<Vec<AgentLiteAttachment>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiteAttachment {
    /// "image" (`data` is a data URI) or "text" (`data` is the file content).
    pub kind: String,
    pub name: String,
    pub data: String,
}

/// Keep attachment payloads sane: vision models take a handful of images and
/// long file dumps crowd out the conversation.
const MAX_IMAGE_ATTACHMENTS: usize = 4;
const MAX_TEXT_ATTACHMENT_CHARS: usize = 60_000;

/// Run one assistant turn for the task: read the persisted conversation,
/// loop through tool calls, persist the final assistant message.
#[tauri::command]
pub async fn agent_lite_run(
    app: AppHandle,
    request: AgentLiteRunRequest,
) -> Result<crate::domain::types::AgentTaskDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let task_id = request.task_id;
    let model = request.model.filter(|value| !value.trim().is_empty());
    let attachments = request.attachments.unwrap_or_default();
    // Locking the screen mid-turn suspends the process and used to kill the
    // reply; hold a background task for the whole turn (every tool-loop
    // request included) so it survives the lock. If the lock outlasts the
    // window, the persisted user message is what lets `resume_interrupted_turns`
    // pick the turn back up.
    let _background = crate::ios_background::BackgroundTask::begin("agent-lite-turn");
    let _claim = TurnClaim::hold(&task_id);
    repos
        .update_agent_task_status(&task_id, AgentTaskStatus::Running, Some("Working."), None)
        .await?;

    let result = run_turn(&app, &repos, &task_id, model.as_deref(), &attachments).await;
    match result {
        Ok(answer) => {
            repos
                .add_agent_message(&task_id, AgentMessageRole::Assistant, &answer)
                .await?;
            repos
                .update_agent_task_status(
                    &task_id,
                    AgentTaskStatus::Completed,
                    Some("Completed."),
                    None,
                )
                .await?;
            let task = repos.get_agent_task(&task_id).await?;
            let _ = app.emit(AGENT_LITE_DONE_EVENT, &task);
            // Best-effort memory extraction (every 3rd assistant reply);
            // runs detached so a slow or failing extraction never delays
            // the answer the user is already reading.
            crate::memory::extract::maybe_extract_after_agent_lite_turn(&app, task_id.clone());
            Ok(task)
        }
        Err(error) => {
            repos
                .update_agent_task_status(
                    &task_id,
                    AgentTaskStatus::Failed,
                    None,
                    Some(&error.message),
                )
                .await?;
            let task = repos.get_agent_task(&task_id).await?;
            let _ = app.emit(AGENT_LITE_DONE_EVENT, &task);
            Err(error)
        }
    }
}

/// Task ids with a turn running in this process right now. A turn only becomes
/// resumable once nobody is driving it — otherwise the resume sweep would
/// answer the same message a second time.
static RUNNING_TURNS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

struct TurnClaim(String);

impl TurnClaim {
    fn hold(task_id: &str) -> Self {
        claims().insert(task_id.to_string());
        Self(task_id.to_string())
    }
}

impl Drop for TurnClaim {
    fn drop(&mut self) {
        claims().remove(&self.0);
    }
}

fn claims() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    RUNNING_TURNS
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// Re-run the chat turns a suspension cut in half: their last persisted message
/// is the user's, so the reply was never written and re-running is the same
/// work, not a duplicate. Called from [`crate::background::sweep`].
pub async fn resume_interrupted_turns(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(task_ids) = repos.agent_tasks_awaiting_reply().await else {
        return;
    };
    let pending: Vec<String> = {
        let running = claims();
        task_ids
            .into_iter()
            .filter(|id| !running.contains(id))
            .collect()
    };
    if pending.is_empty() {
        return;
    }
    let _background = crate::ios_background::BackgroundTask::begin("agent-lite-resume");
    for task_id in pending {
        let _claim = TurnClaim::hold(&task_id);
        let model = repos
            .get_agent_task(&task_id)
            .await
            .ok()
            .and_then(|task| task.model);
        // Attachments belong to the original turn only and are not persisted,
        // so the resumed turn runs on the conversation text alone.
        match run_turn(app, &repos, &task_id, model.as_deref(), &[]).await {
            Ok(answer) => {
                let _ = repos
                    .add_agent_message(&task_id, AgentMessageRole::Assistant, &answer)
                    .await;
                let _ = repos
                    .update_agent_task_status(
                        &task_id,
                        AgentTaskStatus::Completed,
                        Some("Completed."),
                        None,
                    )
                    .await;
                if let Ok(task) = repos.get_agent_task(&task_id).await {
                    let _ = app.emit(AGENT_LITE_DONE_EVENT, &task);
                }
                crate::memory::extract::maybe_extract_after_agent_lite_turn(app, task_id.clone());
                let _ = app
                    .notification()
                    .builder()
                    .title("Your assistant replied")
                    .body(answer.chars().take(120).collect::<String>())
                    .extra(
                        crate::destinations::EXTRA_KEY,
                        crate::destinations::chat(Some(&task_id)),
                    )
                    .show();
            }
            // Still failing: leave the task running so a later sweep retries
            // rather than showing the user an error they cannot act on.
            Err(error) => {
                eprintln!("agent-lite resume for {task_id} failed: {}", error.message);
            }
        }
    }
}

async fn run_turn(
    app: &AppHandle,
    repos: &crate::db::repositories::Repositories,
    task_id: &str,
    model: Option<&str>,
    attachments: &[AgentLiteAttachment],
) -> Result<String, AppError> {
    let task = repos.get_agent_task(task_id).await?;
    // Cross-conversation memory rides in the system prompt, rebuilt every
    // turn so facts extracted a moment ago apply immediately. System messages
    // are never persisted to agent_messages, so this cannot leak into history.
    let memory_block = crate::memory::prompt_block(repos).await;
    let mut messages = vec![serde_json::json!({
        "role": "system",
        "content": build_system_prompt(memory_block.as_deref()),
    })];
    for message in &task.messages {
        let role = match message.role {
            AgentMessageRole::User => "user",
            AgentMessageRole::Assistant => "assistant",
            AgentMessageRole::System => continue,
        };
        messages.push(serde_json::json!({
            "role": role,
            "content": message.content,
        }));
    }
    if !attachments.is_empty() {
        attach_to_last_user_message(&mut messages, attachments);
    }

    // Several upstream vision routes reject tool-bearing requests outright
    // (502 upstream_provider_failed), which is why image turns used to drop
    // every tool. Dropping them unconditionally also means a photo can never
    // be cross-referenced with the user's notes, so instead we offer the tools
    // and fall back once if the route turns out to be one of the strict ones.
    let has_images = attachments.iter().any(|a| a.kind == "image");
    let mut tools_withheld = false;
    // Streaming is what makes the reply appear as it is written instead of
    // landing whole after ten to thirty seconds. It is also the newer path, so
    // any route that answers a streamed request with nothing usable gets the
    // turn replayed buffered rather than an error.
    let mut stream_withheld = false;

    for _iteration in 0..=MAX_TOOL_ITERATIONS {
        emit_status(app, task_id, "thinking", None);
        let mut body = if tools_withheld {
            serde_json::json!({
                "messages": messages,
                "temperature": 0.3,
                "max_tokens": 4000,
            })
        } else {
            serde_json::json!({
                "messages": messages,
                "tools": tool_definitions(crate::memory::settings().enabled),
                "tool_choice": "auto",
                "temperature": 0.3,
                "max_tokens": 4000,
            })
        };
        if let (Some(model), Some(object)) = (model, body.as_object_mut()) {
            object.insert("model".to_string(), serde_json::json!(model));
        }
        if !stream_withheld {
            if let Some(object) = body.as_object_mut() {
                object.insert("stream".to_string(), serde_json::json!(true));
            }
        }
        let response = june_api::proxy_agent_chat_completions(body).await?;
        if !(200..300).contains(&response.status) {
            let status = response.status;
            let body = response.collect_body().await.unwrap_or_default();
            let detail = readable_upstream_error(&body);
            // 402 means the user's Carpe Diem balance (not the provider)
            // rejected the request — say so instead of a raw status line. The
            // wording deliberately matches isInsufficientCreditsMessage in
            // src/lib/errors.ts.
            if status == 402 || detail == "insufficient_credits" {
                return Err(AppError::new(
                    "agent_lite_credits",
                    "Your Carpe Diem balance is too low, or your active payment rail is empty. Check Carpe Diem in Settings (prepaid account and credits are billed separately).",
                ));
            }
            // 429 (rate-limited) or 503 (capacity / MODEL_INFRA_SATURATED — the
            // dominant flavour for a hot model) means the model is momentarily
            // busy, NOT that the request failed — tell the user to wait and retry
            // or switch models instead of showing a raw status line. The June API
            // sidecar surfaces both as `upstream_rate_limited` (see
            // error_for_status); a direct provider body reads "rate limit
            // reached" / "saturated upstream". The check mirrors
            // isUpstreamRateLimitedMessage in src/lib/errors.ts.
            if status == 429 || status == 503 || is_rate_limit_detail(&detail) {
                return Err(AppError::new(
                    "agent_lite_rate_limited",
                    "This model is busy right now. Wait a few seconds and send again, or switch to another model.",
                ));
            }
            // A genuine provider failure (upstream 500/502/504 the sidecar's
            // backed-off retries could not clear). Deliberately NOT worded as
            // "busy" (ADR-0012), but the failure is usually transient on the
            // gateway's side, so guide the user to retry or switch models
            // instead of dumping `upstream_provider_failed`. Mirrors
            // isUpstreamProviderFailureMessage in src/lib/errors.ts.
            if is_provider_failure_detail(&detail) {
                // The known-strict vision routes fail exactly here. Retry the
                // same turn once without the tool declarations rather than
                // handing the user an error for a question the model can
                // answer from the image alone.
                if has_images && !tools_withheld {
                    tracing::warn!("vision route rejected tools, retrying without them");
                    tools_withheld = true;
                    continue;
                }
                return Err(AppError::new(
                    "agent_lite_provider_failed",
                    "The model provider could not answer this message. Send again, or switch to another model.",
                ));
            }
            // 422 `model_not_priced` is structural, not transient: the June
            // API's pricing table doubles as its allowlist, and this picker
            // reads Carpe Diem's own catalog instead, so it can offer a model
            // the backend will refuse. Retrying never helps, so say the one
            // thing that does.
            if status == 422 && detail == "model_not_priced" {
                return Err(AppError::new(
                    "agent_lite_model_unavailable",
                    "That model is not available right now. Open the model list and pick another one.",
                ));
            }
            return Err(AppError::new(
                "agent_lite_failed",
                format!("The assistant request failed with status {status}: {detail}"),
            ));
        }
        // A route that ignored `stream` answers with ordinary JSON; read
        // whichever shape actually came back rather than trusting the request.
        let streamed = !stream_withheld && response.content_type.contains("event-stream");
        let message = if streamed {
            let reply = collect_stream(app, task_id, response).await?;
            if reply.is_empty() {
                // Nothing usable came out of the stream. Replay this same
                // iteration buffered before giving up on the turn.
                tracing::warn!("streamed completion was empty, retrying buffered");
                stream_withheld = true;
                continue;
            }
            reply.into_message()
        } else {
            let body = response.collect_body().await?;
            let value: serde_json::Value = serde_json::from_slice(&body)
                .map_err(|error| AppError::new("agent_lite_invalid", error.to_string()))?;
            let mut message = value
                .pointer("/choices/0/message")
                .cloned()
                .ok_or_else(|| {
                    AppError::new("agent_lite_invalid", "The assistant returned no message.")
                })?;
            // `extract_chat_completion_text` knows the shapes the rails answer
            // with (ADR-0015); prefer it over reading `content` directly.
            if let (Some(object), Some(text)) = (
                message.as_object_mut(),
                june_api::extract_chat_completion_text(&value),
            ) {
                object.insert("content".to_string(), serde_json::json!(text));
            }
            message
        };

        let tool_calls = message
            .get("tool_calls")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        if tool_calls.is_empty() {
            let text = message
                .get("content")
                .and_then(serde_json::Value::as_str)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .ok_or_else(|| {
                    AppError::new(
                        "agent_lite_empty",
                        "The assistant returned an empty answer.",
                    )
                })?;
            return Ok(text);
        }

        messages.push(message);
        for tool_call in &tool_calls {
            let id = tool_call
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = tool_call
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            // The whole argument object, not just a `query` string: tools that
            // address a specific note (or write one) need more than one field,
            // and a model that answers with an unparseable blob gets an empty
            // object rather than a silently dropped call.
            let arguments = tool_call
                .pointer("/function/arguments")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("{}");
            let args = serde_json::from_str::<serde_json::Value>(arguments)
                .unwrap_or_else(|_| serde_json::json!({}));
            let content = execute_tool(app, repos, task_id, &name, &args).await;
            messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": id,
                "content": content,
            }));
        }
    }

    Err(AppError::new(
        "agent_lite_tool_loop",
        "The assistant used too many search rounds without answering. Try rephrasing.",
    ))
}

/// How many web results to ask for. The upstream snippets run to a couple of
/// thousand characters each, so this is a context budget, not a preference.
const WEB_SEARCH_RESULTS: u32 = 5;
/// Matches the chat-block places card cap (see MAX_PLACES in chat-blocks.ts).
const PLACES_SEARCH_RESULTS: u32 = 6;
/// Per-result snippet budget after cleaning.
const WEB_SNIPPET_CHARS: usize = 400;
/// A fetched page is the one tool output worth a large slice of context.
const WEB_PAGE_CHARS: usize = 12_000;

/// Strip the markup the search provider highlights matches with, collapse
/// whitespace, and drop the duplicate paragraph it tends to append.
fn clean_snippet(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    // The provider repeats the matched passage after a blank line; the second
    // copy is pure context cost.
    let first = text
        .split("\n\n")
        .find(|part| !part.trim().is_empty())
        .unwrap_or(&text);
    let collapsed = first.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(WEB_SNIPPET_CHARS).collect()
}

/// Turn the web handler's envelope into the smallest thing a model can cite
/// from: title, url, date, and a trimmed snippet.
///
/// This used to forward the raw body truncated to 6000 characters. With five
/// results at ~2000 characters of marked-up, duplicated snippet each, that cut
/// the JSON mid-string: the model saw a broken fragment and silently lost most
/// of the results.
/// The calendar as the model reads it: one line per event, filtered by the
/// query when there is one. Deliberately terse — this is retrieval output,
/// not a planning dump, and it is the only shape a calendar ever takes
/// inside a prompt.
fn summarize_calendar_events(events: &[crate::calendar::CalendarEventDto], query: &str) -> String {
    let needle = query.trim().to_lowercase();
    let matching: Vec<&crate::calendar::CalendarEventDto> = events
        .iter()
        .filter(|event| {
            needle.is_empty()
                || event.title.to_lowercase().contains(&needle)
                || event
                    .attendees
                    .iter()
                    .any(|name| name.to_lowercase().contains(&needle))
        })
        .take(20)
        .collect();
    if matching.is_empty() {
        return "Nothing in the calendar matches that.".to_string();
    }
    let items: Vec<serde_json::Value> = matching
        .iter()
        .map(|event| {
            serde_json::json!({
                "title": event.title,
                "start": crate::domain::types::rfc3339_from_epoch_secs(event.start),
                "end": crate::domain::types::rfc3339_from_epoch_secs(event.end),
                "allDay": event.all_day,
                "attendees": event.attendees,
            })
        })
        .collect();
    serde_json::to_string(&items)
        .unwrap_or_else(|_| "Calendar lookup failed to serialize.".to_string())
}

/// Reshapes `/v1/web/places` into the string the model reads: the provider id
/// (it becomes the block's attribution) plus the places as-is. The server
/// already curated and capped the rows, so nothing is trimmed here.
fn summarize_places_results(body: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return "The places search returned an unreadable response.".to_string();
    };
    let places = value
        .pointer("/data/places")
        .and_then(serde_json::Value::as_array);
    let Some(places) = places else {
        return "The places search returned no results.".to_string();
    };
    if places.is_empty() {
        return "The places search returned no results.".to_string();
    }
    let provider = value
        .pointer("/data/provider")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("osm");
    serde_json::to_string(&serde_json::json!({
        "provider": provider,
        "places": places,
    }))
    .unwrap_or_else(|_| "Places search failed to serialize.".to_string())
}

fn summarize_web_results(body: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return "The web search returned an unreadable response.".to_string();
    };
    let results = value
        .pointer("/data/results")
        .and_then(serde_json::Value::as_array);
    let Some(results) = results else {
        return "The web search returned no results.".to_string();
    };
    if results.is_empty() {
        return "The web search returned no results.".to_string();
    }
    let items: Vec<serde_json::Value> = results
        .iter()
        .map(|result| {
            let mut item = serde_json::json!({
                "title": result.get("title").and_then(serde_json::Value::as_str).unwrap_or(""),
                "url": result.get("url").and_then(serde_json::Value::as_str).unwrap_or(""),
                "snippet": clean_snippet(
                    result.get("snippet").and_then(serde_json::Value::as_str).unwrap_or(""),
                ),
            });
            if let Some(published) = result
                .get("publishedAt")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
            {
                item["publishedAt"] = serde_json::json!(published);
            }
            item
        })
        .collect();
    serde_json::to_string(&items)
        .unwrap_or_else(|_| "The web search failed to serialize.".to_string())
}

/// Read a string argument, treating blank as absent — models routinely pass
/// `""` for a field they mean to omit.
fn arg_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Read a numeric argument. Models sometimes send `"5"` instead of `5`.
fn arg_i64(args: &serde_json::Value, key: &str) -> Option<i64> {
    let value = args.get(key)?;
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

/// A tool result has to leave room for the conversation it rides back into.
fn truncate(text: String, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text;
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}\n\n[truncated]")
}

/// The webview refreshes its note list on this, so a note the assistant just
/// wrote shows up without a manual pull to refresh.
pub const AGENT_LITE_NOTES_CHANGED_EVENT: &str = "agent-lite://notes-changed";

/// An assistant message rebuilt from a stream of deltas.
#[derive(Default)]
struct StreamedReply {
    content: String,
    /// Indexed by the `index` the deltas carry: `(id, name, arguments)`, each
    /// arrived in fragments.
    calls: Vec<(String, String, String)>,
}

impl StreamedReply {
    fn is_empty(&self) -> bool {
        self.content.trim().is_empty() && self.calls.is_empty()
    }

    /// The same shape the buffered path produces, so the tool loop does not
    /// care which way the answer arrived.
    fn into_message(self) -> serde_json::Value {
        let tool_calls: Vec<serde_json::Value> = self
            .calls
            .into_iter()
            .filter(|(_, name, _)| !name.is_empty())
            .map(|(id, name, arguments)| {
                serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        // An empty fragment stream still has to parse.
                        "arguments": if arguments.is_empty() { "{}".to_string() } else { arguments },
                    }
                })
            })
            .collect();
        let mut message = serde_json::json!({
            "role": "assistant",
            "content": self.content,
        });
        if !tool_calls.is_empty() {
            message["tool_calls"] = serde_json::Value::Array(tool_calls);
        }
        message
    }

    fn apply(&mut self, delta: &serde_json::Value) {
        if let Some(text) = delta.get("content").and_then(serde_json::Value::as_str) {
            self.content.push_str(text);
        }
        let Some(calls) = delta
            .get("tool_calls")
            .and_then(serde_json::Value::as_array)
        else {
            return;
        };
        for call in calls {
            // Deltas address a slot by index and fill it in over several
            // frames: the id and name arrive once, the arguments in pieces.
            let index = call
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as usize;
            if self.calls.len() <= index {
                self.calls
                    .resize(index + 1, (String::new(), String::new(), String::new()));
            }
            let slot = &mut self.calls[index];
            if let Some(id) = call.get("id").and_then(serde_json::Value::as_str) {
                if !id.is_empty() {
                    slot.0 = id.to_string();
                }
            }
            if let Some(name) = call
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
            {
                if !name.is_empty() {
                    slot.1 = name.to_string();
                }
            }
            if let Some(arguments) = call
                .pointer("/function/arguments")
                .and_then(serde_json::Value::as_str)
            {
                slot.2.push_str(arguments);
            }
        }
    }
}

/// Read a server-sent completion stream to the end, emitting the reply text to
/// the webview as it arrives.
///
/// Batched one emit per network chunk rather than per token: a chunk already
/// groups whatever arrived together, and an event per token would spend more
/// time crossing the IPC boundary than rendering.
async fn collect_stream(
    app: &AppHandle,
    task_id: &str,
    mut response: june_api::AgentChatCompletionsResponse,
) -> Result<StreamedReply, AppError> {
    let mut reply = StreamedReply::default();
    let mut buffer = String::new();
    while let Some(chunk) = response.chunk().await? {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        let before = reply.content.len();
        // Frames are newline-delimited; keep the tail, which may be a partial
        // line that the next chunk completes.
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim().to_string();
            buffer.drain(..newline + 1);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            if let Some(delta) = frame.pointer("/choices/0/delta") {
                reply.apply(delta);
            }
        }
        if reply.content.len() > before {
            let _ = app.emit(
                AGENT_LITE_DELTA_EVENT,
                serde_json::json!({
                    "taskId": task_id,
                    "text": &reply.content[before..],
                }),
            );
        }
    }
    Ok(reply)
}

async fn execute_tool(
    app: &AppHandle,
    repos: &crate::db::repositories::Repositories,
    task_id: &str,
    name: &str,
    args: &serde_json::Value,
) -> String {
    let query = arg_str(args, "query").unwrap_or_default();
    match name {
        "search_notes" => {
            emit_status(app, task_id, "searching-notes", Some(query.clone()));
            match repos.search_note_context(&query, 6).await {
                Ok(snippets) if snippets.is_empty() => {
                    "No matching notes or transcripts were found.".to_string()
                }
                Ok(snippets) => serde_json::to_string(&snippets)
                    .unwrap_or_else(|_| "Search failed to serialize.".to_string()),
                Err(error) => format!("Note search failed: {error}"),
            }
        }
        "search_memories" => {
            emit_status(app, task_id, "searching-memory", Some(query.clone()));
            if !crate::memory::settings().enabled {
                return "Memory is disabled in the user's settings.".to_string();
            }
            match crate::memory::recall::recall(repos, &query, 8).await {
                Ok(memories) if memories.is_empty() => {
                    "No stored memories match that query.".to_string()
                }
                Ok(memories) => {
                    let items: Vec<serde_json::Value> = memories
                        .iter()
                        .map(|memory| {
                            serde_json::json!({
                                "text": memory.text,
                                "importance": memory.importance,
                                "createdAt": memory.created_at,
                            })
                        })
                        .collect();
                    serde_json::to_string(&items)
                        .unwrap_or_else(|_| "Memory search failed to serialize.".to_string())
                }
                Err(error) => format!("Memory search failed: {}", error.message),
            }
        }
        "web_search" => {
            emit_status(app, task_id, "searching-web", Some(query.clone()));
            // The June API web handler requires a non-empty `requestId` (it
            // scopes metering idempotency); omit it and the call is rejected
            // with a 400 before it ever reaches the web. A fresh id per call is
            // correct here — agent-lite does not retry the tool.
            let body = serde_json::json!({
                "query": query,
                "limit": WEB_SEARCH_RESULTS,
                "requestId": uuid::Uuid::new_v4().to_string(),
            });
            match june_api::forward_web_request("/v1/web/search", &body).await {
                Ok(response) if (200..300).contains(&response.status) => {
                    summarize_web_results(&response.body)
                }
                Ok(response) => format!("Web search failed with status {}.", response.status),
                Err(error) => format!("Web search failed: {}", error.message),
            }
        }
        "search_calendar" => {
            emit_status(app, task_id, "searching-calendar", Some(query.clone()));
            // Retrieval, never injection: the model asks about a day, it is
            // never handed the planning. Window defaults to today and is
            // clamped to a week by the command itself.
            let days = arg_i64(args, "days").unwrap_or(1).clamp(-7, 7);
            let now = chrono::Utc::now().timestamp();
            let (start, end) = if days >= 0 {
                (now - 12 * 3600, now + days.max(1) * 86_400)
            } else {
                (now + days * 86_400, now + 12 * 3600)
            };
            match crate::calendar::calendar_events_between(crate::calendar::CalendarWindowRequest {
                start,
                end,
            }) {
                Ok(events) if events.is_empty() => {
                    "Nothing in the calendar for that window.".to_string()
                }
                Ok(events) => summarize_calendar_events(&events, &query),
                Err(error) => format!("Calendar lookup failed: {}", error.message),
            }
        }
        "places_search" => {
            emit_status(app, task_id, "searching-places", Some(query.clone()));
            // No requestId: the places surface is unmetered (see the June API
            // handler), so there is no idempotency key to scope.
            let mut body = serde_json::json!({
                "query": query,
                "limit": PLACES_SEARCH_RESULTS,
            });
            if let Some(near) = args.get("near") {
                let lat = near.get("lat").and_then(serde_json::Value::as_f64);
                let lng = near.get("lng").and_then(serde_json::Value::as_f64);
                if let (Some(lat), Some(lng)) = (lat, lng) {
                    body["near"] = serde_json::json!({ "lat": lat, "lng": lng });
                }
            }
            match june_api::forward_places_request(&body).await {
                Ok(response) if (200..300).contains(&response.status) => {
                    summarize_places_results(&response.body)
                }
                Ok(response) => format!("Places search failed with status {}.", response.status),
                Err(error) => format!("Places search failed: {}", error.message),
            }
        }
        // Searching without being able to open anything is half a capability:
        // the snippets are a few sentences, so anything that needs the actual
        // page (a doc, an article, a changelog) was previously unreachable.
        "fetch_page" => {
            let Some(url) = arg_str(args, "url") else {
                return "fetch_page needs a url from a web_search result.".to_string();
            };
            emit_status(app, task_id, "reading-page", Some(url.clone()));
            let body = serde_json::json!({
                "url": url,
                "requestId": uuid::Uuid::new_v4().to_string(),
            });
            match june_api::forward_web_request("/v1/web/fetch", &body).await {
                Ok(response) if (200..300).contains(&response.status) => {
                    let content = serde_json::from_slice::<serde_json::Value>(&response.body)
                        .ok()
                        .and_then(|value| {
                            value
                                .pointer("/data/content")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                        });
                    match content {
                        Some(text) if !text.trim().is_empty() => truncate(text, WEB_PAGE_CHARS),
                        // A page that blocks automated access answers 200 with
                        // nothing useful; say so rather than returning "".
                        _ => "That page returned no readable text.".to_string(),
                    }
                }
                // The handler answers 400 for a URL the upstream refuses (a
                // site that blocks scraping); that is about this URL, not a
                // broken tool, so the model can try another result.
                Ok(response) if response.status == 400 => {
                    "That page could not be read. Try another result.".to_string()
                }
                Ok(response) => {
                    format!("Fetching the page failed with status {}.", response.status)
                }
                Err(error) => format!("Fetching the page failed: {}", error.message),
            }
        }
        // `search_notes` answers with a keyword window, which is enough to find
        // a note and never enough to reason about one. This is what makes
        // "summarise Tuesday's meeting" answerable.
        "read_note" => {
            let Some(note_id) = arg_str(args, "note_id") else {
                return "read_note needs a note_id from search_notes or list_recent_notes."
                    .to_string();
            };
            emit_status(app, task_id, "reading-note", None);
            match repos.get_note(&note_id).await {
                Ok(note) => {
                    let content = note
                        .edited_content
                        .or(note.generated_content)
                        .unwrap_or_default();
                    let transcript = note
                        .transcript
                        .map(|transcript| transcript.text)
                        .unwrap_or_default();
                    truncate(
                        serde_json::json!({
                            "noteId": note.id,
                            "title": note.title,
                            "createdAt": note.created_at,
                            "updatedAt": note.updated_at,
                            "status": note.processing_status.as_db(),
                            "note": content,
                            "transcript": transcript,
                        })
                        .to_string(),
                        24_000,
                    )
                }
                Err(error) => format!("No note with that id ({error})."),
            }
        }
        // Lets the model answer "what did I work on this week" without guessing
        // keywords, and gives it ids to follow up with read_note.
        "list_recent_notes" => {
            emit_status(app, task_id, "reading-note", None);
            let limit = arg_i64(args, "limit").unwrap_or(10).clamp(1, 30);
            match repos.list_notes(None, limit, None).await {
                Ok(response) => {
                    let items: Vec<serde_json::Value> = response
                        .items
                        .iter()
                        .map(|note| {
                            serde_json::json!({
                                "noteId": note.id,
                                "title": note.title,
                                "preview": note.preview,
                                "createdAt": note.created_at,
                            })
                        })
                        .collect();
                    if items.is_empty() {
                        "There are no notes yet.".to_string()
                    } else {
                        serde_json::to_string(&items)
                            .unwrap_or_else(|_| "Listing failed to serialize.".to_string())
                    }
                }
                Err(error) => format!("Listing notes failed: {error}"),
            }
        }
        "create_note" => {
            let Some(content) = arg_str(args, "content") else {
                return "create_note needs content.".to_string();
            };
            let title = arg_str(args, "title").unwrap_or_else(|| "Untitled note".to_string());
            emit_status(app, task_id, "writing-note", Some(title.clone()));
            match repos.create_note(None).await {
                Ok(note) => match repos
                    .update_note(&note.id, Some(title.clone()), Some(content), None)
                    .await
                {
                    Ok(saved) => {
                        let _ = app.emit(AGENT_LITE_NOTES_CHANGED_EVENT, ());
                        format!("Created note \"{}\" (noteId {}).", saved.title, saved.id)
                    }
                    Err(error) => format!("Creating the note failed: {error}"),
                },
                Err(error) => format!("Creating the note failed: {error}"),
            }
        }
        "append_to_note" => {
            let (Some(note_id), Some(addition)) =
                (arg_str(args, "note_id"), arg_str(args, "content"))
            else {
                return "append_to_note needs a note_id and content.".to_string();
            };
            emit_status(app, task_id, "writing-note", None);
            match repos.get_note(&note_id).await {
                Ok(note) => {
                    // Append to what the user would see: their own edits when
                    // they have any, the generated note otherwise. Writing to
                    // `edited_content` is what the note editor reads back.
                    let existing = note
                        .edited_content
                        .or(note.generated_content)
                        .unwrap_or_default();
                    let merged = if existing.trim().is_empty() {
                        addition
                    } else {
                        format!("{}\n\n{}", existing.trim_end(), addition)
                    };
                    match repos.update_note(&note_id, None, Some(merged), None).await {
                        Ok(saved) => {
                            let _ = app.emit(AGENT_LITE_NOTES_CHANGED_EVENT, ());
                            format!("Appended to \"{}\".", saved.title)
                        }
                        Err(error) => format!("Updating the note failed: {error}"),
                    }
                }
                Err(error) => format!("No note with that id ({error})."),
            }
        }
        // "Remember that I…" only worked by accident before, when the periodic
        // extractor happened to pick the fact up two turns later.
        "remember" => {
            let Some(text) = arg_str(args, "text") else {
                return "remember needs the fact to store.".to_string();
            };
            if !crate::memory::settings().enabled {
                return "Memory is disabled in the user's settings.".to_string();
            }
            emit_status(app, task_id, "remembering", Some(text.clone()));
            match repos.memory_with_text_exists(&text).await {
                Ok(true) => "That fact is already remembered.".to_string(),
                _ => match repos
                    .insert_memory(&text, crate::domain::types::MemorySource::Manual, 3)
                    .await
                {
                    Ok(_) => format!("Remembered: {text}"),
                    Err(error) => format!("Storing the memory failed: {error}"),
                },
            }
        }
        other => format!("Unknown tool: {other}."),
    }
}

fn tool_definitions(memory_enabled: bool) -> serde_json::Value {
    let mut tools = vec![
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "search_notes",
                "description": "Search the user's local meeting notes and transcripts. Returns matching snippets with note titles and dates.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Short keyword query (2 to 6 words), in the language of the notes."
                        }
                    },
                    "required": ["query"]
                }
            }
        }),
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the public web for current information.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Web search query." }
                    },
                    "required": ["query"]
                }
            }
        }),
    ];
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "search_calendar",
            "description": "Look at the user's calendar for a day: what meetings there are, when, and who is invited. Use it when the question is about their schedule, or to find which meeting a note belongs to. It reads the device's calendar and returns only the window you ask for.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Optional words to filter on (a title or an attendee). Leave empty for the whole window."
                    },
                    "days": {
                        "type": "integer",
                        "description": "Days ahead (positive) or back (negative), at most 7. 0 or 1 means today."
                    }
                },
                "required": []
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "places_search",
            "description": "Find real-world places (businesses, offices, restaurants, landmarks) by name or kind, optionally near a point. Returns names, coordinates, addresses and categories. When you answer with these results, embed them as a subrosa:places chat block, copying the JSON fields verbatim.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to look for, including the area when known (e.g. 'expert comptable Annemasse')."
                    },
                    "near": {
                        "type": "object",
                        "properties": {
                            "lat": { "type": "number" },
                            "lng": { "type": "number" }
                        },
                        "required": ["lat", "lng"],
                        "description": "Bias results toward this point."
                    }
                },
                "required": ["query"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "fetch_page",
            "description": "Open a web page and read its text. Use it after web_search when the snippets do not actually answer the question: the snippet is a couple of sentences, the page is the source. Also use it when the user gives you a URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Full URL, normally taken from a web_search result."
                    }
                },
                "required": ["url"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "read_note",
            "description": "Read one note in full: its written note and its transcript. Use this after search_notes or list_recent_notes whenever the question is about what a note actually says (summarising it, listing its decisions, quoting it). Search only returns a short window around a keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "note_id": {
                        "type": "string",
                        "description": "The noteId from a previous search_notes or list_recent_notes result."
                    }
                },
                "required": ["note_id"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "list_recent_notes",
            "description": "List the user's most recent notes, newest first, with their ids, titles and previews. Use this for questions about a period rather than a keyword (\"what did I do this week\"), or to find a note when you do not know what to search for.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "How many notes to list, 1 to 30. Defaults to 10."
                    }
                }
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "create_note",
            "description": "Create a new note in the user's notes. Use it when the user asks you to write something down, draft something, or save a summary. Do not use it to answer a question: answer in the conversation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short title, in the user's language." },
                    "content": { "type": "string", "description": "The note body, in markdown." }
                },
                "required": ["content"]
            }
        }
    }));
    tools.push(serde_json::json!({
        "type": "function",
        "function": {
            "name": "append_to_note",
            "description": "Add text to the end of an existing note. Use it when the user asks to add something to a note that already exists.",
            "parameters": {
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "The noteId to append to." },
                    "content": { "type": "string", "description": "The text to add, in markdown." }
                },
                "required": ["note_id", "content"]
            }
        }
    }));
    if memory_enabled {
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "remember",
                "description": "Store a durable fact about the user so it is available in every future conversation. Use it when the user explicitly asks you to remember something, or states a lasting preference or constraint. Do not use it for one-off details of the current conversation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "The fact, as one self-contained sentence in the user's language."
                        }
                    },
                    "required": ["text"]
                }
            }
        }));
        tools.push(serde_json::json!({
            "type": "function",
            "function": {
                "name": "search_memories",
                "description": "Search durable facts remembered about the user from past conversations (preferences, projects, constraints). The most important facts are already in your context; use this to look up more when the user references something from an earlier conversation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Short keyword query, in the user's language."
                        }
                    },
                    "required": ["query"]
                }
            }
        }));
    }
    serde_json::Value::Array(tools)
}

/// The per-turn system prompt: the static instructions plus, when memory is
/// enabled and non-empty, the user's remembered facts.
fn build_system_prompt(memory_block: Option<&str>) -> String {
    match memory_block {
        Some(block) => format!("{SYSTEM_PROMPT}\n\n{block}"),
        None => SYSTEM_PROMPT.to_string(),
    }
}

fn emit_status(app: &AppHandle, task_id: &str, stage: &str, detail: Option<String>) {
    let _ = app.emit(
        AGENT_LITE_STATUS_EVENT,
        AgentLiteStatusDto {
            task_id: task_id.to_string(),
            stage: stage.to_string(),
            detail,
        },
    );
}

/// Fold this turn's attachments into the most recent user message: text files
/// append as fenced blocks, images turn the content into the OpenAI
/// multi-part shape (`[{type:"text"},{type:"image_url"},…]`) that the June
/// API proxy sanctions for vision models.
fn attach_to_last_user_message(
    messages: &mut [serde_json::Value],
    attachments: &[AgentLiteAttachment],
) {
    let Some(last_user) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(serde_json::Value::as_str) == Some("user"))
    else {
        return;
    };
    let mut text = last_user
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut budget = MAX_TEXT_ATTACHMENT_CHARS;
    for attachment in attachments.iter().filter(|a| a.kind == "text") {
        let content: String = attachment.data.chars().take(budget).collect();
        budget = budget.saturating_sub(content.chars().count());
        text.push_str(&format!(
            "\n\n[File: {}]\n```\n{}\n```",
            attachment.name, content
        ));
        if budget == 0 {
            text.push_str("\n[Remaining file content truncated.]");
            break;
        }
    }
    let images: Vec<&AgentLiteAttachment> = attachments
        .iter()
        .filter(|a| a.kind == "image")
        .take(MAX_IMAGE_ATTACHMENTS)
        .collect();
    if images.is_empty() {
        if let Some(object) = last_user.as_object_mut() {
            object.insert("content".to_string(), serde_json::json!(text));
        }
        return;
    }
    let mut parts = vec![serde_json::json!({ "type": "text", "text": text })];
    for image in images {
        parts.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": image.data },
        }));
    }
    if let Some(object) = last_user.as_object_mut() {
        object.insert("content".to_string(), serde_json::Value::Array(parts));
    }
}

/// Pull a human-readable reason out of an error body: the Carpe Diem/June
/// envelope carries `message` (and sometimes `error`); anything else falls
/// back to the raw text, truncated.
fn readable_upstream_error(body: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
        for key in ["message", "error"] {
            if let Some(text) = value.get(key).and_then(serde_json::Value::as_str) {
                if !text.trim().is_empty() {
                    return text.trim().to_string();
                }
            }
        }
    }
    String::from_utf8_lossy(body).chars().take(300).collect()
}

/// Whether an upstream error detail means the provider is momentarily *busy* —
/// rate-limited (the June API sidecar's `upstream_rate_limited`, or a direct
/// provider "rate limit reached" / "too many requests") or at capacity /
/// saturated (`MODEL_INFRA_SATURATED`, `NO_PROVIDER_CAPACITY`, "saturated
/// upstream"). Mirrors isUpstreamRateLimitedMessage in src/lib/errors.ts.
fn is_rate_limit_detail(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("rate_limit")
        || lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("too many requests")
        || lower.contains("saturated")
        || lower.contains("no_provider")
        || lower.contains("provider_capacity")
}

/// Whether an upstream error detail means the provider genuinely failed — the
/// June API sidecar's `upstream_provider_failed` (an upstream 500/502/504) or
/// a raw gateway `VENICE_ERROR` body. Distinct from the busy vocabulary above
/// (ADR-0012). Mirrors isUpstreamProviderFailureMessage in src/lib/errors.ts.
fn is_provider_failure_detail(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("upstream_provider_failed") || lower.contains("venice_error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_detail_matches_sidecar_and_direct_provider_wording() {
        // The June API sidecar's message for an upstream 429 / 503.
        assert!(is_rate_limit_detail("upstream_rate_limited"));
        // A direct provider 429 (Carpe Diem / Venice).
        assert!(is_rate_limit_detail(
            "Venice rate limit reached — please retry in a few seconds."
        ));
        assert!(is_rate_limit_detail("Too Many Requests"));
        // A direct provider 503 capacity/saturation (the dominant hot-model case).
        assert!(is_rate_limit_detail(
            "Model kimi-k3 is currently saturated upstream. Retry after 9s."
        ));
        assert!(is_rate_limit_detail("NO_PROVIDER_CAPACITY"));
        // A genuine provider failure must NOT read as busy.
        assert!(!is_rate_limit_detail("upstream_provider_failed"));
    }

    #[test]
    fn provider_failure_detail_matches_sidecar_and_gateway_wording() {
        // The June API sidecar's message for an upstream 500/502/504.
        assert!(is_provider_failure_detail("upstream_provider_failed"));
        // A raw gateway body that reaches us un-normalized.
        assert!(is_provider_failure_detail("VENICE_ERROR"));
        // Busy vocabulary stays on its own branch.
        assert!(!is_provider_failure_detail("upstream_rate_limited"));
        assert!(!is_provider_failure_detail("MODEL_INFRA_SATURATED"));
    }

    #[test]
    fn system_prompt_appends_memory_block_when_present() {
        let plain = build_system_prompt(None);
        assert_eq!(plain, SYSTEM_PROMPT);

        let block = "User memory: facts.\n- Répond toujours en français.\n";
        let with_memory = build_system_prompt(Some(block));
        assert!(with_memory.starts_with(SYSTEM_PROMPT));
        assert!(with_memory.ends_with(block));
    }

    fn tool_names(tools: &serde_json::Value) -> Vec<String> {
        tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_stream_rebuilds_the_message_the_tool_loop_expects() {
        let mut reply = StreamedReply::default();
        // Content arrives token by token.
        reply.apply(&serde_json::json!({ "content": "Hel" }));
        reply.apply(&serde_json::json!({ "content": "lo" }));
        assert_eq!(reply.content, "Hello");
        let message = reply.into_message();
        assert_eq!(message["content"], "Hello");
        assert!(message.get("tool_calls").is_none());
    }

    #[test]
    fn tool_call_fragments_reassemble_by_index() {
        let mut reply = StreamedReply::default();
        // The id and name land once, the arguments across several frames, and
        // two parallel calls interleave by index.
        reply.apply(&serde_json::json!({
            "tool_calls": [
                { "index": 0, "id": "a", "function": { "name": "read_note", "arguments": "{\"note" } },
                { "index": 1, "id": "b", "function": { "name": "web_search", "arguments": "{\"que" } }
            ]
        }));
        reply.apply(&serde_json::json!({
            "tool_calls": [
                { "index": 0, "function": { "arguments": "_id\":\"n1\"}" } },
                { "index": 1, "function": { "arguments": "ry\":\"x\"}" } }
            ]
        }));
        let message = reply.into_message();
        let calls = message["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "a");
        assert_eq!(calls[0]["function"]["name"], "read_note");
        assert_eq!(calls[0]["function"]["arguments"], "{\"note_id\":\"n1\"}");
        assert_eq!(calls[1]["function"]["arguments"], "{\"query\":\"x\"}");
    }

    #[test]
    fn an_empty_stream_is_reported_so_the_turn_can_be_replayed_buffered() {
        assert!(StreamedReply::default().is_empty());
        let mut whitespace = StreamedReply::default();
        whitespace.apply(&serde_json::json!({ "content": "   " }));
        assert!(whitespace.is_empty());
        let mut answered = StreamedReply::default();
        answered.apply(&serde_json::json!({ "content": "hi" }));
        assert!(!answered.is_empty());
    }

    #[test]
    fn a_tool_call_without_a_name_is_dropped_rather_than_sent_nameless() {
        let mut reply = StreamedReply::default();
        reply.apply(&serde_json::json!({
            "tool_calls": [{ "index": 0, "id": "a", "function": { "arguments": "{}" } }]
        }));
        assert!(reply.into_message().get("tool_calls").is_none());
    }

    #[test]
    fn web_snippets_lose_their_markup_and_duplicate_paragraph() {
        // Exactly the shape the provider returns: highlight tags, then the
        // same passage repeated after a blank line.
        let raw = "Lisbon, its <strong>capital</strong>, is the largest city.\n\nLisbon, its capital, is the largest city.";
        let cleaned = clean_snippet(raw);
        assert_eq!(cleaned, "Lisbon, its capital, is the largest city.");
        assert!(!cleaned.contains('<'));
    }

    #[test]
    fn web_snippets_are_capped_so_five_results_still_fit() {
        let cleaned = clean_snippet(&"word ".repeat(500));
        assert!(cleaned.chars().count() <= WEB_SNIPPET_CHARS);
    }

    #[test]
    fn every_web_result_survives_the_shaping() {
        // The regression this replaces: the raw body was forwarded truncated
        // at 6000 chars, which cut the JSON mid-result and silently dropped
        // most of what was found. Long snippets must not cost a result.
        let long = "x".repeat(3000);
        let body = serde_json::json!({
            "data": {
                "results": (0..5).map(|index| serde_json::json!({
                    "title": format!("Result {index}"),
                    "url": format!("https://example.com/{index}"),
                    "snippet": long,
                })).collect::<Vec<_>>()
            }
        })
        .to_string();
        let shaped = summarize_web_results(body.as_bytes());
        let items: Vec<serde_json::Value> = serde_json::from_str(&shaped).expect("valid json");
        assert_eq!(items.len(), 5);
        assert_eq!(items[4]["url"], "https://example.com/4");
    }

    #[test]
    fn an_empty_or_unreadable_web_response_says_so() {
        assert!(summarize_web_results(b"not json").contains("unreadable"));
        let empty = serde_json::json!({ "data": { "results": [] } }).to_string();
        assert!(summarize_web_results(empty.as_bytes()).contains("no results"));
    }

    #[test]
    fn blank_string_arguments_read_as_absent() {
        // Models routinely send "" for a field they mean to omit; treating that
        // as a real value makes read_note look up the empty note id.
        let args = serde_json::json!({ "note_id": "  ", "title": " Standup ", "content": "x" });
        assert_eq!(arg_str(&args, "note_id"), None);
        assert_eq!(arg_str(&args, "title").as_deref(), Some("Standup"));
        assert_eq!(arg_str(&args, "missing"), None);
    }

    #[test]
    fn numeric_arguments_accept_both_json_shapes() {
        assert_eq!(
            arg_i64(&serde_json::json!({ "limit": 5 }), "limit"),
            Some(5)
        );
        assert_eq!(
            arg_i64(&serde_json::json!({ "limit": "5" }), "limit"),
            Some(5)
        );
        assert_eq!(arg_i64(&serde_json::json!({ "limit": "x" }), "limit"), None);
    }

    #[test]
    fn truncation_is_announced_so_the_model_knows_it_saw_a_fragment() {
        assert_eq!(truncate("short".to_string(), 10), "short");
        let long = truncate("a".repeat(50), 10);
        assert!(long.starts_with(&"a".repeat(10)));
        assert!(long.ends_with("[truncated]"));
    }

    #[test]
    fn places_results_keep_the_provider_and_the_rows_verbatim() {
        let body = serde_json::json!({
            "success": true,
            "data": {
                "query": "expert comptable annemasse",
                "provider": "osm",
                "places": [{
                    "name": "Sogeca Experts",
                    "lat": 46.19,
                    "lng": 6.23,
                    "address": "Rue de la Gare, Annemasse",
                    "category": "Accountant"
                }]
            }
        });
        let summary = summarize_places_results(body.to_string().as_bytes());
        let parsed: serde_json::Value = serde_json::from_str(&summary).unwrap();
        assert_eq!(parsed["provider"], "osm");
        assert_eq!(parsed["places"][0]["name"], "Sogeca Experts");
        assert_eq!(parsed["places"][0]["lat"], 46.19);

        let empty = serde_json::json!({ "data": { "provider": "osm", "places": [] } });
        assert_eq!(
            summarize_places_results(empty.to_string().as_bytes()),
            "The places search returned no results."
        );
        assert_eq!(
            summarize_places_results(b"not json"),
            "The places search returned an unreadable response."
        );
    }

    #[test]
    fn the_system_prompt_teaches_both_chat_block_kinds() {
        let prompt = build_system_prompt(None);
        assert!(prompt.contains("subrosa:links"));
        assert!(prompt.contains("subrosa:places"));
        assert!(prompt.contains("Never invent a place or a coordinate."));
    }

    #[test]
    fn reading_and_writing_tools_are_advertised() {
        let names = tool_names(&tool_definitions(true));
        for expected in [
            "search_notes",
            "read_note",
            "list_recent_notes",
            "create_note",
            "append_to_note",
            "web_search",
            "places_search",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn read_note_requires_the_id_search_handed_back() {
        let tools = tool_definitions(false);
        let read = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "read_note")
            .unwrap();
        assert_eq!(
            read["function"]["parameters"]["required"],
            serde_json::json!(["note_id"])
        );
    }

    #[test]
    fn memory_tools_are_only_advertised_when_memory_is_enabled() {
        // Both directions matter: advertising `remember` while memory is off
        // would have the model promise to remember something that is dropped.
        let with_memory = tool_names(&tool_definitions(true));
        assert!(with_memory.contains(&"search_memories".to_string()));
        assert!(with_memory.contains(&"remember".to_string()));

        let without_memory = tool_names(&tool_definitions(false));
        assert!(!without_memory.contains(&"search_memories".to_string()));
        assert!(!without_memory.contains(&"remember".to_string()));
        // The rest of the surface is unaffected by the memory setting.
        assert!(without_memory.contains(&"read_note".to_string()));
    }
}
