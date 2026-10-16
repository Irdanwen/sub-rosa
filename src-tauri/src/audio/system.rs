//! The computer's sound (the `System` source), one surface over two
//! backends: the out-of-process macOS helper (ADR-0004) and, on Windows,
//! in-process WASAPI loopback (ADR-0113). Capture, readiness and the
//! permission probe go through here so `capture.rs` and the readiness check
//! stay free of platform `cfg`s.

use crate::domain::types::AudioLevelDto;

#[cfg(not(target_os = "windows"))]
pub use super::system_macos::{
    helper_permission_check as permission_check, system_audio_readiness, SystemAudioCapture,
};
#[cfg(target_os = "windows")]
pub use super::system_windows::{permission_check, system_audio_readiness, SystemAudioCapture};

/// One reading of the system lane. Both backends report `level` on the same
/// scale (`min(1, rms * 4)` over a short window), so the recorder's visual
/// gain and the silence thresholds carry over unchanged.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SystemLaneStatus {
    pub level: AudioLevelDto,
    /// Loudest level seen since capture started: whether the computer has
    /// been heard at all.
    pub max_level: f32,
    pub bytes_written: i64,
    pub last_error: Option<String>,
}
