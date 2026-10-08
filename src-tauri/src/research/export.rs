//! A report (any note, in fact) as a file: Markdown, PDF or Word.
//!
//! The note is read from the database, not from the webview, so what is
//! exported is what is saved, including the person's edits to the report.
//! The PDF is the conversation export's writer and the Word file
//! [`crate::docx`]'s. Delivery is the conversation export's too: the native
//! save dialog on the desktop, opened in Rust so no path crosses IPC (spec
//! `no-write-paths-over-ipc`), and the share sheet on the phone.

use serde::Deserialize;
use tauri::AppHandle;

use crate::conversation_export::ExportConversationResult;
use crate::domain::types::AppError;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    Markdown,
    Pdf,
    Docx,
}

impl DocumentFormat {
    fn extension(self) -> &'static str {
        match self {
            DocumentFormat::Markdown => "md",
            DocumentFormat::Pdf => "pdf",
            DocumentFormat::Docx => "docx",
        }
    }

    fn filter(self) -> &'static str {
        match self {
            DocumentFormat::Markdown => "Markdown",
            DocumentFormat::Pdf => "PDF",
            DocumentFormat::Docx => "Word",
        }
    }
}

/// The file's bytes for a note's Markdown (title heading included).
pub fn render(title: &str, markdown: &str, format: DocumentFormat) -> Result<Vec<u8>, AppError> {
    Ok(match format {
        DocumentFormat::Markdown => {
            let mut text = markdown.trim_end().to_string();
            text.push('\n');
            text.into_bytes()
        }
        DocumentFormat::Pdf => crate::conversation_export::pdf::markdown_to_pdf(title, markdown),
        DocumentFormat::Docx => crate::docx::markdown_to_docx(title, markdown)?,
    })
}

pub fn file_name(title: &str, format: DocumentFormat) -> String {
    format!(
        "{}.{}",
        crate::note_export::safe_file_stem(title, "Report"),
        format.extension()
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocumentRequest {
    pub note_id: String,
    pub format: DocumentFormat,
}

#[tauri::command]
pub async fn note_export_document(
    app: AppHandle,
    request: ExportDocumentRequest,
) -> Result<ExportConversationResult, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let note = repos.get_note(request.note_id.trim()).await?;
    let markdown = crate::note_export::note_markdown(&note);
    let bytes = render(&note.title, &markdown, request.format)?;
    let name = file_name(&note.title, request.format);
    crate::conversation_export::deliver(
        &app,
        &name,
        (request.format.filter(), request.format.extension()),
        bytes,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_format_writes_what_it_says() {
        let markdown = "# Report\n\n## Executive summary\n\nIt holds [1].\n\n## Sources\n\n1. [A](https://a.example)\n";
        let md = render("Report", markdown, DocumentFormat::Markdown).unwrap();
        assert_eq!(md, markdown.as_bytes());
        assert!(render("Report", markdown, DocumentFormat::Pdf)
            .unwrap()
            .starts_with(b"%PDF-"));
        assert!(render("Report", markdown, DocumentFormat::Docx)
            .unwrap()
            .starts_with(b"PK"));
        assert_eq!(
            file_name("Heat: pumps?", DocumentFormat::Docx),
            "Heat pumps.docx"
        );
        assert_eq!(file_name(" ", DocumentFormat::Pdf), "Report.pdf");
    }

    #[test]
    fn the_format_reads_as_the_webview_names_it() {
        let request: ExportDocumentRequest =
            serde_json::from_value(serde_json::json!({ "noteId": "n", "format": "docx" })).unwrap();
        assert_eq!(request.format, DocumentFormat::Docx);
    }
}
