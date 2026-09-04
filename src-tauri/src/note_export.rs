//! A note as a Markdown file on disk.
//!
//! The note body already round-trips through Markdown (ADR-0037), so the
//! export is the stored text with the title on top, written where the
//! person points the native save dialog. The dialog is opened here, in
//! Rust, and the path never crosses IPC (spec `no-write-paths-over-ipc`).
//! Desktop only: the phone shares the same text through the share sheet.

use serde::{Deserialize, Serialize};

use crate::domain::types::NoteDto;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportNoteMarkdownRequest {
    pub note_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportNoteMarkdownResult {
    /// Where the file went, or nothing when the dialog was dismissed.
    pub path: Option<String>,
    pub bytes: u64,
}

/// The Markdown a note exports as: the title as a heading, then the edited
/// body when there is one, the generated one otherwise.
pub fn note_markdown(note: &NoteDto) -> String {
    let title = note.title.trim();
    let body = note
        .edited_content
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .or(note.generated_content.as_deref())
        .unwrap_or("")
        .trim();
    let mut out = String::new();
    if !title.is_empty() {
        out.push_str("# ");
        out.push_str(title);
        out.push_str("\n\n");
    }
    out.push_str(body);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// A file name the title can become on every desktop file system.
pub fn suggested_file_name(title: &str) -> String {
    let cleaned: String = title
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem = if cleaned.is_empty() {
        "Note".to_string()
    } else {
        cleaned.chars().take(80).collect::<String>()
    };
    format!("{stem}.md")
}

#[cfg(desktop)]
#[tauri::command]
pub async fn export_note_markdown(
    app: tauri::AppHandle,
    request: ExportNoteMarkdownRequest,
) -> Result<ExportNoteMarkdownResult, crate::domain::types::AppError> {
    use crate::domain::types::AppError;
    use tauri_plugin_dialog::DialogExt;

    let repos = crate::commands::repositories(&app).await?;
    let note = repos.get_note(&request.note_id).await?;
    let markdown = note_markdown(&note);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(suggested_file_name(&note.title))
        .add_filter("Markdown", &["md"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|error| AppError::new("note_export_failed", error.to_string()))?;
    let Some(target) = picked.and_then(|path| path.into_path().ok()) else {
        return Ok(ExportNoteMarkdownResult {
            path: None,
            bytes: 0,
        });
    };
    std::fs::write(&target, markdown.as_bytes())
        .map_err(|error| AppError::new("note_export_failed", error.to_string()))?;
    Ok(ExportNoteMarkdownResult {
        path: Some(target.display().to_string()),
        bytes: markdown.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::{note_markdown, suggested_file_name};
    use crate::domain::types::NoteDto;

    fn note(title: &str, edited: Option<&str>, generated: Option<&str>) -> NoteDto {
        serde_json::from_value(serde_json::json!({
            "id": "n1",
            "title": title,
            "preview": "",
            "processingStatus": "ready",
            "folderIds": [],
            "createdAt": "2026-09-04T00:00:00Z",
            "updatedAt": "2026-09-04T00:00:00Z",
            "editedContent": edited,
            "generatedContent": generated,
        }))
        .expect("a note from its wire shape")
    }

    #[test]
    fn the_edited_body_wins_and_the_title_becomes_a_heading() {
        let md = note_markdown(&note(" Budget ", Some("- holds"), Some("old")));
        assert_eq!(md, "# Budget\n\n- holds\n");
        let md = note_markdown(&note("", Some("   "), Some("generated")));
        assert_eq!(md, "generated\n");
    }

    #[test]
    fn the_file_name_is_safe_on_every_desktop() {
        assert_eq!(
            suggested_file_name("Q3: budget / review?"),
            "Q3 budget review.md"
        );
        assert_eq!(suggested_file_name("   "), "Note.md");
    }
}
