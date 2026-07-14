//! Agent-lite: the mobile chat brain.
//!
//! The desktop agent runs on the embedded Hermes runtime (a Python subprocess
//! with skills and MCP servers) — impossible on iOS. Agent-lite keeps the
//! product promise ("chat with an assistant over your notes") with what the
//! platform allows: a tool-loop over the June API's chat-completions proxy
//! (Carpe Diem upstream), with two tools that run in-process:
//!
//! - `search_notes` — LIKE retrieval over the local SQLite notes/transcripts;
//! - `web_search`   — the June API `/v1/web/search` passthrough.
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

pub const AGENT_LITE_STATUS_EVENT: &str = "agent-lite://status";
pub const AGENT_LITE_DONE_EVENT: &str = "agent-lite://done";

/// Hard cap on tool round-trips per user turn, so a confused model cannot
/// loop on searches forever (each iteration is a paid completion).
const MAX_TOOL_ITERATIONS: usize = 3;
const SYSTEM_PROMPT: &str = "You are Sub Rosa's assistant on the user's device. You answer questions using the user's meeting notes and dictations when relevant: call search_notes with a short keyword query to look them up (results include note titles and snippets). Call web_search when the question needs current public information. Prefer searching notes before answering questions about the user's meetings, decisions, or plans. Answer in the user's language, concisely, in plain prose or simple markdown. If searches come back empty, say what you looked for.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiteStatusDto {
    pub task_id: String,
    /// "thinking" | "searching-notes" | "searching-web" | "searching-memory"
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
    // request included) so it survives the lock.
    let _background = crate::ios_background::BackgroundTask::begin("agent-lite-turn");
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

    // Vision turns skip the tool declarations: several upstream vision routes
    // reject tool-bearing requests outright (502 upstream_provider_failed),
    // and an image question is not a notes/web lookup anyway.
    let has_images = attachments.iter().any(|a| a.kind == "image");

    for _iteration in 0..=MAX_TOOL_ITERATIONS {
        emit_status(app, task_id, "thinking", None);
        let mut body = if has_images {
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
                    "Your Carpe Diem balance is too low to cover this request. Top up your credits, then try again.",
                ));
            }
            return Err(AppError::new(
                "agent_lite_failed",
                format!("The assistant request failed with status {status}: {detail}"),
            ));
        }
        let body = response.collect_body().await?;
        let value: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|error| AppError::new("agent_lite_invalid", error.to_string()))?;
        let message = value
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| {
                AppError::new("agent_lite_invalid", "The assistant returned no message.")
            })?;

        let tool_calls = message
            .get("tool_calls")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        if tool_calls.is_empty() {
            let text = june_api::extract_chat_completion_text(&value)
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
            let arguments = tool_call
                .pointer("/function/arguments")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("{}");
            let query = serde_json::from_str::<serde_json::Value>(arguments)
                .ok()
                .and_then(|args| {
                    args.get("query")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            let content = execute_tool(app, repos, task_id, &name, &query).await;
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

async fn execute_tool(
    app: &AppHandle,
    repos: &crate::db::repositories::Repositories,
    task_id: &str,
    name: &str,
    query: &str,
) -> String {
    match name {
        "search_notes" => {
            emit_status(app, task_id, "searching-notes", Some(query.to_string()));
            match repos.search_note_context(query, 6).await {
                Ok(snippets) if snippets.is_empty() => {
                    "No matching notes or transcripts were found.".to_string()
                }
                Ok(snippets) => serde_json::to_string(&snippets)
                    .unwrap_or_else(|_| "Search failed to serialize.".to_string()),
                Err(error) => format!("Note search failed: {error}"),
            }
        }
        "search_memories" => {
            emit_status(app, task_id, "searching-memory", Some(query.to_string()));
            if !crate::memory::settings().enabled {
                return "Memory is disabled in the user's settings.".to_string();
            }
            match crate::memory::recall::recall(repos, query, 8).await {
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
            emit_status(app, task_id, "searching-web", Some(query.to_string()));
            let body = serde_json::json!({ "query": query, "limit": 5 });
            match june_api::forward_web_request("/v1/web/search", &body).await {
                Ok(response) if (200..300).contains(&response.status) => {
                    String::from_utf8_lossy(&response.body)
                        .chars()
                        .take(6000)
                        .collect()
                }
                Ok(response) => format!("Web search failed with status {}.", response.status),
                Err(error) => format!("Web search failed: {}", error.message),
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
    if memory_enabled {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_appends_memory_block_when_present() {
        let plain = build_system_prompt(None);
        assert_eq!(plain, SYSTEM_PROMPT);

        let block = "User memory: facts.\n- Répond toujours en français.\n";
        let with_memory = build_system_prompt(Some(block));
        assert!(with_memory.starts_with(SYSTEM_PROMPT));
        assert!(with_memory.ends_with(block));
    }

    #[test]
    fn memory_tool_is_only_advertised_when_memory_is_enabled() {
        let with_memory = tool_definitions(true);
        let names: Vec<&str> = with_memory
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.pointer("/function/name")?.as_str())
            .collect();
        assert_eq!(names, vec!["search_notes", "web_search", "search_memories"]);

        let without_memory = tool_definitions(false);
        let names: Vec<&str> = without_memory
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|tool| tool.pointer("/function/name")?.as_str())
            .collect();
        assert_eq!(names, vec!["search_notes", "web_search"]);
    }
}
