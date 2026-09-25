//! Native AuthenticationServices assertion. Only WebAuthn JSON leaves this
//! bridge; credential private keys never leave the platform provider.
use std::{
    ffi::{c_char, c_void, CStr, CString},
    sync::mpsc,
    time::Duration,
};

use serde_json::Value;

use crate::domain::types::AppError;

unsafe extern "C" {
    fn subrosa_apple_passkey_get(
        options_json: *const c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, *const c_char),
    );
}

extern "C" fn receive(context: *mut c_void, json: *const c_char) {
    if context.is_null() {
        return;
    }
    // The Objective-C bridge calls back exactly once; reclaim the sender even
    // when the Rust waiter has timed out or the prompt failed.
    let sender = unsafe { Box::from_raw(context.cast::<mpsc::SyncSender<String>>()) };
    if json.is_null() {
        return;
    }
    let value = unsafe { CStr::from_ptr(json) }
        .to_string_lossy()
        .into_owned();
    let _ = sender.send(value);
}

pub fn get(options: &Value) -> Result<Value, AppError> {
    let input = CString::new(options.to_string())
        .map_err(|_| AppError::new("passkey_request_invalid", "The passkey request is invalid."))?;
    let (sender, receiver) = mpsc::sync_channel::<String>(1);
    let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
    unsafe { subrosa_apple_passkey_get(input.as_ptr(), context, receive) };
    let answer = receiver
        .recv_timeout(Duration::from_secs(300))
        .map_err(|_| {
            AppError::new(
                "account_passkey_unavailable",
                "The passkey prompt did not finish.",
            )
        })?;
    let answer: Value = serde_json::from_str(&answer).map_err(|_| {
        AppError::new(
            "passkey_response_invalid",
            "The passkey response is invalid.",
        )
    })?;
    answer.get("credential").cloned().ok_or_else(|| {
        AppError::new(
            "account_passkey_unavailable",
            "The passkey could not be used.",
        )
    })
}
