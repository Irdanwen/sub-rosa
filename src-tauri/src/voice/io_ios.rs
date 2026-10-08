//! iOS: the microphone and the speaker through one Voice-Processing I/O
//! unit, so the system cancels the reply's echo before the detector hears
//! it.
//!
//! cpal opens a Remote I/O unit, which records what the speaker plays. The
//! voice-processing unit is the same audio unit family with echo
//! cancellation, automatic gain and noise suppression, and it cancels what
//! it plays itself: the reply has to go out through its output element, not
//! through a second stream. The shape follows cpal's own iOS input path
//! (enable I/O, set the stream format, set the callback), with both
//! elements enabled and one mono float format on each side.
//!
//! Unverified on hardware at the time of writing: if the unit opens but
//! never delivers a sample, the session falls back to the plain streams
//! (`session.rs`, the microphone watchdog).

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
