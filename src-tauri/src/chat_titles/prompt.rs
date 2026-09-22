//! What the model is asked for a chat's title, and how its answer is cleaned.
//! These words are the product: change them when a title disappoints, and
//! bump the version with them.

use crate::domain::types::AppError;
use crate::june_api;

pub const CHAT_TITLE_PROMPT_VERSION: u32 = 1;

const SYSTEM_PROMPT: &str =
    "Name this conversation from the user's first message and the first reply. \
Write at most six words, in the language the user wrote in. Name the subject, not the request: \
no \"help with\", no \"question about\". Return the title only: no quotes, no final punctuation, \
no emoji, no markdown, no prefix such as Title.";

/// Enough of each message to know the subject, never a whole document.
const MAX_INPUT_CHARS: usize = 1_500;
const MAX_WORDS: usize = 6;
const MAX_CHARS: usize = 60;

/// Titles that say nothing: a model that returns one is treated as having
/// returned none.
const GENERIC: &[&str] = &[
    "new chat",
    "new conversation",
    "conversation",
    "chat",
    "untitled",
    "nouveau chat",
    "nouvelle conversation",
    "sans titre",
];

/// The request, from the first exchange. Attachment markers and chat blocks
/// are dropped: "[Image: IMG_0042.jpg]" is not a subject.
pub fn request_body(first_user: &str, first_reply: &str) -> serde_json::Value {
    let user = prepared(first_user);
    let reply = prepared(first_reply);
    serde_json::json!({
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            {
                "role": "user",
                "content": format!("First message:\n{user}\n\nFirst reply:\n{reply}")
            }
        ],
        "temperature": 0.2,
        // Sized for reasoning models: hidden thinking spends from the same
        // budget as the six words, and a cap hit mid-think yields nothing.
        "max_tokens": 400
    })
}

fn prepared(text: &str) -> String {
    let mut kept = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || is_marker(trimmed) {
            continue;
        }
        kept.push(line);
    }
    kept.join("\n").chars().take(MAX_INPUT_CHARS).collect()
}

fn is_marker(line: &str) -> bool {
    (line.starts_with("[Image: ") || line.starts_with("[File: ")) && line.ends_with(']')
}

/// The model's answer as a title, or `None` when there is none worth keeping.
pub fn clean(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut text = line.to_string();
    for prefix in ["title:", "titre :", "titre:", "title :"] {
        if text.to_lowercase().starts_with(prefix) {
            text = text[prefix.len()..].trim().to_string();
        }
    }
    let text: String = text
        .trim_matches(|c: char| {
            matches!(
                c,
                '"' | '\'' | '`' | '«' | '»' | '“' | '”' | '‘' | '’' | '*' | '_' | '#'
            ) || c.is_whitespace()
        })
        .trim_end_matches(['.', ':', ';', '!', '?', '…', ','])
        .trim()
        .to_string();
    let words: Vec<&str> = text.split_whitespace().take(MAX_WORDS).collect();
    let mut title = String::new();
    for word in words {
        let next = if title.is_empty() {
            word.to_string()
        } else {
            format!("{title} {word}")
        };
        if next.chars().count() > MAX_CHARS {
            break;
        }
        title = next;
    }
    let title = title
        .trim_end_matches(['.', ':', ';', '!', '?', '…', ',', '-'])
        .trim()
        .to_string();
    if title.is_empty() || GENERIC.contains(&title.to_lowercase().as_str()) {
        return None;
    }
    Some(title)
}

/// One call through the local proxy. `Ok(None)` when the model answered but
/// said nothing usable.
pub(crate) async fn generate(
    first_user: &str,
    first_reply: &str,
) -> Result<Option<String>, AppError> {
    let response =
        june_api::proxy_agent_chat_completions(request_body(first_user, first_reply)).await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            "chat_title_failed",
            format!("Title generation returned status {}.", response.status),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("chat_title_invalid", error.to_string()))?;
    Ok(june_api::extract_chat_completion_text(&value).and_then(|text| clean(&text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_plain_title() {
        assert_eq!(
            clean("Horaires du BHNS").as_deref(),
            Some("Horaires du BHNS")
        );
    }

    #[test]
    fn strips_what_models_add() {
        assert_eq!(
            clean("« Plan de la réunion. »").as_deref(),
            Some("Plan de la réunion")
        );
        assert_eq!(clean("Titre : Budget 2027").as_deref(), Some("Budget 2027"));
        assert_eq!(
            clean("\"Trip to Lisbon\"\nBecause the user asked…").as_deref(),
            Some("Trip to Lisbon")
        );
        assert_eq!(
            clean("**Recette de risotto**").as_deref(),
            Some("Recette de risotto")
        );
    }

    #[test]
    fn caps_words_and_characters() {
        assert_eq!(
            clean("un deux trois quatre cinq six sept huit").as_deref(),
            Some("un deux trois quatre cinq six")
        );
        let long = "Anticonstitutionnellement ".repeat(4);
        assert!(clean(&long).unwrap().chars().count() <= MAX_CHARS);
    }

    #[test]
    fn refuses_a_title_that_says_nothing() {
        assert_eq!(clean("Nouvelle conversation"), None);
        assert_eq!(clean("   \n  "), None);
        assert_eq!(clean("\"\""), None);
    }

    #[test]
    fn leaves_markers_and_blocks_out_of_the_request() {
        let body = request_body(
            "[Image: IMG_0042.jpg]\nWhat is on this plan?",
            "```subrosa:place\n{}\n```\nIt is the Vernier junction.",
        );
        let content = body["messages"][1]["content"].as_str().unwrap();
        assert!(!content.contains("IMG_0042"));
        assert!(!content.contains("subrosa:place"));
        assert!(content.contains("Vernier junction"));
    }
}
