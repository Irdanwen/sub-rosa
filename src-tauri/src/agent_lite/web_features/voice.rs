//! The web client's voice conversation, as Rust says it (see `mod.rs`): the
//! detector's defaults, the sentence limits and the frame size the browser
//! port of `crate::voice` follows (ADR-0093). The loop itself is ported, not
//! exported: it is code, and its tests' vectors are repeated in the site's.

use crate::voice::{player, screen_frame, sentences, vad};

fn export() -> serde_json::Value {
    let plain = vad::VadConfig::default();
    let cancelled = vad::VadConfig::with_echo_cancellation();
    serde_json::json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/voice.rs",
        "sampleRate": vad::SAMPLE_RATE,
        "frameSamples": vad::FRAME_SAMPLES,
        "vad": {
            "minSpeechDb": plain.min_speech_db,
            "aboveFloorDb": plain.above_floor_db,
            "hysteresisDb": plain.hysteresis_db,
            "onsetMs": plain.onset_ms,
            "bargeInOnsetMs": plain.barge_in_onset_ms,
            "endSilenceMs": plain.end_silence_ms,
            "minVoicedMs": plain.min_voiced_ms,
            "maxUtteranceMs": plain.max_utterance_ms,
            "preRollMs": plain.pre_roll_ms,
            "echoCouplingDb": plain.echo_coupling_db,
            "echoMarginDb": plain.echo_margin_db,
        },
        "echoCancelledCouplingDb": cancelled.echo_coupling_db,
        "echoTailMs": player::ECHO_TAIL.as_millis() as u64,
        "sentences": {
            "minChars": sentences::MIN_SENTENCE_CHARS,
            "maxChars": sentences::MAX_SENTENCE_CHARS,
        },
        "frame": {
            "longestSide": screen_frame::LONGEST_SIDE,
            "jpegQuality": screen_frame::JPEG_QUALITY,
        },
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("voice", export());
}
