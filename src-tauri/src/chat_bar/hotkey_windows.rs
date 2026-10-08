//! The chat bar's shortcut on Windows: `RegisterHotKey` on a thread of its
//! own, which owns the registration and pumps the messages it delivers.
//!
//! There is no helper process on Windows (the dictation helper is a macOS
//! Swift binary), and `RegisterHotKey` needs no permission and no window: a
//! thread-level registration posts `WM_HOTKEY` to the thread's queue. The few
//! user32 calls are declared here directly, which keeps the `windows` crate's
//! feature list as it was.

use std::sync::Mutex;

use tauri::AppHandle;

use super::shortcut::{windows_virtual_key, ChatBarShortcut};

const WM_HOTKEY: u32 = 0x0312;
const WM_QUIT: u32 = 0x0012;
const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_WIN: u32 = 0x0008;
const MOD_NOREPEAT: u32 = 0x4000;
const HOTKEY_ID: i32 = 0x5352; // "SR"

#[repr(C)]
struct Msg {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
    private: u32,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterHotKey(hwnd: isize, id: i32, modifiers: u32, vk: u32) -> i32;
    fn UnregisterHotKey(hwnd: isize, id: i32) -> i32;
    fn GetMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
    fn PostThreadMessageW(thread_id: u32, msg: u32, wparam: usize, lparam: isize) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
}

/// The thread holding the current registration.
static THREAD: Mutex<Option<u32>> = Mutex::new(None);

/// Replaces the registration: `None` turns the shortcut off.
pub fn register(app: &AppHandle, shortcut: Option<&ChatBarShortcut>) {
    if let Ok(mut thread) = THREAD.lock() {
        if let Some(thread_id) = thread.take() {
            // SAFETY: posting to a thread id is valid even if the thread has
            // exited; the call then fails and returns zero.
            unsafe {
                PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
            }
        }
    }
    let Some(shortcut) = shortcut else {
        return;
    };
    let Some(vk) = windows_virtual_key(&shortcut.code) else {
        return;
    };
    let mut modifiers = MOD_NOREPEAT;
    if shortcut.modifiers.option {
        modifiers |= MOD_ALT;
    }
    if shortcut.modifiers.control {
        modifiers |= MOD_CONTROL;
    }
    if shortcut.modifiers.shift {
        modifiers |= MOD_SHIFT;
    }
    if shortcut.modifiers.command {
        modifiers |= MOD_WIN;
    }
    let app = app.clone();
    let label = shortcut.label.clone();
    let (ready, started) = std::sync::mpsc::channel::<u32>();
    std::thread::spawn(move || {
        // SAFETY: plain user32/kernel32 calls on this thread, with a
        // zero-initialised MSG this thread owns.
        unsafe {
            if RegisterHotKey(0, HOTKEY_ID, modifiers, vk) == 0 {
                tracing::warn!(shortcut = %label, "the chat bar shortcut is held by another app");
                return;
            }
            let _ = ready.send(GetCurrentThreadId());
            let mut msg: Msg = std::mem::zeroed();
            while GetMessageW(&mut msg, 0, 0, 0) > 0 {
                if msg.message == WM_HOTKEY && msg.wparam == HOTKEY_ID as usize {
                    super::toggle(&app);
                }
            }
            UnregisterHotKey(0, HOTKEY_ID);
        }
    });
    // Recorded before returning, so the next call always reaches this
    // thread to end it.
    if let Ok(thread_id) = started.recv_timeout(std::time::Duration::from_secs(2)) {
        if let Ok(mut thread) = THREAD.lock() {
            *thread = Some(thread_id);
        }
    }
}
