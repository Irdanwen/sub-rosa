//! The two requests a voice turn makes besides the chat: an utterance to
//! text, a sentence to speech.
//!
//! Transcription takes the dictation's fast path (`/v1/dictate` on the
//! local backend, ADR-0041) with the transcription model of Settings, which
//! is Parakeet unless the person chose another: an utterance is seconds
//! long, and a whole-file request returns as soon as a stream would (there
//! is no streaming transcription on this rail anyway). Speech takes the
//! media proxy's one-call `/audio/speech`, which is where protected mode
//! and quiet hours already stand (ADR-0084); the operator renders a request
//! whole before answering, so a sentence is the unit that keeps the first
//! sound close.

use super::vad::SAMPLE_RATE;
use crate::domain::types::AppError;
use base64::Engine as _;
use serde::Deserialize;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// What the replies are read with: the engine and voice chosen in Settings
/// (the webview resolves `voice-preference.ts` and hands them over).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVoice {
    pub model: String,
    #[serde(default)]
    pub voice: Option<String>,
    /// `wav`, `mp3` or `flac`: one the engine publishes.
    #[serde(default = "default_format")]
    pub format: String,
}

fn default_format() -> String {
    "mp3".to_string()
}

/// Renders one sentence. Answers mono samples and their rate.
pub async fn render_speech(voice: &SpeechVoice, text: &str) -> Result<(Vec<f32>, u32), AppError> {
    let mut body = serde_json::json!({
        "model": voice.model,
        "input": text,
        "speed": 1.0,
        "response_format": voice.format,
    });
    if let Some(name) = voice
        .voice
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        body["voice"] = serde_json::Value::String(name.to_string());
    }
    let response = crate::carpe_diem::media::send("POST", "/audio/speech", Some(&body)).await?;
    if !response.ok {
        let message = response
            .json
            .as_ref()
            .and_then(|json| json.get("error"))
            .and_then(|error| error.as_str().or_else(|| error.get("message")?.as_str()))
            .unwrap_or("The speech request failed.")
            .to_string();
        return Err(AppError::new("voice_speech_failed", message));
    }
    let encoded = response.body_base64.ok_or_else(|| {
        AppError::new(
            "voice_speech_failed",
            "The speech request returned no audio.",
        )
    })?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| AppError::new("voice_speech_failed", error.to_string()))?;
    decode_clip(&bytes, &voice.format)
}

/// Decodes a rendered clip (WAV, MP3 or FLAC) from memory to mono samples.
pub fn decode_clip(bytes: &[u8], extension: &str) -> Result<(Vec<f32>, u32), AppError> {
    let failed = |error: String| AppError::new("voice_speech_failed", error);
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(extension);
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| failed(error.to_string()))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| failed("no audio track".to_string()))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| failed(error.to_string()))?;
    let mut samples = Vec::new();
    let mut rate = 0u32;
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
            Err(error) => return Err(failed(error.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(failed(error.to_string())),
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
        let Some(interleaved) = buffer.as_mut() else {
            continue;
        };
        interleaved.copy_interleaved_ref(decoded);
        samples.extend(super::resample::to_mono(interleaved.samples(), channels));
    }
    if samples.is_empty() || rate == 0 {
        return Err(failed("the clip has no audio".to_string()));
    }
    Ok((samples, rate))
}

/// Writes an utterance (mono, 16 kHz) as the WAV the transcription takes.
pub fn write_utterance_wav(samples: &[f32], path: &Path) -> Result<(), AppError> {
    let failed =
        |error: hound::Error| AppError::new("voice_transcription_failed", error.to_string());
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(failed)?;
    for sample in samples {
        writer
            .write_sample((sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
            .map_err(failed)?;
    }
    writer.finalize().map_err(failed)
}

/// Transcribes one utterance. The WAV lives only for the request.
pub async fn transcribe(
    session_id: &str,
    utterance: u64,
    samples: Vec<f32>,
) -> Result<String, AppError> {
    let path: PathBuf =
        std::env::temp_dir().join(format!("subrosa-voice-{session_id}-{utterance}.wav"));
    write_utterance_wav(&samples, &path)?;
    let result = crate::june_api::dictate_transcribe(crate::june_api::DictateTranscribeRequest {
        audio_path: path.clone(),
        context: None,
        language: None,
        session_id: session_id.to_string(),
        utterance_id: format!("{session_id}-{utterance}"),
    })
    .await;
    let _ = std::fs::remove_file(&path);
    Ok(result?.text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wav_clip_decodes_to_mono_at_its_rate() {
        let mut bytes = Vec::new();
        {
            let mut writer = hound::WavWriter::new(
                Cursor::new(&mut bytes),
                hound::WavSpec {
                    channels: 2,
                    sample_rate: 24_000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap_or_else(|error| panic!("{error}"));
            for index in 0..2_400 {
                let value = if index % 2 == 0 { 8_000 } else { 0 };
                writer
                    .write_sample(value as i16)
                    .unwrap_or_else(|error| panic!("{error}"));
            }
            writer.finalize().unwrap_or_else(|error| panic!("{error}"));
        }
        let (samples, rate) =
            decode_clip(&bytes, "wav").unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(rate, 24_000);
        assert_eq!(samples.len(), 1_200);
        // Left at 8000/32768, right silent: the mix is half the left.
        assert!((samples[0] - 8_000.0 / 32_768.0 / 2.0).abs() < 1.0e-3);
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert_eq!(
            decode_clip(b"not audio at all", "mp3").map_err(|error| error.code),
            Err("voice_speech_failed".to_string())
        );
    }

    #[test]
    fn an_utterance_is_written_as_16_khz_mono() {
        let dir = std::env::temp_dir().join(format!("voice-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap_or_else(|error| panic!("{error}"));
        let path = dir.join("utterance.wav");
        write_utterance_wav(&[0.0, 0.5, -0.5, 2.0], &path)
            .unwrap_or_else(|error| panic!("{error:?}"));
        let reader = hound::WavReader::open(&path).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(reader.spec().channels, 1);
        let samples: Vec<i16> = reader.into_samples().map(|s| s.unwrap_or(0)).collect();
        assert_eq!(samples, vec![0, 16_383, -16_383, i16::MAX]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_voice_reads_from_the_webview_shape() {
        let voice: SpeechVoice = serde_json::from_str(r#"{"model":"tts-kokoro","voice":"af_sky"}"#)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(voice.format, "mp3");
        assert_eq!(voice.voice.as_deref(), Some("af_sky"));
    }
}
