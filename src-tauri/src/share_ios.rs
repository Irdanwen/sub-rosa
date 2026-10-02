//! iOS share sheet (UIActivityViewController).
//!
//! Note export on the phone goes through the system share sheet: Files,
//! AirDrop, Mail, Messages, third-party apps. The webview cannot present
//! native view controllers, so this command bridges to UIKit. Text, and a
//! Studio picture as a file (a retouch shared to Messages or AirDrop); saving
//! to the photo library is photos_ios.rs.

use crate::domain::types::AppError;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::{NSArray, NSString};
use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTextRequest {
    pub text: String,
}

#[tauri::command]
pub async fn share_text(app: AppHandle, request: ShareTextRequest) -> Result<(), AppError> {
    let text = request.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::new("share_empty", "There is nothing to share."));
    }
    app.run_on_main_thread(move || unsafe {
        let payload = NSString::from_str(&text);
        let items: Retained<NSArray<NSString>> = NSArray::from_retained_slice(&[payload]);
        present_activity(&*items as *const NSArray<NSString> as *mut AnyObject);
    })
    .map_err(|error| AppError::new("share_failed", error.to_string()))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileRequest {
    pub path: String,
}

/// Share a Studio picture as a file. The path is confined to the gallery: the
/// webview names a file, it never chooses one outside it.
#[tauri::command]
pub async fn share_file(app: AppHandle, request: ShareFileRequest) -> Result<(), AppError> {
    let gallery = crate::carpe_diem::media::artifacts_dir(&app)?;
    let path = crate::path_confinement::confine_existing(
        &[gallery],
        std::path::Path::new(&request.path),
        "share_file_missing",
        "The file could not be found.",
    )?;
    let path = path.to_string_lossy().into_owned();
    app.run_on_main_thread(move || unsafe {
        let Some(url_class) = AnyClass::get(c"NSURL") else {
            return;
        };
        let Some(array_class) = AnyClass::get(c"NSArray") else {
            return;
        };
        let ns_path = NSString::from_str(&path);
        let url: *mut AnyObject = msg_send![url_class, fileURLWithPath: &*ns_path];
        if url.is_null() {
            return;
        }
        let items: *mut AnyObject = msg_send![array_class, arrayWithObject: url];
        present_activity(items);
    })
    .map_err(|error| AppError::new("share_failed", error.to_string()))?;
    Ok(())
}

/// Present a share sheet over whatever is frontmost, anchored for iPad.
///
/// # Safety
/// Main thread only; `items` is a live NSArray.
unsafe fn present_activity(items: *mut AnyObject) {
    let Some(app_class) = AnyClass::get(c"UIApplication") else {
        return;
    };
    let shared: *mut AnyObject = msg_send![app_class, sharedApplication];
    if shared.is_null() {
        return;
    }
    // keyWindow is soft-deprecated but still correct for a single-scene,
    // single-window app; the scene-based walk is not worth the ceremony.
    let window: *mut AnyObject = msg_send![shared, keyWindow];
    if window.is_null() {
        return;
    }
    let root: *mut AnyObject = msg_send![window, rootViewController];
    if root.is_null() {
        return;
    }
    // Present over whatever is frontmost so repeated shares still work.
    let mut presenter = root;
    loop {
        let presented: *mut AnyObject = msg_send![presenter, presentedViewController];
        if presented.is_null() {
            break;
        }
        presenter = presented;
    }
    let Some(activity_class) = AnyClass::get(c"UIActivityViewController") else {
        return;
    };
    let controller: *mut AnyObject = msg_send![activity_class, alloc];
    let controller: *mut AnyObject = msg_send![
        controller,
        initWithActivityItems: items,
        applicationActivities: std::ptr::null_mut::<AnyObject>()
    ];
    if controller.is_null() {
        return;
    }
    // On an iPad the sheet is a popover and needs an anchor, or UIKit throws.
    let popover: *mut AnyObject = msg_send![controller, popoverPresentationController];
    if !popover.is_null() {
        let view: *mut AnyObject = msg_send![presenter, view];
        if !view.is_null() {
            let _: () = msg_send![popover, setSourceView: view];
        }
    }
    let _: () = msg_send![
        presenter,
        presentViewController: controller,
        animated: true,
        completion: std::ptr::null_mut::<AnyObject>()
    ];
}
