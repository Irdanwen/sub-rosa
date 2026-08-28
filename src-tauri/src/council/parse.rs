//! Getting a JSON object out of what a model actually returns.
//!
//! Every phase of a sitting asks for "one JSON object and nothing else", and
//! models comply most of the time. The rest of the time they wrap it in a
//! fence, prefix it with "Here is the mandate:", or -- reasoning models
//! especially -- emit a paragraph of thinking first. None of that is worth a
//! retry, because the object is right there.
//!
//! So: find the first balanced `{...}` that parses, respecting strings and
//! escapes so a brace inside a value cannot end the scan early. A failure here
//! is a real failure (the seat said nothing usable) and is recorded as one.

/// The first balanced JSON object in `text`, or `None`.
pub fn extract_json_object(text: &str) -> Option<serde_json::Value> {
    let bytes = text.as_bytes();
    let mut start = 0usize;
    while let Some(open) = find_from(bytes, start, b'{') {
        if let Some(end) = balanced_end(bytes, open) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text[open..=end]) {
                if value.is_object() {
                    return Some(value);
                }
            }
        }
        start = open + 1;
    }
    None
}

fn find_from(bytes: &[u8], from: usize, needle: u8) -> Option<usize> {
    (from..bytes.len()).find(|&index| bytes[index] == needle)
}

/// Index of the `}` closing the `{` at `open`, skipping braces inside strings.
fn balanced_end(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, &byte) in bytes.iter().enumerate().skip(open) {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// A list of strings from a JSON value, trimmed and de-blanked.
///
/// Tolerant on purpose: a model that returns a bare string where a list was
/// asked for meant a list of one, and refusing it would throw away a good
/// answer over punctuation.
pub fn string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        Some(serde_json::Value::String(single)) => {
            let trimmed = single.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => Vec::new(),
    }
}

pub fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_object_parses() {
        let value = extract_json_object(r#"{"objective":"go faster"}"#).expect("object");
        assert_eq!(string_field(&value, "objective"), "go faster");
    }

    #[test]
    fn a_fenced_object_parses() {
        let value =
            extract_json_object("```json\n{\"objective\":\"go faster\"}\n```").expect("object");
        assert_eq!(string_field(&value, "objective"), "go faster");
    }

    #[test]
    fn a_preamble_does_not_stop_it() {
        let value = extract_json_object(
            "Let me think about this. The user wants speed.\n\nHere is the mandate:\n\n{\"objective\":\"go faster\"}",
        )
        .expect("object");
        assert_eq!(string_field(&value, "objective"), "go faster");
    }

    #[test]
    fn a_brace_inside_a_string_does_not_end_the_scan() {
        let value = extract_json_object(
            r#"{"objective":"emit a { and a } literally","firstStep":"start"}"#,
        )
        .expect("object");
        assert_eq!(string_field(&value, "firstStep"), "start");
    }

    #[test]
    fn an_escaped_quote_does_not_end_the_string() {
        let value =
            extract_json_object(r#"{"objective":"say \"done\" and stop","firstStep":"go"}"#)
                .expect("object");
        assert_eq!(string_field(&value, "firstStep"), "go");
    }

    #[test]
    fn nested_objects_are_kept_whole() {
        let value = extract_json_object(
            r#"{"acceptance":[{"statement":"a","verifiedBy":"b"}],"firstStep":"go"}"#,
        )
        .expect("object");
        assert_eq!(value["acceptance"][0]["verifiedBy"], "b");
    }

    #[test]
    fn a_stray_brace_before_the_object_is_skipped() {
        // A reasoning model narrating "{ this is not json }" before answering.
        let value = extract_json_object("thinking { about it } then:\n{\"firstStep\":\"go\"}")
            .expect("object");
        assert_eq!(string_field(&value, "firstStep"), "go");
    }

    #[test]
    fn nothing_usable_is_none_rather_than_a_guess() {
        assert!(extract_json_object("I could not do that.").is_none());
        assert!(extract_json_object("{\"unterminated\": ").is_none());
    }

    #[test]
    fn a_bare_string_where_a_list_was_asked_for_is_read_as_one() {
        let value = extract_json_object(r#"{"deliverable":"one file"}"#).expect("object");
        assert_eq!(string_list(value.get("deliverable")), vec!["one file"]);
    }

    #[test]
    fn blank_entries_never_spend_a_slot() {
        let value =
            extract_json_object(r#"{"deliverable":["a","","   ",null,"b"]}"#).expect("object");
        assert_eq!(string_list(value.get("deliverable")), vec!["a", "b"]);
    }
}
