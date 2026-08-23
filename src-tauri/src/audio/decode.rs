//! In-process decoding of imported audio and video into the WAV transcription
//! wants (ADR-0026).
//!
//! `import_audio_note` used to hand a compressed file straight to the
//! transcription endpoint, because nothing here could open one. That capped
//! an import at the 25 MB the request allows, which a one-hour recording
//! passes several times over. This module opens the container itself, with
//! [Symphonia] — pure Rust, no subprocess, no bundled binary, so the same code
//! runs on macOS, Windows and iOS — and writes 16 kHz mono 16-bit PCM. From
//! there an import is a WAV, and takes the recorded-audio path with its
//! chunking, silence skipping and retries.
//!
//! It is a decoder, not a player: no seeking, no playback, no user-facing
//! conversion. A video file is an audio track it reads and a container it
//! skips.
//!
//! Everything streams. Decoding writes the file once while tracking the peak,
//! and only rewrites it when gain is actually warranted, so memory is a
//! function of the packet size and never of the recording's duration.
//!
//! [Symphonia]: https://github.com/pdeljanov/Symphonia

use super::turns::{
    gain_is_worth_applying, sample_peak, transcription_gain, TranscriptionWavWriter,
    TRANSCRIPTION_CHANNELS, TRANSCRIPTION_SAMPLE_RATE,
};
use crate::domain::types::AppError;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use std::path::{Path, PathBuf};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// What decoding produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedAudio {
    /// The 16 kHz mono WAV written for transcription.
    pub path: PathBuf,
    pub duration_ms: i64,
    /// Codec Symphonia reported, for diagnostics. Never shown to the user.
    pub codec: String,
}

/// Decode `input_path` into a 16 kHz mono WAV at `output_path`.
///
/// Fails with `media_decode_unsupported` when the container or codec is not
/// one Symphonia implements — notably Opus and HE-AAC, which it does not — so
/// callers can fall back rather than treating it as a hard error. Every other
/// failure is `media_decode_failed`.
pub fn decode_to_transcription_wav(
    input_path: &Path,
    output_path: &Path,
) -> Result<DecodedAudio, AppError> {
    let file = std::fs::File::open(input_path)
        .map_err(|error| AppError::new("media_decode_failed", error.to_string()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(extension) = input_path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(unsupported_or_failed)?;
    let mut format = probed.format;

    // The *default* track of a video file is usually the video track, so pick
    // the first track with a codec we can actually decode.
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| {
            AppError::new(
                "media_decode_unsupported",
                "This file has no audio track this app can read.",
            )
        })?;
    let track_id = track.id;
    let codec = format!("{:?}", track.codec_params.codec);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(unsupported_or_failed)?;

    // Pass one: decode, downmix, resample, write. Gain waits for the peak.
    let mut writer: Option<TranscriptionWavWriter> = None;
    let mut sample_buffer: Option<SampleBuffer<i16>> = None;
    let mut mono: Vec<i16> = Vec::new();
    let mut peak = 0.0_f32;
    let mut input_rate = 0_u32;
    let mut decoded_any = false;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            // Symphonia signals a clean end of stream as an EOF io error.
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(decode_failed(error)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let buffer = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            // A damaged packet in the middle of an otherwise fine recording
            // must cost that packet, not the import.
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(decode_failed(error)),
        };

        let spec = *buffer.spec();
        let channels = spec.channels.count().max(1);
        if writer.is_none() {
            input_rate = spec.rate.max(1);
            writer = Some(TranscriptionWavWriter::create(
                output_path,
                input_rate,
                1.0,
            )?);
        } else if spec.rate.max(1) != input_rate {
            // Rate changes mid-stream are pathological; refusing is honest.
            return Err(AppError::new(
                "media_decode_unsupported",
                "This file changes sample rate part-way through.",
            ));
        }

        let capacity = buffer.capacity() as u64;
        // `is_none_or` would read better but is newer than this crate's MSRV.
        let needs_new_buffer = match sample_buffer.as_ref() {
            Some(existing) => (existing.capacity() as u64) < capacity * channels as u64,
            None => true,
        };
        if needs_new_buffer {
            sample_buffer = Some(SampleBuffer::<i16>::new(capacity, spec));
        }
        let Some(interleaved) = sample_buffer.as_mut() else {
            continue;
        };
        interleaved.copy_interleaved_ref(buffer);

        mono.clear();
        mono.reserve(interleaved.len() / channels + 1);
        for frame in interleaved.samples().chunks(channels) {
            let sum: i32 = frame.iter().map(|sample| *sample as i32).sum();
            let value =
                (sum / frame.len().max(1) as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
            peak = peak.max(sample_peak(value));
            mono.push(value);
        }
        if let Some(writer) = writer.as_mut() {
            writer.push_mono(&mono)?;
        }
        decoded_any = true;
    }

    let Some(writer) = writer else {
        let _ = std::fs::remove_file(output_path);
        return Err(AppError::new(
            "media_decode_unsupported",
            "No audio could be read from this file.",
        ));
    };
    let frames = writer.finish()?;
    if !decoded_any || frames == 0 {
        let _ = std::fs::remove_file(output_path);
        return Err(AppError::new(
            "media_decode_empty",
            "This file contains no audio.",
        ));
    }

    // Pass two, only when it buys something: a WAV-to-WAV gain rewrite, which
    // is far cheaper than decoding the container a second time.
    let gain = transcription_gain(peak);
    if gain_is_worth_applying(gain) {
        apply_gain_in_place(output_path, gain)?;
    }

    Ok(DecodedAudio {
        path: output_path.to_path_buf(),
        duration_ms: (frames as i64 * 1000) / TRANSCRIPTION_SAMPLE_RATE as i64,
        codec,
    })
}

/// Rewrite a 16 kHz mono WAV with a fixed gain, streaming through a sibling
/// file and swapping it in.
fn apply_gain_in_place(path: &Path, gain: f32) -> Result<(), AppError> {
    let scratch = path.with_extension("gain.wav");
    {
        let mut reader = WavReader::open(path)
            .map_err(|error| AppError::new("media_decode_failed", error.to_string()))?;
        let spec = WavSpec {
            channels: TRANSCRIPTION_CHANNELS,
            sample_rate: TRANSCRIPTION_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(&scratch, spec)
            .map_err(|error| AppError::new("media_decode_failed", error.to_string()))?;
        for sample in reader.samples::<i16>() {
            let amplified = (sample.unwrap_or(0) as f32 * gain)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            writer
                .write_sample(amplified)
                .map_err(|error| AppError::new("media_decode_failed", error.to_string()))?;
        }
        writer
            .finalize()
            .map_err(|error| AppError::new("media_decode_failed", error.to_string()))?;
    }
    std::fs::rename(&scratch, path)
        .map_err(|error| AppError::new("media_decode_failed", error.to_string()))?;
    Ok(())
}

/// A probe or codec lookup that fails means "not one of ours"; anything else
/// is a genuine failure. The distinction is what lets `process_imported_audio`
/// fall back to sending the file whole instead of giving up.
fn unsupported_or_failed(error: SymphoniaError) -> AppError {
    match error {
        SymphoniaError::Unsupported(reason) => AppError::new(
            "media_decode_unsupported",
            format!("This file's format is not supported: {reason}."),
        ),
        other => decode_failed(other),
    }
}

fn decode_failed(error: SymphoniaError) -> AppError {
    AppError::new("media_decode_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("os-june-decode-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 48 kHz stereo WAV is a real container Symphonia reads, so it pins the
    /// whole path — probe, decode, downmix, resample, gain — without needing a
    /// binary fixture in the repository.
    fn write_stereo_wav(path: &Path, frames: usize, amplitude: f32) {
        let spec = WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for index in 0..frames {
            let value = ((index as f32 * 0.05).sin() * amplitude) as i16;
            writer.write_sample(value).unwrap();
            writer.write_sample(value).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn decodes_a_container_into_transcription_shaped_audio() {
        let dir = scratch_dir("shape");
        let input = dir.join("source.wav");
        let output = dir.join("decoded.wav");
        // 2 seconds at 48 kHz.
        write_stereo_wav(&input, 96_000, 20_000.0);

        let decoded = decode_to_transcription_wav(&input, &output).unwrap();

        let reader = WavReader::open(&output).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 16_000);
        // 2 seconds in, 2 seconds out, within a sample of rounding.
        assert!(
            (decoded.duration_ms - 2_000).abs() <= 2,
            "duration was {}",
            decoded.duration_ms
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn quiet_audio_is_gained_up_and_loud_audio_is_left_alone() {
        let dir = scratch_dir("gain");
        let quiet_input = dir.join("quiet.wav");
        let quiet_output = dir.join("quiet-decoded.wav");
        write_stereo_wav(&quiet_input, 16_000, 300.0);
        decode_to_transcription_wav(&quiet_input, &quiet_output).unwrap();
        let quiet_peak = WavReader::open(&quiet_output)
            .unwrap()
            .samples::<i16>()
            .map(|sample| sample.unwrap_or(0).unsigned_abs())
            .max()
            .unwrap();

        let loud_input = dir.join("loud.wav");
        let loud_output = dir.join("loud-decoded.wav");
        write_stereo_wav(&loud_input, 16_000, 24_000.0);
        decode_to_transcription_wav(&loud_input, &loud_output).unwrap();
        let loud_peak = WavReader::open(&loud_output)
            .unwrap()
            .samples::<i16>()
            .map(|sample| sample.unwrap_or(0).unsigned_abs())
            .max()
            .unwrap();

        // Both land near the normalization target rather than at their input
        // amplitude, and neither clips.
        assert!(quiet_peak > 3_000, "quiet peak was {quiet_peak}");
        assert!(loud_peak > 20_000, "loud peak was {loud_peak}");
        assert!(quiet_peak < i16::MAX as u16, "quiet peak clipped");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_that_is_not_media_is_reported_as_unsupported() {
        let dir = scratch_dir("garbage");
        let input = dir.join("notes.txt");
        std::fs::write(&input, b"this is not a media file, it is prose").unwrap();

        let error = decode_to_transcription_wav(&input, &dir.join("out.wav")).unwrap_err();

        assert_eq!(
            error.code, "media_decode_unsupported",
            "callers key their fallback off this code: {error:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
