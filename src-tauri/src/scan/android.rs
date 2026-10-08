//! ML Kit's document scanner and text recognizer, through `DocumentScanner.kt`.
//!
//! The scanner is Google's own activity, launched for a result; the plugin
//! answers once the person is done, so the call blocks for as long as they
//! hold the camera. It runs on a blocking thread, never on the async runtime.

use super::NativeScan;
use crate::domain::types::AppError;

pub(super) async fn scan(pdf_path: &std::path::Path) -> Result<NativeScan, AppError> {
    let payload = serde_json::json!({ "outputPath": pdf_path });
    tokio::task::spawn_blocking(move || {
        crate::android::invoke::<NativeScan>("scanDocument", payload)
    })
    .await
    .map_err(|_| {
        AppError::new(
            "document_scan_failed",
            "The document could not be scanned. Try again.",
        )
    })?
}

/// The scan's PDF to the share sheet. Kotlin repeats the confinement to the
/// scans folder before it exposes anything through the FileProvider.
pub(super) fn share(path: &std::path::Path) -> Result<(), AppError> {
    crate::android::invoke::<serde_json::Value>("shareScan", serde_json::json!({ "path": path }))?;
    Ok(())
}
