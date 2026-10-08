//! Android: the microphone with the `VoiceCommunication` input preset.
//!
//! cpal opens Oboe with Oboe's default preset, `VoiceRecognition`, which is
//! the one source Android leaves raw: no echo canceller, no noise
//! suppressor. A voice conversation wants the opposite, and the
//! communication preset is the source Android's audio policy attaches its
//! acoustic echo canceller to, so the input is opened here with Oboe
//! directly (the same Oboe cpal links). The speaker stays on cpal.
//!
//! Unverified on hardware at the time of writing; when this fails to open,
//! the session uses cpal's input and the higher barge-in threshold.

use super::io::MicSink;
use oboe::{
    AudioInputCallback, AudioInputStreamSafe, AudioStream, AudioStreamBase, AudioStreamBuilder,
    DataCallbackResult, InputPreset, Mono, PerformanceMode, SessionId, SharingMode,
};

struct Callback {
    sink: MicSink,
}

impl AudioInputCallback for Callback {
    type FrameType = (f32, Mono);

    fn on_audio_ready(
        &mut self,
        _stream: &mut dyn AudioInputStreamSafe,
        frames: &[f32],
    ) -> DataCallbackResult {
        (self.sink)(frames);
        DataCallbackResult::Continue
    }
}

/// Opens the communication input. Answers its rate and the stream to keep.
pub fn open(sink: MicSink) -> Result<(u32, Box<dyn std::any::Any>), String> {
    let mut stream = AudioStreamBuilder::default()
        .set_input()
        .set_f32()
        .set_mono()
        .set_input_preset(InputPreset::VoiceCommunication)
        .set_session_id(SessionId::Allocate)
        .set_performance_mode(PerformanceMode::LowLatency)
        .set_sharing_mode(SharingMode::Shared)
        .set_callback(Callback { sink })
        .open_stream()
        .map_err(|error| format!("{error:?}"))?;
    let rate = u32::try_from(stream.get_sample_rate()).unwrap_or(48_000);
    stream
        .request_start()
        .map_err(|error| format!("{error:?}"))?;
    Ok((rate, Box::new(stream)))
}
