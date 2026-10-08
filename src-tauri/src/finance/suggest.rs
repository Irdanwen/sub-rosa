//! Categories the model proposes for what no rule filed. The person sees
//! each proposal and accepts or dismisses it; nothing is filed on the
//! model's word alone. Only descriptions are sent, never an amount, a
//! balance or an account, and only when the person asks.

use super::CATEGORIES;
use crate::domain::types::AppError;
use sqlx_sqlite::SqlitePool;

/// Descriptions sent in one request: enough for a month of statements,
/// small enough to answer quickly.
const BATCH: usize = 60;
const SYSTEM_PROMPT: &str = "You file bank transactions into spending categories. You receive numbered transaction descriptions as they appear on a bank statement (Swiss, French or other European banks, any language). Answer with one JSON object mapping each number to exactly one category key from this list, or to null when the description does not say enough: {categories}. Use \"transfers\" for money moved between the person's own accounts, \"income\" for salary and refunds, \"cash\" for cash withdrawals. Answer with the JSON object only.";

pub fn request_body(descriptions: &[String]) -> serde_json::Value {
    let numbered: Vec<String> = descriptions
        .iter()
        .enumerate()
        .map(|(at, description)| format!("{}. {}", at + 1, description))
        .collect();
    serde_json::json!({
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT.replace("{categories}", &CATEGORIES.join(", ")) },
            { "role": "user", "content": numbered.join("\n") }
        ],
        "temperature": 0,
        "max_tokens": 2000
    })
}

/// Reads the model's answer: a JSON object (possibly fenced) from line
/// numbers to category keys. Unknown keys and numbers are dropped.
pub fn parse_answer(answer: &str, descriptions: &[String]) -> Vec<(String, String)> {
    let start = answer.find('{');
    let end = answer.rfind('}');
    let (Some(start), Some(end)) = (start, end) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&answer[start..=end]) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (number, category) in map {
        let Some(category) = category.as_str().map(str::trim) else {
            continue;
        };
        let Some(at) = number
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
        else {
            continue;
        };
        if let (Some(description), true) = (descriptions.get(at), CATEGORIES.contains(&category)) {
            found.push((description.clone(), category.to_string()));
        }
    }
    found
}

/// Asks for proposals and stores them. Answers how many transactions got one.
pub async fn suggest(pool: &SqlitePool) -> Result<usize, AppError> {
    let descriptions = super::store::open_descriptions(pool, BATCH).await?;
    if descriptions.is_empty() {
        return Ok(0);
    }
    let failed = || {
        AppError::new(
            "finance_suggest_failed",
            "Categories could not be suggested right now. Try again.",
        )
    };
    let response =
        crate::june_api::proxy_agent_chat_completions(request_body(&descriptions)).await?;
    if !(200..300).contains(&response.status) {
        return Err(failed());
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|_| failed())?;
    let text = crate::june_api::extract_chat_completion_text(&value).ok_or_else(failed)?;
    let proposals = parse_answer(&text, &descriptions);
    super::store::store_suggestions(pool, &proposals).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_request_carries_descriptions_only() {
        let body = request_body(&["COOP-1234 LAUSANNE".into(), "SBB EASYRIDE".into()]);
        let user = body["messages"][1]["content"].as_str().unwrap();
        assert_eq!(user, "1. COOP-1234 LAUSANNE\n2. SBB EASYRIDE");
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("groceries, dining"));
    }

    #[test]
    fn a_fenced_answer_is_read_and_strays_are_dropped() {
        let descriptions = vec!["COOP".to_string(), "SBB".to_string(), "???".to_string()];
        let answer = "```json\n{\"1\": \"groceries\", \"2\": \"transport\", \"3\": null, \"9\": \"dining\", \"1x\": \"fees\"}\n```";
        let mut found = parse_answer(answer, &descriptions);
        found.sort();
        assert_eq!(
            found,
            vec![
                ("COOP".to_string(), "groceries".to_string()),
                ("SBB".to_string(), "transport".to_string())
            ]
        );
        assert!(parse_answer("{\"1\": \"made up\"}", &descriptions).is_empty());
        assert!(parse_answer("I cannot help", &descriptions).is_empty());
    }
}
