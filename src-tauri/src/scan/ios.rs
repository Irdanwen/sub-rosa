//! VisionKit's document camera and Vision's text recognition, through the
//! Objective-C half in `native/document-scanner/DocumentScanner.m`.
//!
//! The camera is a view controller with a delegate, the PDF is drawn with
//! UIKit, and recognition is a Vision request per page: three APIs that are
//! each a few lines of Objective-C and a page of `msg_send!`. The bridge keeps
//! the passkey bridge's shape (`apple_passkey.rs`): one C entry point, one
//! JSON answer through a callback that fires exactly once.

use super::NativeScan;
use crate::domain::types::AppError;
use std::ffi::{c_char, c_void, CStr, CString};
use tokio::sync::oneshot;

unsafe extern "C" {
    fn subrosa_document_scan(
        pdf_path: *const c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const c_char),
    );
}

extern "C" fn receive(context: *mut c_void, json: *const c_char) {
    if context.is_null() {
        return;
    }
    // Called exactly once, from whatever queue finished the work. Reclaim the
    // sender even when nobody is waiting any more.
    let sender = unsafe { Box::from_raw(context.cast::<oneshot::Sender<String>>()) };
    let answer = if json.is_null() {
        String::from(r#"{"error":"no_answer"}"#)
    } else {
        unsafe { CStr::from_ptr(json) }
            .to_string_lossy()
            .into_owned()
    };
    let _ = sender.send(answer);
}

/// Presents the camera, and once the person is done writes the PDF to
/// `pdf_path` and answers with the recognized lines.
pub(super) async fn scan(pdf_path: &std::path::Path) -> Result<NativeScan, AppError> {
    let path = CString::new(pdf_path.to_string_lossy().into_owned()).map_err(|_| {
        AppError::new(
            "document_scan_storage",
            "The scan could not be stored on this device.",
        )
    })?;
    let (sender, receiver) = oneshot::channel::<String>();
    let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
    // The Objective-C side copies the path before returning and hops to the
    // main queue itself, so this is safe to call from any thread.
    unsafe { subrosa_document_scan(path.as_ptr(), context, receive) };
    let answer = receiver.await.map_err(|_| {
        AppError::new(
            "document_scan_failed",
            "The document could not be scanned. Try again.",
        )
    })?;
    serde_json::from_str(&answer).map_err(|error| {
        tracing::warn!(%error, "document scan answer unreadable");
        AppError::new(
            "document_scan_failed",
            "The document could not be scanned. Try again.",
        )
    })
}
