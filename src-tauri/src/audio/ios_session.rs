//! AVAudioSession plumbing for iOS capture.
//!
//! cpal's CoreAudio backend records fine on iOS, but only once the app's
//! shared `AVAudioSession` is configured for recording and activated — that
//! part is platform policy, not audio plumbing, so it lives here and
//! `start_capture` calls it before opening the input stream. The
//! `playAndRecord` category plus `UIBackgroundModes: audio` (Info.plist)
//! keeps a recording alive while the screen is locked.

use crate::domain::types::AppError;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSError, NSString};

/// `AVAudioSessionCategoryOptionAllowBluetooth | DefaultToSpeaker` — record
/// from AirPods/headsets when connected, and keep playback on the speaker
/// (not the earpiece) for the playAndRecord category.
const CATEGORY_OPTIONS: usize = 0x4 | 0x8;

fn shared_session() -> Result<*mut AnyObject, AppError> {
    let class = objc2::runtime::AnyClass::get(c"AVAudioSession").ok_or_else(|| {
        AppError::new(
            "audio_session_unavailable",
            "AVAudioSession is not available in this process.",
        )
    })?;
    let session: *mut AnyObject = unsafe { msg_send![class, sharedInstance] };
    if session.is_null() {
        return Err(AppError::new(
            "audio_session_unavailable",
            "AVAudioSession returned no shared instance.",
        ));
    }
    Ok(session)
}

/// Put the shared audio session in recording mode and activate it. Must run
/// before the cpal input stream opens; iOS raises the microphone permission
/// prompt on the first activation.
pub fn configure_for_recording() -> Result<(), AppError> {
    let session = shared_session()?;
    // The category constant's value is its own name; using the literal avoids
    // binding the AVFAudio symbol for one string.
    let category = NSString::from_str("AVAudioSessionCategoryPlayAndRecord");
    unsafe {
        let result: Result<(), Retained<NSError>> = msg_send![
            session,
            setCategory: &*category,
            withOptions: CATEGORY_OPTIONS,
            error: _
        ];
        result.map_err(|error| {
            AppError::new(
                "audio_session_failed",
                error.localizedDescription().to_string(),
            )
        })?;
        let result: Result<(), Retained<NSError>> = msg_send![session, setActive: true, error: _];
        result.map_err(|error| {
            AppError::new(
                "audio_session_failed",
                error.localizedDescription().to_string(),
            )
        })?;
    }
    Ok(())
}

/// Release the audio session once recording finishes so other apps' audio
/// resumes. Errors are ignored: deactivation is best-effort cleanup.
pub fn deactivate() {
    if let Ok(session) = shared_session() {
        unsafe {
            let result: Result<(), Retained<NSError>> =
                msg_send![session, setActive: false, error: _];
            let _ = result;
        }
    }
}

/// Microphone permission from `AVAudioSession.recordPermission` (FourCC
/// values: 'grnt', 'deni', 'undt'). "unknown" means iOS has not asked the
/// user yet — recording must still be attempted, because the attempt is what
/// raises the system prompt (see `ensure_record_permission`).
pub fn record_permission() -> &'static str {
    const GRANTED: isize = 0x6772_6e74; // 'grnt'
    const DENIED: isize = 0x6465_6e69; // 'deni'
    let Ok(session) = shared_session() else {
        return "unknown";
    };
    let permission: isize = unsafe { msg_send![session, recordPermission] };
    match permission {
        GRANTED => "granted",
        DENIED => "denied",
        _ => "unknown",
    }
}

/// Make sure the microphone is usable before opening a capture stream:
/// granted passes, denied errors with a Settings hint, undetermined raises
/// the system permission prompt and waits for the user's answer. Must be
/// called off the main thread (the capture paths run in `spawn_blocking`);
/// the dialog itself runs on the system side, so blocking here is safe.
pub fn ensure_record_permission() -> Result<(), AppError> {
    match record_permission() {
        "granted" => Ok(()),
        "denied" => Err(microphone_denied_error()),
        _ => {
            let session = shared_session()?;
            let (tx, rx) = std::sync::mpsc::channel::<bool>();
            let tx = std::sync::Mutex::new(tx);
            let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
                if let Ok(tx) = tx.lock() {
                    let _ = tx.send(granted.as_bool());
                }
            });
            unsafe {
                let _: () = msg_send![session, requestRecordPermission: &*handler];
            }
            // Generous window for the user to answer; treat a vanished dialog
            // (app backgrounded, etc.) as a denial rather than hanging.
            match rx.recv_timeout(std::time::Duration::from_secs(120)) {
                Ok(true) => Ok(()),
                _ => Err(microphone_denied_error()),
            }
        }
    }
}

fn microphone_denied_error() -> AppError {
    AppError::new(
        "microphone_permission_denied",
        "Microphone access is not allowed. Enable it in Settings for this app.",
    )
}

/// Observe `AVAudioSessionInterruptionNotification` for the app's lifetime:
/// when a call or Siri takes the audio session, the active note recording is
/// paused so it can be resumed from the UI afterwards. Installed once at app
/// setup; the observer block leaks by design (process-lifetime).
pub fn install_interruption_observer() {
    use objc2_foundation::NSString;

    let Some(center_class) = objc2::runtime::AnyClass::get(c"NSNotificationCenter") else {
        return;
    };
    unsafe {
        let center: *mut AnyObject = msg_send![center_class, defaultCenter];
        if center.is_null() {
            return;
        }
        let name = NSString::from_str("AVAudioSessionInterruptionNotification");
        let handler = block2::RcBlock::new(move |notification: *mut AnyObject| {
            // userInfo[AVAudioSessionInterruptionTypeKey] == 1 (began)
            let began = (|| -> Option<bool> {
                let user_info: *mut AnyObject = msg_send![notification, userInfo];
                if user_info.is_null() {
                    return None;
                }
                let key = NSString::from_str("AVAudioSessionInterruptionTypeKey");
                let value: *mut AnyObject = msg_send![user_info, objectForKey: &*key];
                if value.is_null() {
                    return None;
                }
                let raw: u64 = msg_send![value, unsignedLongLongValue];
                Some(raw == 1)
            })()
            .unwrap_or(false);
            if began {
                crate::audio::capture::pause_active_capture_for_interruption();
            }
        });
        let _observer: *mut AnyObject = msg_send![
            center,
            addObserverForName: &*name,
            object: std::ptr::null_mut::<AnyObject>(),
            queue: std::ptr::null_mut::<AnyObject>(),
            usingBlock: &*handler
        ];
        // Keep the block alive for the process lifetime.
        std::mem::forget(handler);
    }
}
