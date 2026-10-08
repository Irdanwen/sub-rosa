//! Android's share sheet and gallery exports, behind the shared mobile commands.
//! The source is confined to Studio's gallery (`crate::shareable`). MediaStore owns the destination;
//! the renderer can never choose where native code writes an export.

use crate::domain::types::AppError;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveToPhotosRequest {
    pub path: String,
    pub kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTextRequest {
    pub text: String,
}

/// The root `shareable` names its directories under. On Android this is the
/// package's `dataDir`, which `AndroidExports.kt` checks against too.
fn app_data(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::new("share_file_missing", error.to_string()))
}

#[tauri::command]
pub async fn save_to_photos(app: AppHandle, request: SaveToPhotosRequest) -> Result<(), AppError> {
    let path = crate::shareable::confine(
        &app_data(&app)?,
        &[crate::shareable::GALLERY_DIR],
        std::path::Path::new(&request.path),
        "photos_file_missing",
        "The media file could not be found.",
    )?;
    crate::android::invoke::<serde_json::Value>(
        "saveToPhotos",
        serde_json::json!({ "path": path, "kind": request.kind }),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn share_text(request: ShareTextRequest) -> Result<(), AppError> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err(AppError::new("share_empty", "There is nothing to share."));
    }
    crate::android::invoke::<serde_json::Value>("shareText", serde_json::json!({ "text": text }))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileRequest {
    pub path: String,
}

/// Share a Studio picture as a file, confined to the gallery like an export.
#[tauri::command]
pub async fn share_file(app: AppHandle, request: ShareFileRequest) -> Result<(), AppError> {
    let path = crate::shareable::confine(
        &app_data(&app)?,
        &[crate::shareable::GALLERY_DIR],
        std::path::Path::new(&request.path),
        "share_file_missing",
        "The file could not be found.",
    )?;
    crate::android::invoke::<serde_json::Value>("shareFile", serde_json::json!({ "path": path }))?;
    Ok(())
}
