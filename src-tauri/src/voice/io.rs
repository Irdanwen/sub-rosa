//! The microphone and the speaker for a voice conversation, per platform.
//!
//! The loop needs both at once, and it needs the speaker's sound kept out
//! of the microphone. Where the platform can cancel that echo, it is used:
//!
//! - **iOS and macOS**: one Voice-Processing I/O unit for both directions
//!   (`io_apple.rs`), on iOS with the audio session in `.voiceChat` mode.
//!   The unit cancels what it plays itself, so the reply is played through
//!   it, not beside it.
//! - **Android**: the microphone opens with the `VoiceCommunication` input
//!   preset (`io_android.rs`), the source Android attaches its echo
//!   canceller and noise suppressor to.
//! - **Windows**, and wherever the above cannot start: plain cpal streams.
//!   cpal has no voice-processing unit, so the detector raises its barge-in
//!   threshold over the reply (`VadConfig::default`) and the voice screen
//!   suggests headphones.
//!
//! Whatever opens, the session reads the same thing: mono microphone
//! samples at `input_rate` through the sink, a [`Player`] the output pulls
//! from, and whether echo is cancelled.

use super::player::Player;
use crate::domain::types::AppError;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::Arc;

/// Where microphone audio goes: mono samples at the input rate. Called on
/// the audio thread.
pub type MicSink = Arc<dyn Fn(&[f32]) + Send + Sync>;

pub struct AudioIo {
    pub input_rate: u32,
    pub player: Arc<Player>,
    /// Whether the platform cancels the speaker's echo in the microphone.
    pub echo_cancelled: bool,
    /// The streams (or the unit), kept alive for the session.
    pub(super) _keep: Vec<Box<dyn std::any::Any>>,
}

/// Opens the platform's best duplex audio. `allow_platform_echo_cancelling`
/// false forces the plain streams (the fallback when voice processing
/// opened but never delivered a sample).
pub fn open(sink: MicSink, allow_platform_echo_cancelling: bool) -> Result<AudioIo, AppError> {
    open_platform(sink, allow_platform_echo_cancelling)
}

/// The platform's echo-cancelling route when it is allowed and starts,
/// otherwise the plain one. `allow` false (the watchdog's reopen) never
/// tries the echo-cancelling route again.
fn prefer_echo_cancelling<T>(
    allow: bool,
    echo_cancelling: impl FnOnce() -> Result<T, String>,
    plain: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    if allow {
        match echo_cancelling() {
            Ok(io) => return Ok(io),
            Err(error) => {
                tracing::warn!(%error, "voice echo cancellation unavailable, using plain streams");
            }
        }
    }
    plain()
}

#[cfg(target_os = "ios")]
fn open_platform(sink: MicSink, allow_echo_cancelling: bool) -> Result<AudioIo, AppError> {
    crate::audio::ios_session::ensure_record_permission()?;
    crate::audio::ios_session::configure_for_voice_chat()?;
    prefer_echo_cancelling(
        allow_echo_cancelling,
        || super::io_apple::open(Arc::clone(&sink)),
        || open_plain(sink.clone()),
    )
}

/// The Mac has the same voice-processing unit as the iPhone. The microphone
/// permission is the app's own (the first open asks), as with cpal.
#[cfg(target_os = "macos")]
fn open_platform(sink: MicSink, allow_echo_cancelling: bool) -> Result<AudioIo, AppError> {
    prefer_echo_cancelling(
        allow_echo_cancelling,
        || super::io_apple::open(Arc::clone(&sink)),
        || open_plain(sink.clone()),
    )
}

#[cfg(target_os = "android")]
fn open_platform(sink: MicSink, allow_echo_cancelling: bool) -> Result<AudioIo, AppError> {
    let recording = crate::android::RecordingGuard::start()?;
    let mut io = prefer_echo_cancelling(
        allow_echo_cancelling,
        || {
            let (input_rate, stream) = super::io_android::open(Arc::clone(&sink))?;
            let (player, output) = open_output().map_err(|error| error.message)?;
            Ok(AudioIo {
                input_rate,
                player,
                echo_cancelled: true,
                _keep: vec![stream, output],
            })
        },
        || open_plain(sink.clone()),
    )?;
    io._keep.push(Box::new(recording));
    Ok(io)
}

#[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "android")))]
fn open_platform(sink: MicSink, _allow_echo_cancelling: bool) -> Result<AudioIo, AppError> {
    open_plain(sink)
}

/// cpal input and output, no echo cancellation.
fn open_plain(sink: MicSink) -> Result<AudioIo, AppError> {
    let (input_rate, input) = open_input(sink)?;
    let (player, output) = open_output()?;
    Ok(AudioIo {
        input_rate,
        player,
        echo_cancelled: false,
        _keep: vec![input, output],
    })
}

fn microphone_error(detail: impl std::fmt::Display) -> AppError {
    tracing::warn!(%detail, "voice microphone failed to open");
    AppError::new(
        "voice_microphone_unavailable",
        "The microphone could not start. Check that it is connected and allowed, then try again.",
    )
}

fn speaker_error(detail: impl std::fmt::Display) -> AppError {
    tracing::warn!(%detail, "voice speaker failed to open");
    AppError::new(
        "voice_speaker_unavailable",
        "The speaker could not start. Check your sound output, then try again.",
    )
}

fn open_input(sink: MicSink) -> Result<(u32, Box<dyn std::any::Any>), AppError> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| microphone_error("no default input device"))?;
    let config = device.default_input_config().map_err(microphone_error)?;
    let rate = config.sample_rate().0;
    let channels = usize::from(config.channels()).max(1);
    let on_error = |error| tracing::warn!(%error, "voice input stream error");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _| sink(&super::resample::to_mono(data, channels)),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[i16], _| {
                let floats: Vec<f32> = data
                    .iter()
                    .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
                    .collect();
                sink(&super::resample::to_mono(&floats, channels));
            },
            on_error,
            None,
        ),
        other => return Err(microphone_error(format!("sample format {other:?}"))),
    }
    .map_err(microphone_error)?;
    stream.play().map_err(microphone_error)?;
    Ok((rate, Box::new(stream)))
}

fn open_output() -> Result<(Arc<Player>, Box<dyn std::any::Any>), AppError> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| speaker_error("no default output device"))?;
    let config = device.default_output_config().map_err(speaker_error)?;
    let player = Arc::new(Player::new(config.sample_rate().0));
    let channels = usize::from(config.channels()).max(1);
    let on_error = |error| tracing::warn!(%error, "voice output stream error");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let player = Arc::clone(&player);
            device.build_output_stream(
                &config.clone().into(),
                move |data: &mut [f32], _| player.fill(data, channels),
                on_error,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let player = Arc::clone(&player);
            let mut scratch: Vec<f32> = Vec::new();
            device.build_output_stream(
                &config.clone().into(),
                move |data: &mut [i16], _| {
                    scratch.resize(data.len(), 0.0);
                    player.fill(&mut scratch, channels);
                    for (out, sample) in data.iter_mut().zip(&scratch) {
                        *out = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
                    }
                },
                on_error,
                None,
            )
        }
        other => return Err(speaker_error(format!("sample format {other:?}"))),
    }
    .map_err(speaker_error)?;
    stream.play().map_err(speaker_error)?;
    Ok((player, Box::new(stream)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn plain_error() -> AppError {
        microphone_error("no default input device")
    }

    #[test]
    fn echo_cancelling_is_preferred_when_it_starts() {
        let plain_tried = Cell::new(false);
        let route = prefer_echo_cancelling(
            true,
            || Ok("voice processing"),
            || {
                plain_tried.set(true);
                Ok("plain")
            },
        );
        assert_eq!(route.map_err(|error| error.code), Ok("voice processing"));
        assert!(
            !plain_tried.get(),
            "the plain streams must not open as well"
        );
    }

    #[test]
    fn a_unit_that_cannot_start_falls_back_to_the_plain_streams() {
        let route = prefer_echo_cancelling(
            true,
            || Err("AudioUnitInitialize -10875".to_string()),
            || Ok("plain"),
        );
        assert_eq!(route.map_err(|error| error.code), Ok("plain"));
    }

    #[test]
    fn the_watchdog_reopen_never_tries_the_unit_again() {
        let unit_tried = Cell::new(false);
        let route = prefer_echo_cancelling(
            false,
            || {
                unit_tried.set(true);
                Ok("voice processing")
            },
            || Ok("plain"),
        );
        assert_eq!(route.map_err(|error| error.code), Ok("plain"));
        assert!(!unit_tried.get());
    }

    #[test]
    fn when_both_fail_the_plain_error_is_the_one_shown() {
        let route: Result<&str, AppError> =
            prefer_echo_cancelling(true, || Err("no unit".to_string()), || Err(plain_error()));
        assert_eq!(
            route.map_err(|error| error.code),
            Err("voice_microphone_unavailable".to_string())
        );
    }
}
