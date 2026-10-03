//! A track's silhouette: how loud it is along its length, in a few dozen bars.
//!
//! The gallery drew every track as the same grey tile with a note on it, so
//! ten songs looked like one song ten times. The shape of the sound is the
//! one picture a track has, and it is cheap to measure once: decode, keep the
//! loudest sample of each short window, then fold the windows into bars.
//! Decoding is Symphonia, in process, as for imports (ADR-0026).

use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::domain::types::AppError;

/// Frames per measured window before folding: fine enough that a short
/// effect still has shape, coarse enough that a long song stays a few
/// thousand numbers.
const WINDOW_FRAMES: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Waveform {
    pub duration_ms: i64,
    /// `bins` values in 0..=1, loudest bar at 1.
    pub peaks: Vec<f32>,
}

/// Measures the file at `path` into `bins` bars.
pub fn measure(path: &Path, bins: usize) -> Result<Waveform, AppError> {
    let failed = |error: SymphoniaError| AppError::new("media_decode_failed", error.to_string());
    let file = std::fs::File::open(path)
        .map_err(|error| AppError::new("media_decode_failed", error.to_string()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(failed)?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| AppError::new("media_decode_unsupported", "No audio track."))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(failed)?;

    let mut windows: Vec<f32> = Vec::new();
    let mut current = 0.0_f32;
    let mut in_window = 0_usize;
    let mut frames = 0_u64;
    let mut rate = 0_u32;
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(failed(error)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(failed(error)),
        };
        let spec = *decoded.spec();
        rate = spec.rate.max(1);
        let channels = spec.channels.count().max(1);
        let capacity = decoded.capacity() as u64;
        let needs_new = match buffer.as_ref() {
            Some(existing) => (existing.capacity() as u64) < capacity * channels as u64,
            None => true,
        };
        if needs_new {
            buffer = Some(SampleBuffer::<f32>::new(capacity, spec));
        }
        let Some(samples) = buffer.as_mut() else {
            continue;
        };
        samples.copy_interleaved_ref(decoded);
        for frame in samples.samples().chunks(channels) {
            let loudest = frame
                .iter()
                .fold(0.0_f32, |max, sample| max.max(sample.abs()));
            current = current.max(loudest);
            in_window += 1;
            frames += 1;
            if in_window == WINDOW_FRAMES {
                windows.push(current);
                current = 0.0;
                in_window = 0;
            }
        }
    }
    if in_window > 0 {
        windows.push(current);
    }
    if windows.is_empty() || rate == 0 {
        return Err(AppError::new(
            "media_decode_empty",
            "This file contains no audio.",
        ));
    }
    Ok(Waveform {
        duration_ms: (frames as i64 * 1000) / rate as i64,
        peaks: fold(&windows, bins),
    })
}

/// Folds measured windows into `bins` bars (each the loudest window it
/// covers), normalised so the loudest bar is 1 and rounded to two places.
pub(crate) fn fold(windows: &[f32], bins: usize) -> Vec<f32> {
    if windows.is_empty() || bins == 0 {
        return Vec::new();
    }
    let mut bars = Vec::with_capacity(bins);
    for bin in 0..bins {
        let start = bin * windows.len() / bins;
        let end = ((bin + 1) * windows.len() / bins)
            .max(start + 1)
            .min(windows.len());
        let loudest = windows[start.min(windows.len() - 1)..end]
            .iter()
            .fold(0.0_f32, |max, value| max.max(*value));
        bars.push(loudest);
    }
    let top = bars.iter().fold(0.0_f32, |max, value| max.max(*value));
    if top <= f32::EPSILON {
        return vec![0.0; bins];
    }
    bars.iter()
        .map(|value| ((value / top) * 100.0).round() / 100.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_into_the_asked_number_of_bars_with_the_loudest_at_one() {
        let windows = [0.1, 0.2, 0.8, 0.4, 0.0, 0.2];
        assert_eq!(fold(&windows, 3), vec![0.25, 1.0, 0.25]);
        // Fewer windows than bars still yields every bar.
        assert_eq!(fold(&[0.5], 4).len(), 4);
        assert_eq!(fold(&[0.0, 0.0], 2), vec![0.0, 0.0]);
        assert!(fold(&[], 4).is_empty());
    }

    #[test]
    fn measures_a_wav_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        // One quiet second, then one loud second.
        for index in 0..16_000 {
            let amplitude = if index < 8000 { 2000.0 } else { 20000.0 };
            let value = (index as f32 * 0.3).sin() * amplitude;
            writer.write_sample(value as i16).unwrap();
        }
        writer.finalize().unwrap();
        let waveform = measure(&path, 8).unwrap();
        assert_eq!(waveform.duration_ms, 2000);
        assert_eq!(waveform.peaks.len(), 8);
        assert!(waveform.peaks[0] < 0.2, "{:?}", waveform.peaks);
        assert!(waveform.peaks[7] > 0.9, "{:?}", waveform.peaks);
    }
}
