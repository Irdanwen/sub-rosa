//! The phone's scanning commands. Mobile only: the desktop has no document
//! camera to open (see `platform_specific` in `tests/shared_commands.rs`).

use super::{
    note_body, pdf_path, plain_text, stale_pdfs, DocumentScanRequest, DocumentScanResult,
    NativeScan, PENDING_PREFIX, SCANS_DIR,
};
use crate::domain::types::AppError;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn scans_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("document_scan_storage", error.to_string()))?
        .join(SCANS_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::new("document_scan_storage", error.to_string()))?;
    Ok(dir)
}

/// Opens the document camera, then writes what it read into a new note and
/// keeps the PDF beside it. `Ok(None)` when the person closed the camera.
#[tauri::command]
pub async fn document_scan(
    app: AppHandle,
    request: DocumentScanRequest,
) -> Result<Option<DocumentScanResult>, AppError> {
    let dir = scans_dir(&app)?;
    let repos = crate::commands::repositories(&app).await?;
    prune(&repos, &dir).await;

    let pending = dir.join(format!("{PENDING_PREFIX}{}.pdf", uuid::Uuid::new_v4()));
    let scan: NativeScan = scan_native(&app, &pending).await?;
    if scan.cancelled {
        let _ = std::fs::remove_file(&pending);
        return Ok(None);
    }
    if let Some(error) = scan.error {
        let _ = std::fs::remove_file(&pending);
        tracing::warn!(%error, "document scan failed");
        return Err(AppError::new(
            "document_scan_failed",
            "The document could not be scanned. Try again.",
        ));
    }
    if scan.pages.is_empty() {
        let _ = std::fs::remove_file(&pending);
        return Ok(None);
    }

    // The note first: the text is what the person came for, and a PDF that
    // fails to move still leaves them a note to read.
    let note = repos.create_note(None).await?;
    let title = request
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let body = note_body(&scan.pages, &request.page_heading);
    repos
        .update_note(&note.id, Some(title), Some(body), None)
        .await?;
    match pdf_path(&dir, &note.id) {
        Some(target) => {
            if let Err(error) = std::fs::rename(&pending, &target) {
                tracing::warn!(%error, "document scan PDF could not be kept");
                let _ = std::fs::remove_file(&pending);
            }
        }
        None => {
            let _ = std::fs::remove_file(&pending);
        }
    }
    crate::agent_notes::announce(&app, std::slice::from_ref(&note.id));
    Ok(Some(DocumentScanResult {
        note_id: note.id,
        pages: scan.pages.len(),
        text: plain_text(&scan.pages),
    }))
}

/// Whether the note was scanned and still has its PDF on this device.
#[tauri::command]
pub async fn document_scan_pdf_exists(app: AppHandle, note_id: String) -> Result<bool, AppError> {
    let dir = scans_dir(&app)?;
    Ok(pdf_path(&dir, &note_id).is_some_and(|path| path.is_file()))
}

/// The scan's PDF to the share sheet: Files, Mail, AirDrop, a printer.
#[tauri::command]
pub async fn document_scan_share(app: AppHandle, note_id: String) -> Result<(), AppError> {
    let dir = scans_dir(&app)?;
    let path = pdf_path(&dir, &note_id)
        .filter(|path| path.is_file())
        .ok_or_else(|| {
            AppError::new(
                "document_scan_missing",
                "The scanned PDF is not on this device.",
            )
        })?;
    share_pdf(&app, path)
}

/// Best-effort: a PDF whose note is gone for good, or one a crash left half
/// written. A note in the trash keeps its PDF, since it can come back.
async fn prune(repos: &crate::db::repositories::Repositories, dir: &std::path::Path) {
    let mut live = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if uuid::Uuid::parse_str(stem).is_err() {
            continue;
        }
        match repos.get_note(stem).await {
            Err(sqlx::Error::RowNotFound) => {}
            // Any other answer, including an error, keeps the file.
            _ => {
                live.insert(stem.to_string());
            }
        }
    }
    for stale in stale_pdfs(dir, |id| live.contains(id)) {
        if let Err(error) = std::fs::remove_file(&stale) {
            tracing::debug!(%error, "stale scan PDF not removed");
        }
    }
}

#[cfg(target_os = "ios")]
async fn scan_native(_app: &AppHandle, pending: &std::path::Path) -> Result<NativeScan, AppError> {
    super::ios::scan(pending).await
}

#[cfg(target_os = "android")]
async fn scan_native(_app: &AppHandle, pending: &std::path::Path) -> Result<NativeScan, AppError> {
    super::android::scan(pending).await
}

#[cfg(target_os = "ios")]
fn share_pdf(app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    crate::share_ios::present_file(app, path.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
fn share_pdf(_app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    super::android::share(&path)
}
