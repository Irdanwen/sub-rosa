//! One picture of the screen per voice turn, on macOS.
//!
//! Taken by the system audio helper (`native/mac-system-audio-recorder`),
//! which already links ScreenCaptureKit and already carries the app's
//! "Screen & System Audio Recording" identity: a `--screenshot` run asks
//! for the permission when it is missing, captures the main display without
//! Sub Rosa's own windows, writes a JPEG and exits. One frame, not a
//! stream: the frame goes with the turn the person just finished saying,
//! as an image attachment, and nothing is recorded between turns.

use super::screen_frame::{capture_error, next_frame_path};
use crate::domain::types::AppError;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn permission_error() -> AppError {
    AppError::new(
        "voice_screen_permission",
        "Allow Sub Rosa in System Settings, Privacy and Security, Screen and System Audio Recording, then share your screen again.",
    )
}

/// Captures the screen into a JPEG and answers its path.
pub fn capture() -> Result<PathBuf, AppError> {
    let helper = crate::audio::system_macos::helper_app_path();
    if !helper.exists() {
        return Err(capture_error("helper missing"));
    }
    let output = next_frame_path()?;
    let status = output.with_extension("status.json");
    let launched = std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&helper)
        .arg("--args")
        .arg("--screenshot")
        .arg(&output)
        .arg("--status")
        .arg(&status)
        .status()
        .map_err(|error| capture_error(&error.to_string()))?;
    if !launched.success() {
        return Err(capture_error("open failed"));
    }
    let started = Instant::now();
    while started.elapsed() < CAPTURE_TIMEOUT {
        if let Some(report) = read_status(&status) {
            return outcome(&report, output);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(capture_error("timed out"))
}

fn read_status(path: &std::path::Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn outcome(report: &serde_json::Value, output: PathBuf) -> Result<PathBuf, AppError> {
    match report.get("event").and_then(|event| event.as_str()) {
        Some("captured") if output.exists() => Ok(output),
        Some("error")
            if report.get("code").and_then(|code| code.as_str()) == Some("permission") =>
        {
            Err(permission_error())
        }
        _ => Err(capture_error(
            report
                .get("message")
                .and_then(|message| message.as_str())
                .unwrap_or("unknown"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helper_report_decides_the_outcome() {
        let missing = PathBuf::from("/nonexistent/frame.jpg");
        assert_eq!(
            outcome(
                &serde_json::json!({"event": "error", "code": "permission"}),
                missing.clone()
            )
            .map_err(|error| error.code),
            Err("voice_screen_permission".to_string())
        );
        assert_eq!(
            outcome(
                &serde_json::json!({"event": "error", "message": "no display"}),
                missing.clone()
            )
            .map_err(|error| error.code),
            Err("voice_screen_failed".to_string())
        );
        // "captured" without the file is not a capture.
        assert!(outcome(&serde_json::json!({"event": "captured"}), missing).is_err());
    }
}
