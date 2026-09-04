//! Automatic memory extraction (the Venice Memoria recipe, adapted).
//!
//! Every [`EXTRACTION_CADENCE`]th assistant reply in a conversation, the last
//! 5 user + 5 assistant messages go to the chat-completions proxy with an
//! extraction prompt. The model returns candidate facts scored 1 (essential)
//! to 10 (trivial); anything above [`MAX_STORED_IMPORTANCE`] is discarded,
//! survivors dedup against existing memories and insert with source `auto`.
//!
//! Both chat pipelines funnel here: agent-lite calls
//! [`maybe_extract_after_agent_lite_turn`] after each successful turn, and
//! the desktop chat (whose transcript lives in Hermes, not in this database)
//! sends its own message window through the `memory_extract` command.

use crate::{
    db::repositories::Repositories,
    domain::types::{AppError, MemoryDto, MemorySource},
    june_api,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Extract every Nth assistant reply — extracting on every turn would double
/// the cost of a conversation for marginal recall gain.
pub const EXTRACTION_CADENCE: usize = 3;
/// How much recent conversation the extractor sees, per role.
const CONTEXT_MESSAGES_PER_ROLE: usize = 5;
/// Candidates scored above this are too trivial to keep.
const MAX_STORED_IMPORTANCE: i64 = 8;
/// Upper bound on inserts per pass, so one chatty exchange cannot flood the
/// memory store.
const MAX_NEW_MEMORIES_PER_PASS: usize = 5;
/// How many existing memories ride along in the prompt for dedup context.
const EXISTING_MEMORIES_IN_PROMPT: i64 = 50;
const MAX_MEMORY_TEXT_CHARS: usize = 500;

const EXTRACTION_SYSTEM_PROMPT: &str = r#"You maintain a long-term memory of durable facts about the user for their private assistant. You are given a recent chat window and the memories already stored.

Return ONLY a JSON object, no prose or markdown fences: {"memories":[{"text":"...","importance":N}]}

Rules:
- A memory is a stable fact about the user that stays useful across future conversations: identity, language, preferences, projects, tools, relationships, constraints, recurring goals.
- Write each memory in the language the user writes in, as one short self-contained sentence about the user.
- importance is an integer from 1 to 10 where LOWER is MORE important: 1-2 core identity or standing instructions, 3-5 solid preferences and ongoing projects, 6-8 minor but reusable details, 9-10 trivia (which you must not return).
- Return at most 5 memories. Return {"memories":[]} when the window adds nothing durable.
- Never repeat or rephrase a stored memory listed under "Stored memories".
- Never store secrets (passwords, keys, tokens), one-off task details, the assistant's own statements, or transient context like today's errand."#;

/// A (role, content) message from either chat pipeline, oldest first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ExtractMemoriesRequest {
    pub messages: Vec<ConversationMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractMemoriesResult {
    pub added: usize,
}

#[derive(Debug, Deserialize)]
struct ExtractionEnvelope {
    #[serde(default)]
    memories: Vec<ExtractedCandidate>,
}

#[derive(Debug, Deserialize)]
struct ExtractedCandidate {
    #[serde(default)]
    text: String,
    #[serde(default = "default_candidate_importance")]
    importance: i64,
}

fn default_candidate_importance() -> i64 {
    5
}

/// The desktop chat's extraction entry point: the frontend counts assistant
/// completions per Hermes session and sends the recent window every
/// [`EXTRACTION_CADENCE`]th turn.
#[tauri::command]
pub async fn memory_extract(
    app: AppHandle,
    request: ExtractMemoriesRequest,
) -> Result<ExtractMemoriesResult, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let added = extract_and_store(&repos, &request.messages).await?;
    if added > 0 {
        super::recall::spawn_backfill(&app);
    }
    Ok(ExtractMemoriesResult { added })
}

/// Fire-and-forget extraction after a successful agent-lite turn. Failures
/// only log: memory is a best-effort enrichment and must never break chat.
pub fn maybe_extract_after_agent_lite_turn(app: &AppHandle, task_id: String) {
    let settings = super::settings();
    if !settings.enabled || !settings.auto_extract {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let repos = crate::commands::repositories(&app).await?;
            let task = repos.get_agent_task(&task_id).await?;
            let messages: Vec<ConversationMessage> = task
                .messages
                .iter()
                .map(|message| ConversationMessage {
                    role: message.role.as_db().to_string(),
                    content: message.content.clone(),
                })
                .collect();
            let assistant_turns = messages
                .iter()
                .filter(|message| message.role == "assistant")
                .count();
            if !should_extract(assistant_turns) {
                return Ok::<usize, AppError>(0);
            }
            let added = extract_and_store(&repos, &messages).await?;
            if added > 0 {
                let _ = super::recall::backfill_embeddings(&repos).await;
            }
            Ok(added)
        }
        .await;
        if let Err(error) = result {
            eprintln!("memory extraction after agent-lite turn failed: {error:?}");
        }
    });
}

/// Whether a conversation that now counts `assistant_turns` assistant replies
/// is due for an extraction pass.
pub fn should_extract(assistant_turns: usize) -> bool {
    assistant_turns > 0 && assistant_turns % EXTRACTION_CADENCE == 0
}

/// Runs one extraction pass over `messages` (oldest first) and stores the
/// surviving candidates. Returns how many memories were added.
pub async fn extract_and_store(
    repos: &Repositories,
    messages: &[ConversationMessage],
) -> Result<usize, AppError> {
    let settings = super::settings();
    if !settings.enabled || !settings.auto_extract {
        return Ok(0);
    }
    let window = extraction_window(messages);
    if window.is_empty() {
        return Ok(0);
    }
    let existing = repos.top_memories(EXISTING_MEMORIES_IN_PROMPT).await?;
    let prompt = build_extraction_prompt(&window, &existing);

    let mut request = serde_json::json!({
        "messages": [
            { "role": "system", "content": EXTRACTION_SYSTEM_PROMPT },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.1,
        // Sized for reasoning models: hidden thinking spends from the same
        // budget as the JSON answer.
        "max_tokens": 1500
    });
    // Without a model the proxy's default (the chat's) applies, as before.
    if let Some(model) = extraction_model_for(&settings) {
        request["model"] = serde_json::Value::String(model);
    }
    let response = june_api::proxy_agent_chat_completions(request).await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            "memory_extraction_failed",
            format!("Memory extraction returned status {}.", response.status),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("memory_extraction_invalid", error.to_string()))?;
    let text = june_api::extract_chat_completion_text(&value).ok_or_else(|| {
        AppError::new(
            "memory_extraction_invalid",
            "Memory extraction did not return text.",
        )
    })?;
    let candidates = parse_extracted_memories(&text);

    let mut added = 0;
    for candidate in candidates.into_iter().take(MAX_NEW_MEMORIES_PER_PASS) {
        let text = candidate.text.trim();
        if text.is_empty()
            || text.chars().count() > MAX_MEMORY_TEXT_CHARS
            || candidate.importance > MAX_STORED_IMPORTANCE
        {
            continue;
        }
        if repos.memory_with_text_exists(text).await? {
            continue;
        }
        repos
            .insert_memory(text, MemorySource::Auto, candidate.importance)
            .await?;
        added += 1;
    }
    Ok(added)
}

/// The last [`CONTEXT_MESSAGES_PER_ROLE`] user and assistant messages, in
/// their original order. Tool/system entries never reach the extractor.
fn extraction_window(messages: &[ConversationMessage]) -> Vec<&ConversationMessage> {
    let recent_of = |role: &str| -> Vec<usize> {
        messages
            .iter()
            .enumerate()
            .filter(|(_, message)| message.role == role && !message.content.trim().is_empty())
            .map(|(index, _)| index)
            .rev()
            .take(CONTEXT_MESSAGES_PER_ROLE)
            .collect()
    };
    let mut indexes: Vec<usize> = recent_of("user")
        .into_iter()
        .chain(recent_of("assistant"))
        .collect();
    indexes.sort_unstable();
    indexes.into_iter().map(|index| &messages[index]).collect()
}

fn build_extraction_prompt(window: &[&ConversationMessage], existing: &[MemoryDto]) -> String {
    let mut prompt = String::from("Stored memories:\n");
    if existing.is_empty() {
        prompt.push_str("(none yet)\n");
    } else {
        for memory in existing {
            prompt.push_str("- ");
            prompt.push_str(&memory.text);
            prompt.push('\n');
        }
    }
    prompt.push_str("\nRecent conversation window:\n");
    for message in window {
        let speaker = if message.role == "user" {
            "User"
        } else {
            "Assistant"
        };
        // Long replies (an agent dumping a file) would drown the signal; the
        // head of a message carries the facts about the user.
        let content: String = message.content.chars().take(4_000).collect();
        prompt.push_str(&format!("{speaker}: {content}\n"));
    }
    prompt.push_str("\nExtract the new durable memories now.");
    prompt
}

/// Tolerant JSON extraction: models occasionally wrap the object in fences or
/// prose despite instructions, so scan for the outermost braces.
fn parse_extracted_memories(text: &str) -> Vec<ExtractedCandidate> {
    let trimmed = text.trim();
    if let Ok(envelope) = serde_json::from_str::<ExtractionEnvelope>(trimmed) {
        return envelope.memories;
    }
    let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) else {
        return Vec::new();
    };
    if start >= end {
        return Vec::new();
    }
    serde_json::from_str::<ExtractionEnvelope>(&trimmed[start..=end])
        .map(|envelope| envelope.memories)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> ConversationMessage {
        ConversationMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn extraction_fires_every_third_assistant_turn() {
        assert!(!should_extract(0));
        assert!(!should_extract(1));
        assert!(!should_extract(2));
        assert!(should_extract(3));
        assert!(!should_extract(4));
        assert!(should_extract(6));
    }

    #[test]
    fn window_keeps_last_five_per_role_in_order() {
        let mut messages = Vec::new();
        for index in 0..8 {
            messages.push(message("user", &format!("question {index}")));
            messages.push(message("assistant", &format!("answer {index}")));
        }
        messages.push(message("tool", "tool output"));
        messages.push(message("system", "system prompt"));

        let window = extraction_window(&messages);
        assert_eq!(window.len(), 10);
        assert_eq!(window[0].content, "question 3");
        assert_eq!(window[9].content, "answer 7");
        assert!(window
            .iter()
            .all(|m| m.role == "user" || m.role == "assistant"));
        // Chronological order is preserved (user then assistant, per turn).
        let contents: Vec<&str> = window.iter().map(|m| m.content.as_str()).collect();
        let mut sorted = contents.clone();
        sorted.sort_by_key(|content| {
            content
                .rsplit(' ')
                .next()
                .and_then(|n| n.parse::<usize>().ok())
                .unwrap_or(0)
                * 2
                + usize::from(content.starts_with("answer"))
        });
        assert_eq!(contents, sorted);
    }

    #[test]
    fn parses_clean_json_fenced_json_and_garbage() {
        let clean = r#"{"memories":[{"text":"Prefers French.","importance":2}]}"#;
        let parsed = parse_extracted_memories(clean);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "Prefers French.");
        assert_eq!(parsed[0].importance, 2);

        let fenced = "Here you go:\n```json\n{\"memories\":[{\"text\":\"Uses a Mac.\",\"importance\":6}]}\n```";
        let parsed = parse_extracted_memories(fenced);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "Uses a Mac.");

        assert!(parse_extracted_memories("no json here").is_empty());
        assert!(parse_extracted_memories("{\"memories\":[]}").is_empty());
    }

    #[test]
    fn candidate_importance_defaults_when_missing() {
        let parsed = parse_extracted_memories(r#"{"memories":[{"text":"Plays chess."}]}"#);
        assert_eq!(parsed[0].importance, 5);
    }

    #[test]
    fn prompt_lists_existing_memories_and_window() {
        let existing = vec![];
        let messages = vec![message("user", "Je préfère les réponses en français.")];
        let window = extraction_window(&messages);
        let prompt = build_extraction_prompt(&window, &existing);
        assert!(prompt.contains("(none yet)"));
        assert!(prompt.contains("User: Je préfère les réponses en français."));
    }
}

/// The model the extraction runs on, if the user chose one; blank means the
/// chat's own, which is the default the request already carries.
pub fn extraction_model_for(settings: &super::MemorySettings) -> Option<String> {
    settings
        .extraction_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod extraction_model_tests {
    use super::extraction_model_for;

    #[test]
    fn a_chosen_model_is_used_and_a_blank_one_is_the_default() {
        let mut settings = crate::memory::MemorySettings::default();
        assert_eq!(extraction_model_for(&settings), None);
        settings.extraction_model = Some("  ".into());
        assert_eq!(extraction_model_for(&settings), None);
        settings.extraction_model = Some("qwen3-4b".into());
        assert_eq!(extraction_model_for(&settings).as_deref(), Some("qwen3-4b"));
    }
}
