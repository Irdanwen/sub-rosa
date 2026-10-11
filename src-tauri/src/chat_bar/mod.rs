//! The chat bar (ADR-0094): a system-wide shortcut opens a small floating
//! panel with one field; Enter asks the agent, the answer streams into the
//! panel, and "Open in Sub Rosa" carries the conversation to the main window.
//!
//! - **The panel is the agent HUD's machinery.** A non-activating NSPanel on
//!   macOS (`agent_hud::make_key_panel`), so asking about another app does not
//!   bring Sub Rosa forward and hide what the question is about.
//! - **The shortcut coexists with dictation's (ADR-0041).** On macOS the
//!   dictation helper registers it as one more Carbon hot key, which needs no
//!   permission, and reports a press as `chat_bar_hotkey`; the same process
//!   then refuses a chord dictation already holds, and so does `validate`
//!   before anything is saved. On Windows a thread of its own holds a
//!   `RegisterHotKey` registration.
//! - **The conversation is an ordinary chat.** The panel's webview talks to
//!   the agent runtime the way the main window does, so what it asks is in the
//!   chat list like anything else.

#[cfg(target_os = "windows")]
mod hotkey_windows;
pub mod shortcut;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Size};

use crate::domain::types::AppError;
use shortcut::{ChatBarShortcut, Taken};

const WINDOW_LABEL: &str = "chat-bar";
const SETTINGS_FILE: &str = "chat-bar.json";
/// Told to the panel's webview each time it opens, so it focuses its field.
const OPENED_EVENT: &str = "chat-bar://opened";
const WIDTH: f64 = 640.0;
const MIN_HEIGHT: f64 = 64.0;
const MAX_HEIGHT: f64 = 560.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatBarSettings {
    pub enabled: bool,
    pub shortcut: ChatBarShortcut,
}

impl Default for ChatBarSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: shortcut::default_shortcut(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

pub fn load_settings(app: &AppHandle) -> ChatBarSettings {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<ChatBarSettings>(&raw).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &ChatBarSettings) -> Result<(), AppError> {
    let path = settings_path(app).ok_or_else(|| {
        AppError::new(
            "chat_bar_settings_failed",
            "Could not find where to save the chat bar settings.",
        )
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("chat_bar_settings_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("chat_bar_settings_failed", error.to_string()))?;
    std::fs::write(path, serialized)
        .map_err(|error| AppError::new("chat_bar_settings_failed", error.to_string()))
}

pub fn setup(app: &mut tauri::App) {
    let handle = app.handle().clone();
    configure_window(&handle);
    #[cfg(target_os = "macos")]
    listen_to_helper(&handle);
    apply(&handle, &load_settings(&handle));
}

/// Registers the shortcut (or removes it when the bar is off).
fn apply(app: &AppHandle, settings: &ChatBarSettings) {
    let active = settings.enabled.then_some(&settings.shortcut);
    #[cfg(target_os = "macos")]
    {
        let payload = active.and_then(|shortcut| {
            shortcut::mac_key_code(&shortcut.code).map(|key_code| {
                serde_json::json!({
                    "keyCode": key_code,
                    "code": shortcut.code,
                    "label": shortcut.label,
                    "pressCount": 1,
                    "modifiers": {
                        "command": shortcut.modifiers.command,
                        "control": shortcut.modifiers.control,
                        "option": shortcut.modifiers.option,
                        "shift": shortcut.modifiers.shift,
                        "function": false,
                    },
                })
            })
        });
        let command = serde_json::json!({ "type": "set_chat_bar_shortcut", "shortcut": payload });
        if let Some(state) = app.try_state::<crate::dictation::HelperState>() {
            if let Err(error) =
                crate::dictation::dictation_helper_command(app.clone(), state, command)
            {
                tracing::warn!(code = %error.code, "the chat bar shortcut could not reach the helper");
            }
        }
    }
    #[cfg(target_os = "windows")]
    hotkey_windows::register(app, active);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (app, active);
}

/// The helper reports through the dictation event stream; this picks out the
/// chat bar's press, and re-applies the shortcut when a restarted helper says
/// it is ready.
#[cfg(target_os = "macos")]
fn listen_to_helper(app: &AppHandle) {
    use tauri::Listener;
    let handle = app.clone();
    app.listen_any("dictation-event", move |event| {
        let Some(kind) = helper_event_type(event.payload()) else {
            return;
        };
        match kind.as_str() {
            "chat_bar_hotkey" => toggle(&handle),
            "ready" => apply(&handle, &load_settings(&handle)),
            _ => {}
        }
    });
}

/// The `type` of a helper line forwarded as an event (a JSON string holding
/// the line's JSON).
pub(crate) fn helper_event_type(payload: &str) -> Option<String> {
    let line = serde_json::from_str::<String>(payload).ok()?;
    let event = serde_json::from_str::<serde_json::Value>(&line).ok()?;
    event
        .get("type")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn configure_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_shadow(true);
    #[cfg(target_os = "macos")]
    crate::agent_hud::make_key_panel(&window);
}

/// Opens the panel when it is closed, closes it when it is open.
///
/// The press arrives on the thread that heard it: the dictation helper's
/// reader on macOS, the hot key thread on Windows. AppKit traps when a window
/// is ordered front anywhere but the main thread ("Must only be used from the
/// main thread"), which closed the app at the first press of the shortcut, so
/// the work is handed to the main thread.
pub fn toggle(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || toggle_on_main_thread(&handle)) {
        tracing::warn!(%error, "the chat bar could not reach the main thread");
    }
}

fn toggle_on_main_thread(app: &AppHandle) {
    let visible = app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide(app);
    } else {
        show(app);
    }
}

fn show(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let _ = window.set_size(Size::Logical(LogicalSize::new(WIDTH, MIN_HEIGHT)));
    position(&window);
    #[cfg(target_os = "macos")]
    crate::agent_hud::order_front_as_key(&window);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit_to(WINDOW_LABEL, OPENED_EVENT, ());
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
}

/// A fifth of the way down the screen the pointer is on, centred.
fn position(window: &tauri::WebviewWindow) {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = (WIDTH * scale).round() as i32;
    let x = area.position.x + (area.size.width as i32 - width) / 2;
    let y = area.position.y + (area.size.height as f64 * 0.2).round() as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatBarSettingsResponse {
    pub settings: ChatBarSettings,
    pub default_shortcut: ChatBarShortcut,
}

#[tauri::command]
pub fn chat_bar_settings(app: AppHandle) -> ChatBarSettingsResponse {
    ChatBarSettingsResponse {
        settings: load_settings(&app),
        default_shortcut: shortcut::default_shortcut(),
    }
}

/// Validates against the system and the dictation shortcuts, saves, and
/// registers.
#[tauri::command]
pub fn chat_bar_save_settings(
    app: AppHandle,
    settings: ChatBarSettings,
) -> Result<ChatBarSettingsResponse, AppError> {
    let taken = dictation_shortcuts(&app);
    let shortcut =
        shortcut::validate(&settings.shortcut, &taken).map_err(|problem| problem.into_error())?;
    let saved = ChatBarSettings {
        enabled: settings.enabled,
        shortcut,
    };
    save_settings(&app, &saved)?;
    apply(&app, &saved);
    Ok(ChatBarSettingsResponse {
        settings: saved,
        default_shortcut: shortcut::default_shortcut(),
    })
}

fn dictation_shortcuts(app: &AppHandle) -> Vec<Taken> {
    let Some(state) = app.try_state::<crate::dictation::DictationSettingsState>() else {
        return Vec::new();
    };
    let Ok(response) = crate::dictation::dictation_settings(state) else {
        return Vec::new();
    };
    [
        response.settings.push_to_talk_shortcut,
        response.settings.toggle_shortcut,
    ]
    .into_iter()
    .map(|setting| Taken {
        code: setting.code,
        modifiers: shortcut::Modifiers {
            command: setting.modifiers.command,
            control: setting.modifiers.control,
            option: setting.modifiers.option,
            shift: setting.modifiers.shift,
        },
        function: setting.modifiers.function,
    })
    .collect()
}

#[tauri::command]
pub fn chat_bar_show(app: AppHandle) {
    show(&app);
}

#[tauri::command]
pub fn chat_bar_hide(app: AppHandle) {
    hide(&app);
}

/// The webview reports its content height; the panel follows, keeping its
/// top edge where it was.
#[tauri::command]
pub fn chat_bar_set_height(app: AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if !height.is_finite() {
        return;
    }
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let _ = window.set_size(Size::Logical(LogicalSize::new(WIDTH, height)));
}

/// "Open in Sub Rosa": the panel closes and the main window opens the chat.
#[tauri::command]
pub fn chat_bar_open_in_app(
    app: AppHandle,
    session: Option<serde_json::Value>,
) -> Result<(), String> {
    hide(&app);
    crate::agent_hud::agent_hud_open_agent(app, session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forwarded_helper_line_reads_as_its_type() {
        let line = serde_json::json!({ "type": "chat_bar_hotkey", "payload": {} }).to_string();
        let payload = serde_json::to_string(&line).unwrap();
        assert_eq!(
            helper_event_type(&payload).as_deref(),
            Some("chat_bar_hotkey")
        );
        assert_eq!(helper_event_type("not json"), None);
    }

    #[test]
    fn settings_written_by_an_older_build_keep_the_default_shortcut() {
        let settings: ChatBarSettings = serde_json::from_str(r#"{ "enabled": false }"#).unwrap();
        assert!(!settings.enabled);
        assert_eq!(settings.shortcut, shortcut::default_shortcut());
    }
}
