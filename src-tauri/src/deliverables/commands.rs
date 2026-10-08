//! What the `subrosa:file` card can ask of a document it shows. The card
//! names a file; these commands find it in the gallery's documents folder and
//! nowhere else, so a block a model wrote cannot reach any other file.

use std::path::PathBuf;

use serde::Deserialize;
use tauri::AppHandle;

use crate::domain::types::AppError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverableRequest {
    pub file: String,
}

/// `<uuid>.<docx|xlsx|pptx>`, the only names [`super::make`] writes.
pub(crate) fn is_document_name(file: &str) -> bool {
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    uuid::Uuid::parse_str(stem).is_ok()
        && stem.len() == 36
        && super::DocumentKind::parse(extension).is_some_and(|kind| kind.extension() == extension)
}

fn resolve(app: &AppHandle, file: &str) -> Result<PathBuf, AppError> {
    if !is_document_name(file) {
        return Err(AppError::new(
            "deliverable_missing",
            "The file could not be found.",
        ));
    }
    let dir = super::documents_dir(app)?;
    crate::path_confinement::confine_existing(
        std::slice::from_ref(&dir),
        &dir.join(file),
        "deliverable_missing",
        "The file could not be found.",
    )
}

/// The document's absolute path, for "Save a copy" (the gallery export,
/// which opens its own dialog and confines the path again).
#[tauri::command]
pub async fn deliverable_path(
    app: AppHandle,
    request: DeliverableRequest,
) -> Result<String, AppError> {
    Ok(resolve(&app, &request.file)?.to_string_lossy().into_owned())
}

/// Opens the document: in its default app on the computer, in the share
/// sheet on the phone (which offers the apps that open it and "Save to
/// Files").
#[tauri::command]
pub async fn deliverable_open(app: AppHandle, request: DeliverableRequest) -> Result<(), AppError> {
    let path = resolve(&app, &request.file)?;
    open(&app, path)
}

#[cfg(desktop)]
fn open(_app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        crate::win_console::hide_console(&mut command);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::new("deliverable_open_failed", error.to_string()))
}

#[cfg(target_os = "ios")]
fn open(app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    crate::share_ios::present_file(app, path.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
fn open(_app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    crate::android::invoke::<serde_json::Value>("shareFile", serde_json::json!({ "path": path }))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_names_the_tool_writes_are_accepted() {
        assert!(is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.docx"
        ));
        assert!(is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.pptx"
        ));
        assert!(!is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.DOCX"
        ));
        assert!(!is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.png"
        ));
        assert!(!is_document_name(
            "../0b7c1d2e-1111-4222-8333-444455556666.docx"
        ));
        assert!(!is_document_name("0b7c1d2e11114222833344445555666.docx"));
        assert!(!is_document_name("notes.docx"));
        assert!(!is_document_name("docx"));
    }
}
