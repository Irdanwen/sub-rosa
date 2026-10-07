//! A conversation as a Markdown or PDF file the person keeps.
//!
//! The webview writes the conversation as Markdown (title, date, model, each
//! turn under its speaker, chat cards as readable lists; see
//! `src/lib/conversation-export.ts`), because only it holds the desktop's
//! Hermes transcript as the person reads it. Here that Markdown becomes the
//! file: as is, or drawn as a PDF (`pdf.rs`). On the desktop the native save
//! dialog picks where it goes, opened in Rust so the path never crosses IPC
//! (spec `no-write-paths-over-ipc`), the way a note is exported. On the phone
//! it is written to the app's own export folder and handed to the share
//! sheet, which is where Files, Mail and AirDrop live.

pub mod pdf;

use serde::{Deserialize, Serialize};

use crate::domain::types::AppError;

/// A conversation is text: anything near this size is not one.
const MAX_MARKDOWN_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Markdown,
    Pdf,
}

impl ExportFormat {
    fn extension(self) -> &'static str {
        match self {
            ExportFormat::Markdown => "md",
            ExportFormat::Pdf => "pdf",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConversationRequest {
    pub title: String,
    pub markdown: String,
    pub format: ExportFormat,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportConversationResult {
    /// Where the desktop saved it; nothing when the dialog was dismissed, and
    /// nothing on the phone, where the share sheet takes it from here.
    pub path: Option<String>,
    pub bytes: u64,
    /// The share sheet was opened with the file (phone).
    pub shared: bool,
}

/// The file's bytes in the asked format.
pub fn render(request: &ExportConversationRequest) -> Result<Vec<u8>, AppError> {
    if request.markdown.len() > MAX_MARKDOWN_BYTES {
        return Err(AppError::new(
            "conversation_export_too_large",
            "This conversation is too long to export.",
        ));
    }
    Ok(match request.format {
        ExportFormat::Markdown => {
            let mut text = request.markdown.trim_end().to_string();
            text.push('\n');
            text.into_bytes()
        }
        ExportFormat::Pdf => pdf::markdown_to_pdf(&request.title, &request.markdown),
    })
}

/// The file name the title becomes, safe on every file system.
pub fn file_name(title: &str, format: ExportFormat) -> String {
    format!(
        "{}.{}",
        crate::note_export::safe_file_stem(title, "Conversation"),
        format.extension()
    )
}

fn export_failed(error: impl std::fmt::Display) -> AppError {
    AppError::new("conversation_export_failed", error.to_string())
}

#[tauri::command]
pub async fn export_conversation(
    app: tauri::AppHandle,
    request: ExportConversationRequest,
) -> Result<ExportConversationResult, AppError> {
    let bytes = render(&request)?;
    let name = file_name(&request.title, request.format);
    deliver(&app, &name, request.format, bytes).await
}

#[cfg(desktop)]
async fn deliver(
    app: &tauri::AppHandle,
    name: &str,
    format: ExportFormat,
    bytes: Vec<u8>,
) -> Result<ExportConversationResult, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let filter = match format {
        ExportFormat::Markdown => "Markdown",
        ExportFormat::Pdf => "PDF",
    };
    app.dialog()
        .file()
        .set_file_name(name)
        .add_filter(filter, &[format.extension()])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.await.map_err(export_failed)?;
    let Some(target) = picked.and_then(|path| path.into_path().ok()) else {
        return Ok(ExportConversationResult {
            path: None,
            bytes: 0,
            shared: false,
        });
    };
    std::fs::write(&target, &bytes).map_err(export_failed)?;
    Ok(ExportConversationResult {
        path: Some(target.display().to_string()),
        bytes: bytes.len() as u64,
        shared: false,
    })
}

/// The phone writes the file into its own export folder, emptied first so
/// only the latest export ever sits there, and hands it to the share sheet.
#[cfg(mobile)]
async fn deliver(
    app: &tauri::AppHandle,
    name: &str,
    _format: ExportFormat,
    bytes: Vec<u8>,
) -> Result<ExportConversationResult, AppError> {
    use tauri::Manager;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(export_failed)?
        .join("exports");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(export_failed)?;
    }
    std::fs::create_dir_all(&dir).map_err(export_failed)?;
    let target = dir.join(name);
    std::fs::write(&target, &bytes).map_err(export_failed)?;
    share(app, &target)?;
    Ok(ExportConversationResult {
        path: None,
        bytes: bytes.len() as u64,
        shared: true,
    })
}

#[cfg(target_os = "ios")]
fn share(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), AppError> {
    crate::share_ios::present_file(app, path.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
fn share(_app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), AppError> {
    crate::android::invoke::<serde_json::Value>("shareFile", serde_json::json!({ "path": path }))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(format: ExportFormat) -> ExportConversationRequest {
        ExportConversationRequest {
            title: "Plan: Q4 / budget?".into(),
            markdown: "# Plan\n\n## You\n\nHi\n\n\n".into(),
            format,
        }
    }

    #[test]
    fn markdown_is_written_as_given_with_one_final_newline() {
        let bytes = render(&request(ExportFormat::Markdown)).unwrap();
        assert_eq!(bytes, b"# Plan\n\n## You\n\nHi\n");
    }

    #[test]
    fn pdf_is_a_pdf_and_the_name_is_safe() {
        let bytes = render(&request(ExportFormat::Pdf)).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        assert_eq!(
            file_name("Plan: Q4 / budget?", ExportFormat::Pdf),
            "Plan Q4 budget.pdf"
        );
        assert_eq!(file_name("  ", ExportFormat::Markdown), "Conversation.md");
    }

    #[test]
    fn an_oversized_conversation_is_refused() {
        let mut big = request(ExportFormat::Markdown);
        big.markdown = "x".repeat(MAX_MARKDOWN_BYTES + 1);
        assert!(render(&big).is_err());
    }

    #[test]
    fn the_format_reads_as_the_webview_names_it() {
        let parsed: ExportConversationRequest = serde_json::from_value(serde_json::json!({
            "title": "t", "markdown": "m", "format": "pdf"
        }))
        .unwrap();
        assert_eq!(parsed.format, ExportFormat::Pdf);
    }
}
