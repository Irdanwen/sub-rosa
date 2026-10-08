//! "What I'm looking at" (ADR-0094): the app the person was in, its window's
//! title, the text selected there, and if they ask, a picture of that one
//! window, attached to a question as a chip they can remove before sending.
//!
//! - **Opt-in, and only on a click.** Off until turned on in Settings ›
//!   Privacy; then nothing is read until the person clicks "What I'm looking
//!   at". There is no background capture, no history, no timer.
//! - **The picture is a second opt-in.** Screen Recording is a permission
//!   macOS asks about once; the app explains what it is for before the
//!   system prompt appears, and a picture is one window, never the screen.
//! - **macOS reads through the dictation helper**, which already holds the
//!   Accessibility permission (ADR-0041) and already tracks the frontmost
//!   app; ScreenCaptureKit takes the picture. **Windows** reads the title of
//!   the window the person was in, and nothing else: selected text would
//!   need UI Automation, which is not worth its weight for this.
//! - **What is captured is a file**, written under the app's data and
//!   attached like any other: a short markdown note (app, window, selection)
//!   and the picture. Removing the chip removes it from the message.

#[cfg(target_os = "macos")]
mod helper;
#[cfg(target_os = "windows")]
mod windows;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::domain::types::AppError;

const SETTINGS_FILE: &str = "screen-awareness.json";
const CAPTURE_DIR: &str = "looking-at";
/// The selection is cut here: a question about a passage, not a document.
pub const MAX_SELECTED_CHARS: usize = 8_000;
/// Captures older than this are deleted when the next one is taken.
const KEEP_FOR: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenAwarenessSettings {
    pub enabled: bool,
    /// The person read why a picture needs Screen Recording and agreed.
    pub screenshots: bool,
}

/// One capture, as the chip shows it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookingAt {
    pub app_name: String,
    pub window_title: Option<String>,
    pub selected_text: Option<String>,
    /// Whether the selection could be read at all (Accessibility granted).
    pub accessibility: bool,
    pub screenshot_path: Option<String>,
    /// `permission`, `no_window` or `capture_failed` when a picture was asked
    /// for and none came back.
    pub screenshot_error: Option<String>,
    /// The markdown note to attach.
    pub context_path: Option<String>,
    pub captured_at: String,
}

/// The note attached for the model: plain, short, and only what was read.
pub fn context_markdown(looking_at: &LookingAt) -> String {
    let mut out = String::from("# What I'm looking at\n\n");
    out.push_str(&format!("App: {}\n", looking_at.app_name.trim()));
    if let Some(title) = looking_at
        .window_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        out.push_str(&format!("Window: {title}\n"));
    }
    if let Some(selected) = looking_at
        .selected_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        out.push_str("\nSelected text:\n\n");
        for line in clip_chars(selected, MAX_SELECTED_CHARS).lines() {
            out.push_str("> ");
            out.push_str(line);
            out.push('\n');
        }
    }
    if looking_at.screenshot_path.is_some() {
        out.push_str("\nA picture of the window is attached too.\n");
    }
    out
}

fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max).collect();
    format!("{clipped}…")
}

/// A file name for the note a person will see on the chip:
/// `Looking at Safari.md`.
pub fn context_file_name(app_name: &str) -> String {
    let cleaned: String = app_name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .chars()
        .take(48)
        .collect();
    if cleaned.is_empty() {
        "Looking at.md".to_string()
    } else {
        format!("Looking at {cleaned}.md")
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

pub fn load_settings(app: &AppHandle) -> ScreenAwarenessSettings {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<ScreenAwarenessSettings>(&raw).ok())
        .unwrap_or_default()
}

pub fn setup(app: &mut tauri::App) {
    #[cfg(target_os = "macos")]
    helper::listen(app.handle());
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Where captures are written, emptied of anything older than a day.
fn capture_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("screen_awareness_failed", error.to_string()))?
        .join(CAPTURE_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::new("screen_awareness_failed", error.to_string()))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age > KEEP_FOR);
            if old {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(dir)
}

#[tauri::command]
pub fn screen_awareness_settings(app: AppHandle) -> ScreenAwarenessSettings {
    load_settings(&app)
}

#[tauri::command]
pub fn screen_awareness_save_settings(
    app: AppHandle,
    settings: ScreenAwarenessSettings,
) -> Result<ScreenAwarenessSettings, AppError> {
    // A picture is a refinement of the opt-in, never on its own.
    let settings = ScreenAwarenessSettings {
        enabled: settings.enabled,
        screenshots: settings.enabled && settings.screenshots,
    };
    let path = settings_path(&app).ok_or_else(|| {
        AppError::new(
            "screen_awareness_failed",
            "Could not find where to save the screen awareness settings.",
        )
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("screen_awareness_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|error| AppError::new("screen_awareness_failed", error.to_string()))?;
    std::fs::write(path, serialized)
        .map_err(|error| AppError::new("screen_awareness_failed", error.to_string()))?;
    Ok(settings)
}

/// Reads what the person is looking at, now, because they clicked.
#[tauri::command]
pub async fn screen_awareness_capture(
    app: AppHandle,
    screenshot: Option<bool>,
) -> Result<LookingAt, AppError> {
    let settings = load_settings(&app);
    if !settings.enabled {
        return Err(AppError::new(
            "screen_awareness_off",
            "Turn on screen awareness in Settings, Privacy, to attach what you are looking at.",
        ));
    }
    let wants_picture = screenshot.unwrap_or(false);
    if wants_picture && !settings.screenshots {
        return Err(AppError::new(
            "screen_awareness_off",
            "Allow window pictures in Settings, Privacy, first.",
        ));
    }
    let dir = capture_dir(&app)?.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::new("screen_awareness_failed", error.to_string()))?;
    let picture_path = wants_picture.then(|| dir.join("Window.jpg"));

    #[cfg(target_os = "macos")]
    let mut looking_at = helper::capture(&app, picture_path.as_deref()).await?;
    #[cfg(target_os = "windows")]
    let mut looking_at = {
        let _ = &picture_path;
        windows::capture()?
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut looking_at: LookingAt = {
        let _ = &picture_path;
        return Err(AppError::new(
            "screen_awareness_unavailable",
            "Screen awareness is not available on this system.",
        ));
    };

    looking_at.captured_at = chrono::Utc::now().to_rfc3339();
    if let Some(selected) = looking_at.selected_text.take() {
        looking_at.selected_text = Some(clip_chars(&selected, MAX_SELECTED_CHARS));
    }
    let note = dir.join(context_file_name(&looking_at.app_name));
    std::fs::write(&note, context_markdown(&looking_at))
        .map_err(|error| AppError::new("screen_awareness_failed", error.to_string()))?;
    looking_at.context_path = Some(note.to_string_lossy().into_owned());
    Ok(looking_at)
}

/// Whether a window picture can be taken; `request` shows the system prompt
/// (after the app's own explanation).
#[tauri::command]
pub async fn screen_awareness_screen_permission(
    app: AppHandle,
    request: bool,
) -> Result<bool, AppError> {
    #[cfg(target_os = "macos")]
    {
        helper::screen_recording(&app, request).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> LookingAt {
        LookingAt {
            app_name: "Safari".to_string(),
            window_title: Some("Flights to Lisbon".to_string()),
            selected_text: Some("Departs 07:10\nArrives 09:25".to_string()),
            accessibility: true,
            ..LookingAt::default()
        }
    }

    #[test]
    fn the_note_says_only_what_was_read() {
        let note = context_markdown(&sample());
        assert!(note.contains("App: Safari\n"));
        assert!(note.contains("Window: Flights to Lisbon\n"));
        assert!(note.contains("> Departs 07:10\n> Arrives 09:25\n"));
        assert!(!note.contains("picture"));

        let bare = context_markdown(&LookingAt {
            app_name: "Finder".to_string(),
            window_title: Some("  ".to_string()),
            ..LookingAt::default()
        });
        assert!(!bare.contains("Window:"));
        assert!(!bare.contains("Selected text"));

        let with_picture = context_markdown(&LookingAt {
            screenshot_path: Some("/tmp/Window.jpg".to_string()),
            ..sample()
        });
        assert!(with_picture.contains("A picture of the window is attached too."));
    }

    #[test]
    fn a_long_selection_is_cut() {
        let long = "a".repeat(MAX_SELECTED_CHARS + 50);
        let note = context_markdown(&LookingAt {
            selected_text: Some(long),
            ..sample()
        });
        assert!(note.contains('…'));
        assert!(note.len() < MAX_SELECTED_CHARS + 200);
    }

    #[test]
    fn the_chip_file_is_named_after_the_app() {
        assert_eq!(context_file_name("Safari"), "Looking at Safari.md");
        assert_eq!(context_file_name("../../etc"), "Looking at etc.md");
        assert_eq!(context_file_name("   "), "Looking at.md");
        assert_eq!(
            context_file_name("Microsoft Word"),
            "Looking at Microsoft Word.md"
        );
    }

    #[test]
    fn pictures_are_never_on_without_the_opt_in() {
        let settings: ScreenAwarenessSettings = serde_json::from_str("{}").unwrap();
        assert!(!settings.enabled);
        assert!(!settings.screenshots);
    }
}
