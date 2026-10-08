//! iOS and macOS: the microphone and the speaker through one
//! Voice-Processing I/O unit, so the system cancels the reply's echo before
//! the detector hears it.
//!
//! cpal opens a Remote I/O unit on iOS and a HAL output unit on macOS, and
//! both record what the speaker plays. The voice-processing unit is the same
//! audio unit family with echo cancellation, automatic gain and noise
//! suppression, present on both systems, and it cancels what it
//! plays itself: the reply has to go out through its output element, not
//! through a second stream. The shape follows cpal's own input path (enable
//! I/O, set the stream format, set the callback), with both elements enabled
//! and one mono float format on each side. On macOS the unit follows the
//! default input and output devices; there is no audio session to configure.
//!
//! Unverified on an iPhone at the time of writing. When the unit cannot
//! start, `io.rs` opens the plain cpal streams (and the detector raises its
//! barge-in threshold); when it opens but never delivers a sample, the
//! session does the same (`session.rs`, the microphone watchdog).

use super::io::{AudioIo, MicSink};
use super::player::Player;
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{AudioUnit, Element, IOType, Scope};
use coreaudio::sys::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatLinearPCM,
    kAudioOutputUnitProperty_EnableIO, kAudioUnitProperty_StreamFormat, AudioBuffer,
    AudioStreamBasicDescription,
};
use std::sync::Arc;

/// The rate both directions run at. The voice-processing unit resamples
/// to the hardware itself; 24 kHz is what most speech engines render.
const RATE: u32 = 24_000;

pub fn open(sink: MicSink) -> Result<AudioIo, String> {
    let mut unit = AudioUnit::new(IOType::VoiceProcessingIO).map_err(|error| error.to_string())?;
    unit.uninitialize().map_err(|error| error.to_string())?;
    let enable = 1u32;
    unit.set_property(
        kAudioOutputUnitProperty_EnableIO,
        Scope::Input,
        Element::Input,
        Some(&enable),
    )
    .map_err(|error| error.to_string())?;
    unit.set_property(
        kAudioOutputUnitProperty_EnableIO,
        Scope::Output,
        Element::Output,
        Some(&enable),
    )
    .map_err(|error| error.to_string())?;
    let format = AudioStreamBasicDescription {
        mSampleRate: f64::from(RATE),
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 32,
        ..Default::default()
    };
    // What the microphone element hands us, and what we hand the speaker.
    unit.set_property(
        kAudioUnitProperty_StreamFormat,
        Scope::Output,
        Element::Input,
        Some(&format),
    )
    .map_err(|error| error.to_string())?;
    unit.set_property(
        kAudioUnitProperty_StreamFormat,
        Scope::Input,
        Element::Output,
        Some(&format),
    )
    .map_err(|error| error.to_string())?;

    type Args = render_callback::Args<data::Raw>;
    unit.set_input_callback(move |args: Args| {
        // SAFETY: the unit renders into the buffer list coreaudio-rs
        // allocated for the format set above: one buffer of mono f32.
        let samples = unsafe { first_buffer(args.data.data) };
        if let Some((pointer, len)) = samples {
            let samples = unsafe { std::slice::from_raw_parts(pointer as *const f32, len) };
            sink(samples);
        }
        Ok(())
    })
    .map_err(|error| error.to_string())?;

    let player = Arc::new(Player::new(RATE));
    let speaker = Arc::clone(&player);
    unit.set_render_callback(move |args: Args| {
        // SAFETY: the output element asks for the format set above.
        let buffers = unsafe { first_buffer(args.data.data) };
        if let Some((pointer, len)) = buffers {
            let out = unsafe { std::slice::from_raw_parts_mut(pointer as *mut f32, len) };
            speaker.fill(out, 1);
        }
        Ok(())
    })
    .map_err(|error| error.to_string())?;

    unit.initialize().map_err(|error| error.to_string())?;
    unit.start().map_err(|error| error.to_string())?;
    Ok(AudioIo {
        input_rate: RATE,
        player,
        echo_cancelled: true,
        _keep: vec![Box::new(unit)],
    })
}

/// The first buffer of a list as a pointer and a length in f32 samples.
unsafe fn first_buffer(list: *mut coreaudio::sys::AudioBufferList) -> Option<(*mut u8, usize)> {
    if list.is_null() || (*list).mNumberBuffers == 0 {
        return None;
    }
    let buffer: &AudioBuffer = &(*list).mBuffers[0];
    if buffer.mData.is_null() {
        return None;
    }
    Some((
        buffer.mData as *mut u8,
        buffer.mDataByteSize as usize / std::mem::size_of::<f32>(),
    ))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Opens the Mac's real voice-processing unit for a moment and checks
    /// both directions run: the microphone element delivers samples and the
    /// speaker element pulls them. Needs audio devices (and asks for the
    /// microphone the first time), so it is not part of the default run:
    /// `cargo test --lib voice::io_apple -- --ignored`.
    #[test]
    #[ignore = "opens the real microphone and speaker"]
    fn the_unit_opens_and_runs_both_directions_on_this_mac() {
        let heard = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&heard);
        let io = open(Arc::new(move |samples: &[f32]| {
            counter.fetch_add(samples.len(), Ordering::Relaxed);
        }))
        .unwrap_or_else(|error| panic!("the unit did not open: {error}"));
        assert!(io.echo_cancelled);
        assert_eq!(io.input_rate, RATE);
        io.player.play(
            super::super::player::ClipId { turn: 1, index: 0 },
            vec![0.0; RATE as usize / 5],
        );
        std::thread::sleep(std::time::Duration::from_millis(1_500));
        let samples = heard.load(Ordering::Relaxed);
        let finished = io.player.take_finished();
        drop(io);
        eprintln!("microphone samples in 1.5 s: {samples}; clips finished: {finished:?}");
        assert!(samples > RATE as usize / 2, "only {samples} samples");
        assert_eq!(finished.len(), 1, "the speaker never pulled the clip");
    }
}
