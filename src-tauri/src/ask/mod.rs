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

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::domain::types::AppError;
use crate::june_api;

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
    let repos = crate::commands::repositories(&app).await?;
    let snippets = repos.search_note_context(&question, PASSAGES).await?;
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
            answer: "Nothing in your notes mentions this.".to_string(),
            citations: Vec::new(),
            sent,
            invented: Vec::new(),
            prompt_version: ASK_PROMPT_VERSION,
        });
    }

    let user = build_user_prompt(&question, &sent);
    // The ledger row says "ask", and names the note when every passage came
    // from the same one; the panel's "What was sent" list is the full truth.
    let single_note = sent
        .iter()
        .all(|source| source.note_id == sent[0].note_id)
        .then(|| sent[0].note_id.clone());
    let body = crate::egress_ledger::scoped("ask", single_note, async {
        let response = june_api::proxy_agent_chat_completions(serde_json::json!({
            "model": crate::providers::generation_model(),
            "messages": [
                { "role": "system", "content": SYSTEM_PROMPT },
                { "role": "user", "content": user }
            ],
            "temperature": TEMPERATURE,
            "max_tokens": MAX_TOKENS
        }))
        .await?;
        if !(200..300).contains(&response.status) {
            return Err(AppError::new(
                "ask_failed",
                format!("The model returned status {}.", response.status),
            ));
        }
        response.collect_body().await
    })
    .await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("ask_failed", error.to_string()))?;
    let answer = june_api::extract_chat_completion_text(&value)
        .unwrap_or_default()
        .trim()
        .to_string();
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
    use super::{build_user_prompt, parse_citations, AskSource};

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
    fn the_prompt_numbers_the_passages_and_ends_with_the_question() {
        let prompt = build_user_prompt("Quand migre-t-on ?", &[source(1, "a"), source(2, "b")]);
        assert!(prompt.starts_with("Passages:\n\n[1] Note a (note)\n"));
        assert!(prompt.contains("[2] Note b (note)\n"));
        assert!(prompt.ends_with("Question: Quand migre-t-on ?\n"));
    }
}
