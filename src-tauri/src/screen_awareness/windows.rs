//! The Windows side: the title of the window the person was in.
//!
//! "The window they were in" is the frontmost top-level window that is not
//! one of this app's own, found by walking the z-order down from the
//! foreground window: when the person clicked in Sub Rosa (the chat bar or
//! the main window), that is the one just below it. Selected text would need
//! UI Automation; the title is what is cheap and reliable.

use super::LookingAt;
use crate::domain::types::AppError;

const GW_HWNDNEXT: u32 = 2;

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> isize;
    fn GetWindow(hwnd: isize, cmd: u32) -> isize;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetWindowTextW(hwnd: isize, text: *mut u16, max: i32) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, process_id: *mut u32) -> u32;
}

pub fn capture() -> Result<LookingAt, AppError> {
    let own = std::process::id();
    // SAFETY: read-only user32 queries on window handles the system hands
    // back; a stale handle makes them fail, not misbehave.
    unsafe {
        let mut hwnd = GetForegroundWindow();
        let mut steps = 0;
        while hwnd != 0 && steps < 512 {
            steps += 1;
            let mut pid = 0_u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != own && IsWindowVisible(hwnd) != 0 {
                let mut buffer = [0_u16; 512];
                let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
                if len > 0 {
                    let title = String::from_utf16_lossy(&buffer[..len as usize]);
                    return Ok(LookingAt {
                        app_name: app_name_from_title(&title),
                        window_title: Some(title),
                        ..LookingAt::default()
                    });
                }
            }
            hwnd = GetWindow(hwnd, GW_HWNDNEXT);
        }
    }
    Err(AppError::new(
        "screen_awareness_nothing",
        "There is no other app in front to attach. Switch to it, then try again.",
    ))
}

/// Windows titles end with the app's name ("Report.docx - Word"), which is
/// the closest thing to an app name a title gives without opening the
/// process.
fn app_name_from_title(title: &str) -> String {
    title
        .rsplit(" - ")
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(title)
        .to_string()
}
