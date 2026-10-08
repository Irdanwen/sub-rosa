//! What the assistant asks a Word document to hold, as the Markdown the Word
//! writer (`crate::docx`, ADR-0089) already reads. One writer serves the
//! research report, a note's export and this tool, so a heading, a list or a
//! table comes out the same whichever asked for it.

use serde_json::Value;

use super::invalid;
use crate::domain::types::AppError;

const MAX_SECTIONS: usize = 200;
const MAX_ROWS: usize = 500;
const MAX_CHARS: usize = 400_000;

/// `content` is Markdown (a string, or `{markdown}`), or `{sections: [{heading?,
/// level?, paragraphs?, bullets?, numbered?, table?, quote?}]}` where `table`
/// is `{header?, rows}` or an array of rows.
pub(super) fn markdown(content: &Value) -> Result<String, AppError> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Object(map) => match (map.get("markdown"), map.get("sections")) {
            (Some(Value::String(text)), _) => text.clone(),
            (_, Some(Value::Array(sections))) => sections_markdown(sections),
            _ => String::new(),
        },
        Value::Array(sections) => sections_markdown(sections),
        _ => String::new(),
    };
    if text.trim().is_empty() {
        return Err(invalid(
            "A document needs content: Markdown text, or content.sections with headings, paragraphs, lists and tables.",
        ));
    }
    Ok(text.chars().take(MAX_CHARS).collect())
}

fn sections_markdown(sections: &[Value]) -> String {
    let mut out = String::new();
    for section in sections.iter().take(MAX_SECTIONS) {
        let Some(map) = section.as_object() else {
            if let Some(text) = section.as_str() {
                push_block(&mut out, text.trim());
            }
            continue;
        };
        if let Some(heading) = map
            .get("heading")
            .or_else(|| map.get("title"))
            .and_then(Value::as_str)
        {
            let level = map
                .get("level")
                .and_then(Value::as_u64)
                .map_or(2, |level| level.clamp(1, 3)) as usize;
            push_block(
                &mut out,
                &format!("{} {}", "#".repeat(level), one_line(heading)),
            );
        }
        for paragraph in strings(map.get("paragraphs").or_else(|| map.get("text"))) {
            push_block(&mut out, paragraph.trim());
        }
        let bullets: Vec<String> = strings(map.get("bullets"))
            .iter()
            .map(|item| format!("- {}", one_line(item)))
            .collect();
        push_block(&mut out, &bullets.join("\n"));
        let numbered: Vec<String> = strings(map.get("numbered"))
            .iter()
            .enumerate()
            .map(|(index, item)| format!("{}. {}", index + 1, one_line(item)))
            .collect();
        push_block(&mut out, &numbered.join("\n"));
        if let Some(table) = map.get("table") {
            push_block(&mut out, &table_markdown(table));
        }
        if let Some(quote) = map.get("quote").and_then(Value::as_str) {
            let quoted: Vec<String> = quote.lines().map(|line| format!("> {line}")).collect();
            push_block(&mut out, &quoted.join("\n"));
        }
    }
    out
}

fn push_block(out: &mut String, block: &str) {
    if block.is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(block);
}

/// A string, or the strings of an array (numbers written as they read).
fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(cell_text).collect(),
        _ => Vec::new(),
    }
}

fn cell_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn table_markdown(table: &Value) -> String {
    let (header, rows) = match table {
        Value::Object(map) => (
            map.get("header").or_else(|| map.get("columns")),
            map.get("rows"),
        ),
        Value::Array(_) => (None, Some(table)),
        _ => (None, None),
    };
    let row_cells = |row: &Value| -> Vec<String> {
        match row {
            Value::Array(cells) => cells
                .iter()
                .map(|cell| cell_text(cell).unwrap_or_else(|| cell.to_string()))
                .map(|cell| one_line(&cell).replace('|', "\\|"))
                .collect(),
            other => vec![one_line(&cell_text(other).unwrap_or_default()).replace('|', "\\|")],
        }
    };
    let mut all: Vec<Vec<String>> = Vec::new();
    if let Some(header) = header {
        all.push(row_cells(header));
    }
    if let Some(Value::Array(rows)) = rows {
        all.extend(rows.iter().take(MAX_ROWS).map(row_cells));
    }
    if all.is_empty() {
        return String::new();
    }
    let columns = all.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let line = |cells: &[String]| {
        let mut padded: Vec<String> = cells.to_vec();
        padded.resize(columns, String::new());
        format!("| {} |", padded.join(" | "))
    };
    let mut lines = vec![line(&all[0])];
    lines.push(format!("|{}", "---|".repeat(columns)));
    lines.extend(all[1..].iter().map(|cells| line(cells)));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sections_become_the_markdown_the_word_writer_reads() {
        let text = markdown(&json!({"sections": [
            {"heading": "Summary", "level": 1, "paragraphs": ["It **works**.", "Twice."]},
            {"heading": "Steps", "bullets": ["One\nline"], "numbered": ["First", "Second"]},
            {"heading": "Costs", "table": {"header": ["Item", "Price"], "rows": [["A | B", 3.5], ["C"]]}},
            {"quote": "Said once"}
        ]}))
        .unwrap();
        assert_eq!(
            text,
            "# Summary\n\nIt **works**.\n\nTwice.\n\n## Steps\n\n- One line\n\n1. First\n2. Second\n\n## Costs\n\n| Item | Price |\n|---|---|\n| A \\| B | 3.5 |\n| C |  |\n\n> Said once"
        );
    }

    #[test]
    fn markdown_passes_through_and_empty_content_is_refused() {
        assert_eq!(markdown(&json!("# Hi")).unwrap(), "# Hi");
        assert_eq!(markdown(&json!({"markdown": "Body"})).unwrap(), "Body");
        assert!(markdown(&json!({"sections": []})).is_err());
        assert!(markdown(&json!(42)).is_err());
    }
}
