//! Save Studio artifacts to the iOS photo library.
//!
//! The webview cannot reach the photo library, so the lightbox's "save"
//! action calls into UIKit: `UIImageWriteToSavedPhotosAlbum` for images and
//! `UISaveVideoAtPathToSavedPhotosAlbum` for clips. Both must run on the main
//! thread; `NSPhotoLibraryAddUsageDescription` (Info.plist) covers the
//! permission prompt. Fire-and-forget: iOS surfaces its own denial UI, and a
//! nil completion target keeps this free of callback plumbing.

use crate::domain::types::AppError;
use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_foundation::NSString;
use serde::Deserialize;
use tauri::AppHandle;

// UIKit's C entry points for the saved-photos album.
unsafe extern "C" {
    fn UIImageWriteToSavedPhotosAlbum(
        image: *mut AnyObject,
        target: *mut AnyObject,
        selector: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
    );
    fn UISaveVideoAtPathToSavedPhotosAlbum(
        path: *mut AnyObject,
        target: *mut AnyObject,
        selector: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
    ) -> bool;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveToPhotosRequest {
    /// Absolute path of the artifact inside the app sandbox.
    pub path: String,
    /// "image" or "video".
    pub kind: String,
}

#[tauri::command]
pub async fn save_to_photos(app: AppHandle, request: SaveToPhotosRequest) -> Result<(), AppError> {
    let path = std::path::PathBuf::from(&request.path);
    if !path.exists() {
        return Err(AppError::new(
            "photos_file_missing",
            "The media file could not be found.",
        ));
    }
    let is_video = request.kind == "video";
    let bytes = if is_video {
        Vec::new()
    } else {
        std::fs::read(&path)
            .map_err(|error| AppError::new("photos_read_failed", error.to_string()))?
    };
    let path_string = path.to_string_lossy().into_owned();
    app.run_on_main_thread(move || {
        if is_video {
            let ns_path = NSString::from_str(&path_string);
            unsafe {
                let _ = UISaveVideoAtPathToSavedPhotosAlbum(
                    &*ns_path as *const NSString as *mut AnyObject,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
            }
        } else {
            unsafe {
                let data_class = objc2::runtime::AnyClass::get(c"NSData");
                let image_class = objc2::runtime::AnyClass::get(c"UIImage");
                let (Some(data_class), Some(image_class)) = (data_class, image_class) else {
                    return;
                };
                let data: *mut AnyObject = msg_send![
                    data_class,
                    dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void,
                    length: bytes.len()
                ];
                if data.is_null() {
                    return;
                }
                let image: *mut AnyObject = msg_send![image_class, imageWithData: data];
                if image.is_null() {
                    return;
                }
                UIImageWriteToSavedPhotosAlbum(
                    image,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
            }
        }
    })
    .map_err(|error| AppError::new("photos_save_failed", error.to_string()))?;
    Ok(())
}
