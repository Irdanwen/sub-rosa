//! The imports that used to be impossible.
//!
//! The unit tests in `audio::decode` run on WAV, which proves the plumbing but
//! not the point: before ADR-0026 a compressed file was shipped whole to the
//! transcription endpoint and anything past 25 MB simply could not be
//! imported. These fixtures are the formats an import actually arrives in — an
//! MP3 podcast, an AAC voice memo, and a real H.264 video whose audio track
//! has to be picked out of the container — and each is one second of a 440 Hz
//! tone at 48 kHz, a few kilobytes on disk.

use os_june_lib::audio::decode::decode_to_transcription_wav;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/media")
        .join(name)
}

/// Reads back what the decoder wrote: rate, channels, duration and peak.
fn decoded_shape(path: &Path) -> (u32, u16, usize, u16) {
    let mut reader = hound::WavReader::open(path).expect("decoded output must be a readable WAV");
    let spec = reader.spec();
    let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap_or(0)).collect();
    let peak = samples
        .iter()
        .map(|sample| sample.unsigned_abs())
        .max()
        .unwrap_or(0);
    (spec.sample_rate, spec.channels, samples.len(), peak)
}

#[test]
fn decodes_mp3_aac_and_a_video_container_into_transcription_audio() {
    for name in ["tone.mp3", "tone.m4a", "tone-video.mp4"] {
        let dir = tempdir().unwrap();
        let output = dir.path().join("decoded.wav");

        let decoded = decode_to_transcription_wav(&fixture(name), &output)
            .unwrap_or_else(|error| panic!("{name} must decode: {error:?}"));

        let (rate, channels, frames, peak) = decoded_shape(&output);
        assert_eq!(rate, 16_000, "{name} must be resampled for transcription");
        assert_eq!(channels, 1, "{name} must be downmixed to mono");
        // One second in, one second out. Encoder priming and the container's
        // own padding move this by a few tens of milliseconds, never more.
        assert!(
            (decoded.duration_ms - 1_000).abs() < 150,
            "{name} decoded to {} ms",
            decoded.duration_ms
        );
        assert_eq!(
            frames,
            (decoded.duration_ms as usize * 16_000) / 1_000,
            "{name}: reported duration must match the frames written"
        );
        // A 440 Hz tone at -5 dBFS is not silence. This is what catches a
        // decoder that "succeeds" while writing zeroes.
        assert!(peak > 8_000, "{name} decoded to near-silence (peak {peak})");
    }
}

/// The whole reason this module exists: a video file is an audio track the app
/// reads and a container it skips. The MP4 fixture's *default* track is video,
/// so a decoder that trusted the default track would find no audio at all.
#[test]
fn a_video_files_audio_track_is_found_even_though_the_default_track_is_video() {
    let dir = tempdir().unwrap();
    let output = dir.path().join("from-video.wav");

    let decoded = decode_to_transcription_wav(&fixture("tone-video.mp4"), &output).unwrap();

    let (_, _, _, peak) = decoded_shape(&output);
    assert!(peak > 8_000, "audio track was not decoded (peak {peak})");
    assert!(decoded.duration_ms > 800);
}

/// Callers key their fallback off the error code, so it is part of the
/// contract: unsupported means "try the other path", not "give up".
#[test]
fn an_undecodable_file_is_named_unsupported_rather_than_failed() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("agenda.txt");
    std::fs::write(&input, b"09:00 standup\n10:00 review\n").unwrap();

    let error = decode_to_transcription_wav(&input, &dir.path().join("out.wav")).unwrap_err();

    assert_eq!(error.code, "media_decode_unsupported");
}

/// A truncated download is the common real-world corruption. Half an MP3 is
/// still an MP3: the packets that arrived must decode, because throwing away a
/// mostly-complete import helps nobody.
#[test]
fn a_truncated_file_yields_the_audio_that_did_arrive() {
    let dir = tempdir().unwrap();
    let whole = std::fs::read(fixture("tone.mp3")).unwrap();
    let truncated = dir.path().join("half.mp3");
    std::fs::write(&truncated, &whole[..whole.len() / 2]).unwrap();

    let decoded = decode_to_transcription_wav(&truncated, &dir.path().join("out.wav"))
        .expect("a truncated file must yield what it contains");

    assert!(
        decoded.duration_ms > 200,
        "expected most of the tone, got {} ms",
        decoded.duration_ms
    );
}
