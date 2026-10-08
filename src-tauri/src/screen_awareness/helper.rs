//! The macOS side: asks the dictation helper, waits for its answer on the
//! helper's event stream.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::oneshot;

use super::LookingAt;
use crate::domain::types::AppError;

/// A picture goes through ScreenCaptureKit, which can take a moment.
const ANSWER_WAIT: Duration = Duration::from_secs(8);

#[derive(Default)]
struct Waiting {
    captures: HashMap<String, oneshot::Sender<Value>>,
    permission: Vec<oneshot::Sender<bool>>,
}

fn waiting() -> &'static Mutex<Waiting> {
    static WAITING: OnceLock<Mutex<Waiting>> = OnceLock::new();
    WAITING.get_or_init(|| Mutex::new(Waiting::default()))
}

pub fn listen(app: &AppHandle) {
    app.listen_any("dictation-event", |event| {
        let Some(line) = serde_json::from_str::<String>(event.payload()).ok() else {
            return;
        };
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        let payload = event.get("payload").cloned().unwrap_or(Value::Null);
        match event.get("type").and_then(Value::as_str) {
            Some("awareness") => {
                let id = payload
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let sender = waiting()
                    .lock()
                    .ok()
                    .and_then(|mut waiting| waiting.captures.remove(&id));
                if let Some(sender) = sender {
                    let _ = sender.send(payload);
                }
            }
            Some("screen_recording_status") => {
                let granted = payload.get("granted").and_then(Value::as_bool) == Some(true);
                let senders = waiting()
                    .lock()
                    .map(|mut waiting| std::mem::take(&mut waiting.permission))
                    .unwrap_or_default();
                for sender in senders {
                    let _ = sender.send(granted);
                }
            }
            _ => {}
        }
    });
}

fn send(app: &AppHandle, command: Value) -> Result<(), AppError> {
    let state = app
        .try_state::<crate::dictation::HelperState>()
        .ok_or_else(helper_missing)?;
    crate::dictation::dictation_helper_command(app.clone(), state, command)
}

fn helper_missing() -> AppError {
    AppError::new(
        "screen_awareness_unavailable",
        "The helper that reads the frontmost app is not running. Restart Sub Rosa and try again.",
    )
}

pub async fn capture(app: &AppHandle, picture: Option<&Path>) -> Result<LookingAt, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut waiting) = waiting().lock() {
        waiting.captures.insert(id.clone(), sender);
    }
    let command = serde_json::json!({
        "type": "capture_awareness",
        "requestId": id,
        "screenshotPath": picture.map(|path| path.to_string_lossy().into_owned()),
    });
    if let Err(error) = send(app, command) {
        if let Ok(mut waiting) = waiting().lock() {
            waiting.captures.remove(&id);
        }
        return Err(error);
    }
    let answer = match tokio::time::timeout(ANSWER_WAIT, receiver).await {
        Ok(Ok(answer)) => answer,
        _ => {
            if let Ok(mut waiting) = waiting().lock() {
                waiting.captures.remove(&id);
            }
            return Err(helper_missing());
        }
    };
    looking_at_from(&answer)
}

/// The helper's answer as a [`LookingAt`].
pub fn looking_at_from(answer: &Value) -> Result<LookingAt, AppError> {
    let text = |key: &str| {
        answer
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
    };
    if text("error").is_some() {
        return Err(AppError::new(
            "screen_awareness_nothing",
            "There is no other app in front to attach. Switch to it, then try again.",
        ));
    }
    Ok(LookingAt {
        app_name: text("appName").unwrap_or_default(),
        window_title: text("windowTitle"),
        selected_text: text("selectedText"),
        accessibility: answer.get("accessibility").and_then(Value::as_bool) == Some(true),
        screenshot_path: text("screenshot"),
        screenshot_error: text("screenshotError"),
        context_path: None,
        captured_at: String::new(),
    })
}

pub async fn screen_recording(app: &AppHandle, request: bool) -> Result<bool, AppError> {
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut waiting) = waiting().lock() {
        waiting.permission.push(sender);
    }
    let kind = if request {
        "request_screen_recording"
    } else {
        "screen_recording_status"
    };
    send(app, serde_json::json!({ "type": kind }))?;
    // The system prompt can stay up for as long as the person reads it.
    let wait = if request {
        Duration::from_secs(120)
    } else {
        ANSWER_WAIT
    };
    match tokio::time::timeout(wait, receiver).await {
        Ok(Ok(granted)) => Ok(granted),
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helpers_answer_becomes_a_chip() {
        let answer = serde_json::json!({
            "requestId": "r1",
            "appName": "Mail",
            "windowTitle": "Inbox",
            "selectedText": "  ",
            "accessibility": true,
            "screenshotError": "permission",
        });
        let looking_at = looking_at_from(&answer).unwrap();
        assert_eq!(looking_at.app_name, "Mail");
        assert_eq!(looking_at.window_title.as_deref(), Some("Inbox"));
        // Whitespace is not a selection.
        assert_eq!(looking_at.selected_text, None);
        assert_eq!(looking_at.screenshot_error.as_deref(), Some("permission"));
        assert!(looking_at.accessibility);

        let error = looking_at_from(&serde_json::json!({ "error": "no_app" })).unwrap_err();
        assert_eq!(error.code, "screen_awareness_nothing");
    }
}
