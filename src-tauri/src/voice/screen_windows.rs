//! One picture of the screen per voice turn, on Windows.
//!
//! GDI rather than Windows.Graphics.Capture: one `BitBlt` of the primary
//! display is a single frame with no capture session, no Direct3D device
//! and no capture border, and Windows asks no permission for it. The
//! explanation before the first share is the consent, as on the Mac.
//!
//! The Mac's helper leaves Sub Rosa's own windows out of the picture. Here
//! they are marked `WDA_EXCLUDEFROMCAPTURE` for the instant of the copy and
//! restored after (Windows 10 2004 and later honour it; earlier versions
//! keep them in the picture). A window that already had an affinity of its
//! own keeps it. The frame is scaled and encoded like the Mac's
//! (`screen_frame.rs`).
//!
//! Unverified on Windows hardware at the time of writing: it compiles for
//! `x86_64-pc-windows-msvc`, and the pure parts (sizing, colour order,
//! encoding, which windows are hidden) are tested on every platform.

use super::screen_frame::{
    bgra_to_jpeg, capture_error, next_frame_path, windows_to_hide, TopWindow,
};
use crate::domain::types::AppError;
use std::path::PathBuf;
use std::time::Duration;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetSystemMetrics, GetWindowDisplayAffinity, GetWindowThreadProcessId,
    IsWindowVisible, SetWindowDisplayAffinity, SM_CXSCREEN, SM_CYSCREEN, WDA_EXCLUDEFROMCAPTURE,
    WDA_NONE,
};

/// Long enough for the compositor to draw a frame without the hidden
/// windows before the copy reads it.
const EXCLUSION_SETTLE: Duration = Duration::from_millis(60);

/// Captures the primary display into a JPEG and answers its path.
pub fn capture() -> Result<PathBuf, AppError> {
    let hidden = hide_own_windows();
    if !hidden.is_empty() {
        std::thread::sleep(EXCLUSION_SETTLE);
    }
    let pixels = copy_primary_display();
    restore(&hidden);
    let (bgra, width, height) = pixels?;
    let jpeg = bgra_to_jpeg(&bgra, width, height)?;
    let path = next_frame_path()?;
    std::fs::write(&path, jpeg).map_err(|error| capture_error(&error.to_string()))?;
    Ok(path)
}

unsafe extern "system" fn collect_window(handle: HWND, list: LPARAM) -> BOOL {
    // SAFETY: `list` is the `&mut Vec` passed to EnumWindows below, alive
    // for the whole enumeration.
    let windows = unsafe { &mut *(list.0 as *mut Vec<TopWindow<HWND>>) };
    let mut process = 0u32;
    let mut affinity = 0u32;
    unsafe {
        GetWindowThreadProcessId(handle, Some(&mut process));
        let _ = GetWindowDisplayAffinity(handle, &mut affinity);
    }
    windows.push(TopWindow {
        handle,
        process,
        visible: unsafe { IsWindowVisible(handle) }.as_bool(),
        affinity,
    });
    BOOL(1)
}

fn hide_own_windows() -> Vec<HWND> {
    let mut windows: Vec<TopWindow<HWND>> = Vec::new();
    // SAFETY: the callback only pushes into `windows`, which outlives the call.
    let listed = unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM(&mut windows as *mut Vec<TopWindow<HWND>> as isize),
        )
    };
    if let Err(error) = listed {
        tracing::warn!(%error, "voice screen frame: own windows not listed");
        return Vec::new();
    }
    windows_to_hide(&windows, std::process::id())
        .into_iter()
        // SAFETY: a handle EnumWindows just returned; a window closed since
        // makes the call fail, which only means it is not hidden.
        .filter(|handle| {
            unsafe { SetWindowDisplayAffinity(*handle, WDA_EXCLUDEFROMCAPTURE) }.is_ok()
        })
        .collect()
}

fn restore(hidden: &[HWND]) {
    for handle in hidden {
        // SAFETY: as above; a window closed meanwhile has nothing to restore.
        let _ = unsafe { SetWindowDisplayAffinity(*handle, WDA_NONE) };
    }
}

/// The primary display's pixels as top-down BGRA, with its size.
fn copy_primary_display() -> Result<(Vec<u8>, u32, u32), AppError> {
    // SAFETY: plain GDI calls on handles created and released here; every
    // object is released on every path before returning.
    unsafe {
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        if width <= 0 || height <= 0 {
            return Err(capture_error("no primary display"));
        }
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err(capture_error("GetDC failed"));
        }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            Some(screen),
            0,
            0,
            SRCCOPY | CAPTUREBLT,
        );
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative: rows top-down, as an image is stored.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let rows = if copied.is_ok() {
            SelectObject(memory, previous);
            GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                Some(pixels.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            SelectObject(memory, previous);
            0
        };
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        if let Err(error) = copied {
            return Err(capture_error(&error.to_string()));
        }
        if rows != height {
            return Err(capture_error("GetDIBits returned too few rows"));
        }
        Ok((pixels, width as u32, height as u32))
    }
}
