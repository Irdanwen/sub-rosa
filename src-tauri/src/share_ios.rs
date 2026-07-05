//! iOS share sheet (UIActivityViewController).
//!
//! Note export on the phone goes through the system share sheet: Files,
//! AirDrop, Mail, Messages, third-party apps. The webview cannot present
//! native view controllers, so this command bridges to UIKit. Text-only
//! items; media exports use the photo-library path (photos_ios.rs).

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
        let payload = NSString::from_str(&text);
        let items: Retained<NSArray<NSString>> = NSArray::from_retained_slice(&[payload]);
        let controller: *mut AnyObject = msg_send![activity_class, alloc];
        let controller: *mut AnyObject = msg_send![
            controller,
            initWithActivityItems: &*items,
            applicationActivities: std::ptr::null_mut::<AnyObject>()
        ];
        if controller.is_null() {
            return;
        }
        let _: () = msg_send![
            presenter,
            presentViewController: controller,
            animated: true,
            completion: std::ptr::null_mut::<AnyObject>()
        ];
    })
    .map_err(|error| AppError::new("share_failed", error.to_string()))?;
    Ok(())
}
