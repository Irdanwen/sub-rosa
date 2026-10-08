//! What every desktop's screen frame shares: where it is written, and (for
//! the Windows capture, which gets raw pixels rather than a finished file)
//! how it is sized and encoded. The Mac's helper does the same in Swift:
//! 1600 px on the longest side, JPEG at quality 80.

use crate::domain::types::AppError;
use std::path::PathBuf;

/// A model reads text at this size; more only costs upload time.
#[cfg(any(windows, test))]
pub(crate) const LONGEST_SIDE: u32 = 1600;
#[cfg(any(windows, test))]
pub(crate) const JPEG_QUALITY: u8 = 80;

pub fn capture_error(detail: &str) -> AppError {
    tracing::warn!(%detail, "voice screen frame failed");
    AppError::new(
        "voice_screen_failed",
        "The screen could not be captured. Try again.",
    )
}

/// A fresh path for the next frame. Only the newest frame is ever needed
/// (the turn before has sent its own), so older ones are cleared first.
pub fn next_frame_path() -> Result<PathBuf, AppError> {
    let dir = std::env::temp_dir().join("subrosa-voice-frames");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|error| capture_error(&error.to_string()))?;
    Ok(dir.join(format!("screen-{}.jpg", uuid::Uuid::new_v4())))
}

/// The frame's size once its longest side is at most 1600 px.
#[cfg(any(windows, test))]
pub fn scaled_size(width: u32, height: u32) -> (u32, u32) {
    let longest = width.max(height).max(1);
    if longest <= LONGEST_SIDE {
        return (width.max(1), height.max(1));
    }
    let scale = f64::from(LONGEST_SIDE) / f64::from(longest);
    let side = |value: u32| ((f64::from(value) * scale).round() as u32).max(1);
    (side(width), side(height))
}

/// Top-down 32-bit BGRA rows (what GDI hands back) to a scaled JPEG.
#[cfg(any(windows, test))]
pub fn bgra_to_jpeg(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AppError> {
    let pixels = width as usize * height as usize;
    if width == 0 || height == 0 || bgra.len() < pixels * 4 {
        return Err(capture_error("the pixel buffer does not match the screen"));
    }
    let mut rgb = Vec::with_capacity(pixels * 3);
    for pixel in bgra.chunks_exact(4).take(pixels) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    let image = image::RgbImage::from_raw(width, height, rgb)
        .ok_or_else(|| capture_error("the pixel buffer does not match the screen"))?;
    let (target_width, target_height) = scaled_size(width, height);
    let image = if (target_width, target_height) == (width, height) {
        image
    } else {
        image::imageops::resize(
            &image,
            target_width,
            target_height,
            image::imageops::FilterType::Triangle,
        )
    };
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&image)
        .map_err(|error| capture_error(&error.to_string()))?;
    Ok(jpeg)
}

/// One top-level window, as far as keeping the app's own windows out of a
/// Windows frame is concerned.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TopWindow<H> {
    pub handle: H,
    pub process: u32,
    pub visible: bool,
    /// `GetWindowDisplayAffinity`: 0 is `WDA_NONE`.
    pub affinity: u32,
}

/// The windows to keep out of the picture: this process's visible ones with
/// no display affinity of their own. One that has its own is left as it is,
/// so restoring never takes away an affinity the app set elsewhere.
#[cfg(any(windows, test))]
pub fn windows_to_hide<H: Copy>(windows: &[TopWindow<H>], own_process: u32) -> Vec<H> {
    windows
        .iter()
        .filter(|window| window.process == own_process && window.visible && window.affinity == 0)
        .map(|window| window.handle)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_large_screen_is_brought_to_1600_on_its_longest_side() {
        assert_eq!(scaled_size(3840, 2160), (1600, 900));
        assert_eq!(scaled_size(1440, 2560), (900, 1600));
        assert_eq!(scaled_size(1280, 720), (1280, 720));
        assert_eq!(scaled_size(0, 0), (1, 1));
    }

    #[test]
    fn gdi_pixels_become_a_jpeg_of_the_scaled_size_in_the_right_colours() {
        // A 3200 x 10 strip of pure red, in GDI's blue-green-red-unused order.
        let (width, height) = (3200, 10);
        let bgra = [0u8, 0, 255, 0].repeat(width * height);
        let jpeg = bgra_to_jpeg(&bgra, width as u32, height as u32)
            .unwrap_or_else(|error| panic!("{error:?}"));
        let decoded = image::load_from_memory(&jpeg)
            .unwrap_or_else(|error| panic!("{error}"))
            .to_rgb8();
        assert_eq!(decoded.dimensions(), (1600, 5));
        let [red, green, blue] = decoded.get_pixel(800, 2).0;
        assert!(red > 200 && green < 60 && blue < 60, "{red} {green} {blue}");
    }

    #[test]
    fn a_short_buffer_is_refused_not_read_past() {
        assert_eq!(
            bgra_to_jpeg(&[0; 12], 2, 2).map_err(|error| error.code),
            Err("voice_screen_failed".to_string())
        );
    }

    #[test]
    fn only_the_apps_own_visible_unmarked_windows_are_hidden() {
        let window = |handle, process, visible, affinity| TopWindow {
            handle,
            process,
            visible,
            affinity,
        };
        let listed = [
            window(1, 42, true, 0),
            window(2, 42, false, 0),
            window(3, 7, true, 0),
            window(4, 42, true, 17),
            window(5, 42, true, 0),
        ];
        assert_eq!(windows_to_hide(&listed, 42), vec![1, 5]);
    }

    #[test]
    fn each_frame_replaces_the_one_before() {
        let first = next_frame_path().unwrap_or_else(|error| panic!("{error:?}"));
        std::fs::write(&first, b"old").unwrap_or_else(|error| panic!("{error}"));
        let second = next_frame_path().unwrap_or_else(|error| panic!("{error:?}"));
        assert_ne!(first, second);
        assert!(!first.exists());
        assert_eq!(second.extension().and_then(|e| e.to_str()), Some("jpg"));
    }
}
