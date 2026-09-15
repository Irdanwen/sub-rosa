//! Android's share sheet and gallery exports, behind the shared mobile commands.
//! The source is confined to Studio's gallery. MediaStore owns the destination;
//! the renderer can never choose where native code writes an export.

use crate::domain::types::AppError;
use serde::Deserialize;
use tauri::AppHandle;

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

#[tauri::command]
pub async fn save_to_photos(app: AppHandle, request: SaveToPhotosRequest) -> Result<(), AppError> {
    let gallery = crate::carpe_diem::media::artifacts_dir(&app)?;
    let path = crate::path_confinement::confine_existing(
        &[gallery],
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
