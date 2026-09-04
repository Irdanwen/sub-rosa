//! Ask your notes: a question answered from the corpus, with citations.
//!
//! Search (migration 020) finds where a word is. This answers a question
//! from what the notes say, and every claim in the answer points at the note
//! it came from, so the person can check rather than trust. It is the
//! smallest honest form of retrieval-augmented answering:
//!
//! - **Retrieval is the app's, not the model's.** The FTS5 index picks the
//!   passages (`Repositories::search_note_context`, ranked by bm25, folded
//!   for accents), and only those passages are sent. What left the machine
//!   is exactly the list the panel shows under "What was sent", and the
//!   egress ledger row for the request is tagged with the same note ids.
//! - **Citations are indices the app resolves.** The model writes `[1]`,
//!   `[2]`… over the numbered passages it was given; the app maps each index
//!   back to a note id and a title. A citation the model invents (an index
//!   that was not handed to it) is dropped, and the answer says so, the same
//!   discipline as the chapter timestamps in ADR-0027 (the app owns the
//!   clock; here the app owns the sources).
//! - **No new prompt or route in `june-api/`** (ADR-0027, spec
//!   `no-fork-feature-in-june-api`): the prompt lives here with its own
//!   version, and the request goes through the sidecar's chat completions
//!   like every other fork feature.
//!
//! Shared by both shells: the ⌘K palette on the desktop, the notes search on
//! the phone.

pub mod semantic;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::domain::types::AppError;
use crate::june_api;

/// Deltas of an answer on the way, so the panel shows words as they come:
/// `{ requestId, phase: "delta", text }`. The whole answer, with its
/// citations resolved, is the command's return value, never an event.
pub const ASK_EVENT: &str = "june://ask";

pub const ASK_PROMPT_VERSION: u32 = 1;
/// Passages handed to the model. Eight is what fits a short answer's
/// context with room to spare on the small models people pick for cost.
const PASSAGES: i64 = 8;
const MAX_TOKENS: u32 = 900;
const TEMPERATURE: f32 = 0.2;

const SYSTEM_PROMPT: &str =
    "You answer questions from a person's own meeting notes and transcripts. \
You are given numbered passages. Answer in the language of the question, in a few sentences, \
using only what the passages say. After each claim, cite the passage it comes from as [n]. \
If the passages do not answer the question, say so in one sentence and cite nothing. \
Never invent a passage number. Do not mention that you were given passages.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskNotesRequest {
    pub question: String,
    /// Chosen by the caller, so deltas reach the panel that asked and a
    /// close can cancel the right run. Absent, the answer is not streamed.
    #[serde(default)]
    pub request_id: Option<String>,
    /// "Ask this note": retrieval kept to one note, several passages of it.
    #[serde(default)]
    pub note_id: Option<String>,
    /// The questions and answers before this one in the same panel, so a
    /// follow-up ("and who decided?") reads in context. Passages are
    /// retrieved for the new question alone and sent once.
    #[serde(default)]
    pub history: Vec<AskTurn>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskTurn {
    pub question: String,
    pub answer: String,
}

/// Turns kept from a long thread: the last few, so the prompt stays a
/// prompt and not a transcript of the panel.
const HISTORY_TURNS: usize = 4;

/// The terms to retrieve with: the question's own content words, and when
/// a follow-up has fewer than two of them ("and who decided?"), the
/// previous question's as well, since that is what it is about.
pub fn retrieval_terms(question: &str, history: &[AskTurn]) -> Vec<String> {
    let mut terms = content_terms(question);
    if terms.len() < 2 {
        if let Some(previous) = history.last() {
            for term in content_terms(&previous.question) {
                if !terms.contains(&term) {
                    terms.push(term);
                }
            }
        }
    }
    terms
}

/// The conversation as the model sees it: the system rules, the earlier
/// turns without their passages, then the passages and the new question.
pub fn build_messages(user: &str, history: &[AskTurn]) -> Vec<serde_json::Value> {
    let mut messages = vec![serde_json::json!({ "role": "system", "content": SYSTEM_PROMPT })];
    let start = history.len().saturating_sub(HISTORY_TURNS);
    for turn in &history[start..] {
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!("Question: {}", turn.question.trim())
        }));
        messages.push(serde_json::json!({ "role": "assistant", "content": turn.answer.trim() }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": user }));
    messages
}

/// The answers running right now, each with the handle that stops it. A
/// `Notify` the loop selects on, so closing the panel lands mid-chunk
/// (the same shape as the rewrite panel's registry, for the same reason).
static RUNNING: std::sync::LazyLock<Mutex<HashMap<String, Arc<Notify>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn running() -> MutexGuard<'static, HashMap<String, Arc<Notify>>> {
    RUNNING.lock().unwrap_or_else(|poison| poison.into_inner())
}

struct AskClaim {
    request_id: String,
    stop: Arc<Notify>,
}

impl AskClaim {
    fn take(request_id: &str) -> Option<Self> {
        let stop = Arc::new(Notify::new());
        let mut running = running();
        if running.contains_key(request_id) {
            return None;
        }
        running.insert(request_id.to_string(), Arc::clone(&stop));
        Some(Self {
            request_id: request_id.to_string(),
            stop,
        })
    }
}

impl Drop for AskClaim {
    fn drop(&mut self) {
        running().remove(&self.request_id);
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskCancelRequest {
    pub request_id: String,
}

/// Stop an answer on the way. Closing the panel calls this; a request that
/// already finished is not an error.
#[tauri::command]
pub async fn ask_cancel(request: AskCancelRequest) -> Result<(), AppError> {
    if let Some(stop) = running().get(&request.request_id) {
        stop.notify_one();
    }
    Ok(())
}

fn emit_delta(app: &AppHandle, request_id: &str, text: &str) {
    let _ = app.emit(
        ASK_EVENT,
        serde_json::json!({ "requestId": request_id, "phase": "delta", "text": text }),
    );
}

/// Read a streamed completion, emitting each delta, until the stream ends
/// or the claim is stopped. A route that ignored `stream` answers with
/// ordinary JSON, and that is read whole.
async fn collect_answer(
    app: &AppHandle,
    mut response: june_api::AgentChatCompletionsResponse,
    claim: Option<&AskClaim>,
) -> Result<String, AppError> {
    if !response.content_type.contains("event-stream") {
        let body = response.collect_body().await?;
        let value: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|error| AppError::new("ask_failed", error.to_string()))?;
        return Ok(june_api::extract_chat_completion_text(&value).unwrap_or_default());
    }
    let mut collected = String::new();
    let mut buffer = String::new();
    let stop = claim.map(|claim| Arc::clone(&claim.stop));
    loop {
        let chunk = match &stop {
            Some(stop) => {
                let stopped = stop.notified();
                tokio::pin!(stopped);
                tokio::select! {
                    // Cancelling wins the race even mid-chunk; dropping the
                    // response closes the connection so the upstream stops.
                    _ = &mut stopped => {
                        return Err(AppError::new("ask_cancelled", "Stopped."));
                    }
                    chunk = response.chunk() => chunk?,
                }
            }
            None => response.chunk().await?,
        };
        let Some(chunk) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        let before = collected.len();
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
            if let Some(delta) = frame
                .pointer("/choices/0/delta/content")
                .and_then(|v| v.as_str())
            {
                collected.push_str(delta);
            }
        }
        if let (Some(claim), true) = (claim, collected.len() > before) {
            emit_delta(app, &claim.request_id, &collected[before..]);
        }
    }
    Ok(collected)
}

/// A passage that was sent, and can be cited.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskSource {
    /// 1-based, the number the model was shown.
    pub index: usize,
    pub note_id: String,
    pub title: String,
    pub kind: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswer {
    pub answer: String,
    /// The sources the answer actually cites, in order of first mention.
    pub citations: Vec<AskSource>,
    /// Everything that was sent, cited or not: what left the machine.
    pub sent: Vec<AskSource>,
    /// Indices the model cited that were never handed to it; shown, not hidden.
    pub invented: Vec<usize>,
    pub prompt_version: u32,
}

/// Words in French and English that carry no retrieval signal. A question
/// is mostly these; the passages are found by what is left.
const STOP_WORDS: &[&str] = &[
    "the", "and", "for", "are", "was", "were", "what", "when", "where", "who", "why", "how",
    "which", "did", "does", "has", "have", "had", "about", "with", "that", "this", "from", "into",
    "our", "you", "your", "they", "them", "their", "there", "been", "will", "would", "should",
    "could", "can", "say", "said", "les", "des", "une", "est", "sont", "que", "qui", "quoi",
    "quand", "pourquoi", "comment", "combien", "quel", "quelle", "quels", "quelles", "dans", "sur",
    "avec", "pour", "par", "pas", "nous", "vous", "ils", "elles", "leur", "leurs", "notre", "nos",
    "votre", "vos", "mon", "mes", "ton", "tes", "ses", "son", "cette", "ces", "cet", "était",
    "été", "être", "avoir", "fait", "faire", "dit", "aussi", "mais", "donc", "alors", "comme",
    "plus", "moins", "très", "tout", "tous", "toute", "toutes", "ont", "avons", "avez", "sommes",
    "êtes", "suis",
];

/// The words of a question worth searching for: three letters or more,
/// lower-cased, stop words dropped, order kept, duplicates removed.
pub fn content_terms(question: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for raw in question.split(|c: char| !c.is_alphanumeric()) {
        let term = raw.to_lowercase();
        if term.chars().count() < 3 || STOP_WORDS.contains(&term.as_str()) {
            continue;
        }
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

/// An FTS5 expression that matches a row containing *any* of the terms.
/// bm25 then ranks rows that contain more of them higher, which is what a
/// question wants; the all-terms query the palette uses would find nothing
/// for a six-word question.
pub fn passages_match(terms: &[String]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|term| format!("\"{term}\""))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

/// The numbered passages, as the model sees them.
pub fn build_user_prompt(question: &str, sources: &[AskSource]) -> String {
    let mut out = String::new();
    out.push_str("Passages:\n\n");
    for source in sources {
        out.push_str(&format!(
            "[{}] {} ({})\n{}\n\n",
            source.index,
            source.title.trim(),
            source.kind,
            source.excerpt.trim()
        ));
    }
    out.push_str("Question: ");
    out.push_str(question.trim());
    out.push('\n');
    out
}

/// Every `[n]` in the answer, in order of first mention, split into the ones
/// that name a passage that was sent and the ones that do not.
pub fn parse_citations(answer: &str, sent: &[AskSource]) -> (Vec<AskSource>, Vec<usize>) {
    let mut cited: Vec<AskSource> = Vec::new();
    let mut invented: Vec<usize> = Vec::new();
    let bytes = answer.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < bytes.len() && bytes[j] == b']' {
                if let Ok(index) = answer[i + 1..j].parse::<usize>() {
                    match sent.iter().find(|s| s.index == index) {
                        Some(source) => {
                            if !cited.iter().any(|c| c.index == index) {
                                cited.push(source.clone());
                            }
                        }
                        None => {
                            if !invented.contains(&index) {
                                invented.push(index);
                            }
                        }
                    }
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    (cited, invented)
}

#[tauri::command]
pub async fn ask_notes(app: AppHandle, request: AskNotesRequest) -> Result<AskAnswer, AppError> {
    let question = request.question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::new("ask_empty", "Ask something first."));
    }
    let claim = match request.request_id.as_deref() {
        Some(id) => Some(AskClaim::take(id).ok_or_else(|| {
            AppError::new(
                "ask_already_running",
                "That question is already being answered.",
            )
        })?),
        None => None,
    };
    let repos = crate::commands::repositories(&app).await?;
    let terms = retrieval_terms(&question, &request.history);
    let scope = request
        .note_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let lexical = match passages_match(&terms) {
        Some(fts) => {
            repos
                .retrieve_passages(&fts, &terms, PASSAGES, scope)
                .await?
        }
        None => Vec::new(),
    };
    // By meaning as well as by word (ADR-0046); empty when the setting is
    // off, the question cannot be embedded, or nothing is embedded yet.
    let by_meaning =
        semantic::semantic_passages(&repos, &question, PASSAGES as usize, scope).await?;
    let snippets = match scope {
        Some(_) => semantic::fuse_within_note(lexical, by_meaning, PASSAGES as usize),
        None => semantic::fuse(lexical, by_meaning, PASSAGES as usize),
    };
    let sent: Vec<AskSource> = snippets
        .into_iter()
        .enumerate()
        .map(|(i, snippet)| AskSource {
            index: i + 1,
            note_id: snippet.note_id,
            title: if snippet.title.trim().is_empty() {
                "Untitled note".to_string()
            } else {
                snippet.title
            },
            kind: snippet.kind,
            excerpt: snippet.snippet,
        })
        .collect();
    if sent.is_empty() {
        return Ok(AskAnswer {
            answer: match scope {
                Some(_) => "Nothing in this note mentions this.".to_string(),
                None => "Nothing in your notes mentions this.".to_string(),
            },
            citations: Vec::new(),
            sent,
            invented: Vec::new(),
            prompt_version: ASK_PROMPT_VERSION,
        });
    }

    let user = build_user_prompt(&question, &sent);
    // The ledger row says "ask", and names the note when every passage came
    // from the same one; the panel's "What was sent" list is the full truth.
    let single_note = scope.map(str::to_string).or_else(|| {
        sent.iter()
            .all(|source| source.note_id == sent[0].note_id)
            .then(|| sent[0].note_id.clone())
    });
    let streamed = claim.is_some();
    let answer = crate::egress_ledger::scoped("ask", single_note, async {
        let response = june_api::proxy_agent_chat_completions(serde_json::json!({
            "model": crate::providers::generation_model(),
            "messages": build_messages(&user, &request.history),
            "temperature": TEMPERATURE,
            "max_tokens": MAX_TOKENS,
            "stream": streamed
        }))
        .await?;
        if !(200..300).contains(&response.status) {
            return Err(AppError::new(
                "ask_failed",
                format!("The model returned status {}.", response.status),
            ));
        }
        collect_answer(&app, response, claim.as_ref()).await
    })
    .await?;
    let answer = answer.trim().to_string();
    if answer.is_empty() {
        return Err(AppError::new("ask_failed", "The model returned no answer."));
    }
    let (citations, invented) = parse_citations(&answer, &sent);
    Ok(AskAnswer {
        answer,
        citations,
        sent,
        invented,
        prompt_version: ASK_PROMPT_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_messages, build_user_prompt, content_terms, parse_citations, passages_match,
        retrieval_terms, AskSource, AskTurn,
    };

    fn source(index: usize, id: &str) -> AskSource {
        AskSource {
            index,
            note_id: id.into(),
            title: format!("Note {id}"),
            kind: "note".into(),
            excerpt: "…".into(),
        }
    }

    #[test]
    fn citations_map_back_to_sent_passages_and_inventions_are_named() {
        let sent = vec![source(1, "a"), source(2, "b"), source(3, "c")];
        let (cited, invented) = parse_citations(
            "On migre lundi [2]. Le budget tient [2][1]. Voir aussi [7].",
            &sent,
        );
        assert_eq!(
            cited.iter().map(|c| c.note_id.as_str()).collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert_eq!(invented, vec![7]);
        assert_eq!(
            parse_citations("no citation here [x] [12a]", &sent).0.len(),
            0
        );
    }

    #[test]
    fn a_question_is_reduced_to_its_content_words_and_matched_as_any_of_them() {
        let terms =
            content_terms("Quand est-ce qu'on migre le cluster vers Hetzner, et pourquoi ?");
        assert_eq!(terms, vec!["migre", "cluster", "vers", "hetzner"]);
        assert_eq!(
            passages_match(&terms).as_deref(),
            Some("\"migre\" OR \"cluster\" OR \"vers\" OR \"hetzner\"")
        );
        assert!(passages_match(&content_terms("What is it?")).is_none());
        assert_eq!(content_terms("Budget, budget, BUDGET"), vec!["budget"]);
    }

    #[test]
    fn a_follow_up_borrows_the_previous_question_terms_and_the_thread_is_sent_in_order() {
        let history = vec![AskTurn {
            question: "Quand migre-t-on le cluster ?".into(),
            answer: "Lundi [1].".into(),
        }];
        assert_eq!(
            retrieval_terms("Et qui décide ?", &history),
            vec!["décide", "migre", "cluster"]
        );
        assert_eq!(
            retrieval_terms("Quel budget pour Hetzner ?", &history),
            vec!["budget", "hetzner"]
        );
        let messages = build_messages("Passages…", &history);
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(
            messages[1]["content"],
            "Question: Quand migre-t-on le cluster ?"
        );
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[3]["content"], "Passages…");
    }

    #[test]
    fn the_prompt_numbers_the_passages_and_ends_with_the_question() {
        let prompt = build_user_prompt("Quand migre-t-on ?", &[source(1, "a"), source(2, "b")]);
        assert!(prompt.starts_with("Passages:\n\n[1] Note a (note)\n"));
        assert!(prompt.contains("[2] Note b (note)\n"));
        assert!(prompt.ends_with("Question: Quand migre-t-on ?\n"));
    }
}
