//! A live voice conversation: one thread that owns the audio, runs the
//! engine, and carries out its effects.
//!
//! The thread is the only place the microphone and the speaker live (cpal
//! streams are not `Send` on every platform), and everything else talks to
//! it through one channel: microphone samples from the audio callback,
//! answers from the requests it spawned, the reply text and the controls
//! from the webview. It wakes at least every 20 ms to collect the clips the
//! speaker finished.
//!
//! The chat turn itself is not sent from here. The webview sends it through
//! the shell's own chat (the desktop agent runtime, the phone's agent-lite),
//! so a voice turn is a normal turn: the same history, the same tools and
//! connectors, the same memory. The session asks for it with a `turn`
//! event, is fed the reply as it streams, and asks for a stop with a
//! `cancel` event when the person speaks over it.
//!
//! Live, not durable (ADR-0018 is about work that must outlive the screen):
//! a conversation is something the person is in, and it ends with the app's
//! foreground. The turns it sent are ordinary chat turns, durable as such.

use super::engine::Engine;
use super::io::{self, AudioIo, MicSink};
use super::machine::{Effect, Input, Phase};
use super::player::ClipId;
use super::requests::{self, SpeechVoice};
use super::vad::VadConfig;
use super::VoiceEvent;
use crate::domain::types::AppError;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

pub enum Message {
    /// Microphone samples, mono, at the input rate.
    Audio(Vec<f32>),
    Input(Input),
    /// A rendered sentence, at the player's rate.
    Clip {
        turn: u64,
        index: usize,
        samples: Vec<f32>,
    },
    Mute(bool),
    /// Something ends the conversation with a reason (protected mode).
    Fail(AppError),
    Stop,
}

/// How the session tells the webview what happened.
pub type Emit = Box<dyn Fn(VoiceEvent) + Send>;

/// No microphone sample for this long after opening means the platform's
/// voice processing opened silent: reopen with the plain streams. Long
/// enough for a Bluetooth headset to switch to its microphone profile.
const MICROPHONE_WATCHDOG: Duration = Duration::from_millis(3_000);
const LEVEL_INTERVAL: Duration = Duration::from_millis(80);

pub struct Started {
    pub sender: Sender<Message>,
    pub echo_cancelled: bool,
    pub thread: std::thread::JoinHandle<()>,
}

/// Opens the audio and starts the session thread. Fails (and leaves nothing
/// running) when the audio cannot open.
pub fn start(session_id: String, voice: SpeechVoice, emit: Emit) -> Result<Started, AppError> {
    let (sender, receiver) = mpsc::channel::<Message>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<bool, AppError>>();
    let loop_sender = sender.clone();
    let thread = std::thread::Builder::new()
        .name("voice-session".into())
        .spawn(move || {
            let io = match io::open(mic_sink(&loop_sender), true) {
                Ok(io) => io,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(io.echo_cancelled));
            run(session_id, voice, io, loop_sender, receiver, emit);
        })
        .map_err(|error| AppError::new("voice_start_failed", error.to_string()))?;
    let echo_cancelled = ready_rx
        .recv()
        .map_err(|_| AppError::new("voice_start_failed", "The voice session stopped."))??;
    Ok(Started {
        sender,
        echo_cancelled,
        thread,
    })
}

fn mic_sink(sender: &Sender<Message>) -> MicSink {
    let sender = sender.clone();
    std::sync::Arc::new(move |samples: &[f32]| {
        let _ = sender.send(Message::Audio(samples.to_vec()));
    })
}

fn vad_config(echo_cancelled: bool) -> VadConfig {
    if echo_cancelled {
        VadConfig::with_echo_cancellation()
    } else {
        VadConfig::default()
    }
}

/// How a skipped fenced block is said, in the person's language.
pub fn fence_label(info: &str) -> String {
    let info = info.trim().to_ascii_lowercase();
    let Some(kind) = info.strip_prefix("subrosa:").map(str::trim) else {
        return crate::tr!("There is some code here.");
    };
    match kind {
        "links" => crate::tr!("There are links here."),
        "places" => crate::tr!("There are places here."),
        "notes" => crate::tr!("There are notes here."),
        "chart" => crate::tr!("There is a chart here."),
        "table" => crate::tr!("There is a table here."),
        _ => crate::tr!("There is a card here."),
    }
}

struct Loop {
    session_id: String,
    voice: SpeechVoice,
    io: AudioIo,
    engine: Engine,
    resampler: super::resample::Resampler,
    sender: Sender<Message>,
    emit: Emit,
    clips: HashMap<(u64, usize), Vec<f32>>,
    heard_audio: bool,
    opened: Instant,
    last_level: Instant,
    input_db: f32,
}

fn run(
    session_id: String,
    voice: SpeechVoice,
    io: AudioIo,
    sender: Sender<Message>,
    receiver: Receiver<Message>,
    emit: Emit,
) {
    let engine = Engine::new(vad_config(io.echo_cancelled), fence_label);
    let resampler = super::resample::Resampler::new(io.input_rate, super::vad::SAMPLE_RATE);
    let mut state = Loop {
        session_id,
        voice,
        io,
        engine,
        resampler,
        sender,
        emit,
        clips: HashMap::new(),
        heard_audio: false,
        opened: Instant::now(),
        last_level: Instant::now(),
        input_db: -100.0,
    };
    (state.emit)(VoiceEvent::Phase {
        phase: Phase::Listening,
    });
    loop {
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(Message::Audio(samples)) => state.on_audio(&samples),
            Ok(Message::Input(input)) => {
                let effects = state.engine.handle(input);
                state.execute(effects);
            }
            Ok(Message::Clip {
                turn,
                index,
                samples,
            }) => {
                state.clips.insert((turn, index), samples);
                let effects = state.engine.handle(Input::Rendered { turn, index });
                state.execute(effects);
            }
            Ok(Message::Mute(muted)) => {
                let effects = state.engine.set_muted(muted);
                state.execute(effects);
            }
            Ok(Message::Fail(error)) => {
                (state.emit)(VoiceEvent::Error {
                    code: error.code,
                    message: error.message,
                });
                break;
            }
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
        for ClipId { turn, index } in state.io.player.take_finished() {
            state.clips.remove(&(turn, index));
            let effects = state.engine.handle(Input::PlaybackFinished { turn, index });
            state.execute(effects);
        }
        if !state.heard_audio && state.opened.elapsed() >= MICROPHONE_WATCHDOG {
            if let Err(error) = state.reopen_plain() {
                (state.emit)(VoiceEvent::Error {
                    code: error.code,
                    message: error.message,
                });
                break;
            }
        }
    }
    state.io.player.stop();
    drop(state.io);
    #[cfg(target_os = "ios")]
    crate::audio::ios_session::deactivate();
    (state.emit)(VoiceEvent::Ended);
}

impl Loop {
    fn on_audio(&mut self, samples: &[f32]) {
        self.heard_audio = true;
        let resampled = self.resampler.process(samples);
        let playback = self.io.player.level_db();
        let effects = self.engine.push_audio(&resampled, playback);
        self.execute(effects);
        let level = super::vad::frame_db(&resampled);
        self.input_db = level.max(self.input_db - 1.5);
        if self.last_level.elapsed() >= LEVEL_INTERVAL {
            self.last_level = Instant::now();
            (self.emit)(VoiceEvent::Level {
                input: db_to_unit(self.input_db),
                output: db_to_unit(playback.unwrap_or(-100.0)),
            });
        }
    }

    /// The voice-processing input opened silent: start again on the plain
    /// streams, with the threshold that expects echo.
    fn reopen_plain(&mut self) -> Result<(), AppError> {
        self.opened = Instant::now();
        if !self.io.echo_cancelled {
            // Already plain: the microphone is simply not sending sound.
            return Err(AppError::new(
                "voice_microphone_silent",
                "The microphone is not sending any sound. Check that it is allowed and not in use by another app.",
            ));
        }
        tracing::warn!("voice processing input silent, reopening plain streams");
        self.io.player.stop();
        let plain = io::open(mic_sink(&self.sender), false)?;
        self.io = plain;
        self.resampler =
            super::resample::Resampler::new(self.io.input_rate, super::vad::SAMPLE_RATE);
        self.engine = Engine::new(vad_config(false), fence_label);
        self.clips.clear();
        (self.emit)(VoiceEvent::EchoCancellation { active: false });
        Ok(())
    }

    fn execute(&mut self, effects: Vec<Effect>) {
        let mut queue: VecDeque<Effect> = effects.into();
        while let Some(effect) = queue.pop_front() {
            match effect {
                Effect::Transcribe { utterance } => self.transcribe(utterance),
                Effect::SendTurn { turn, text } => (self.emit)(VoiceEvent::Turn { turn, text }),
                Effect::CancelTurn { turn } => (self.emit)(VoiceEvent::Cancel { turn }),
                Effect::Render { turn, index, text } => self.render(turn, index, text),
                Effect::Play { turn, index } => match self.clips.remove(&(turn, index)) {
                    Some(samples) => self.io.player.play(ClipId { turn, index }, samples),
                    None => {
                        queue.extend(self.engine.handle(Input::PlaybackFinished { turn, index }))
                    }
                },
                Effect::StopPlayback => {
                    self.io.player.stop();
                    self.clips.clear();
                }
                Effect::Phase(phase) => (self.emit)(VoiceEvent::Phase { phase }),
                Effect::Heard { text } => (self.emit)(VoiceEvent::Caption {
                    role: super::CaptionRole::User,
                    text,
                }),
                Effect::Saying { text } => (self.emit)(VoiceEvent::Caption {
                    role: super::CaptionRole::Assistant,
                    text,
                }),
                Effect::Notice(notice) => (self.emit)(VoiceEvent::Notice { notice }),
            }
        }
    }

    fn transcribe(&mut self, utterance: u64) {
        let samples = self.engine.take_utterance(utterance).unwrap_or_default();
        let sender = self.sender.clone();
        let session_id = self.session_id.clone();
        tauri::async_runtime::spawn(async move {
            // The switch can change mid-conversation: each utterance asks.
            let input = match crate::protected_mode::check_voice() {
                Err(error) => {
                    tracing::info!(code = %error.code, "voice turn refused by protected mode");
                    let _ = sender.send(Message::Fail(error));
                    return;
                }
                Ok(()) => match requests::transcribe(&session_id, utterance, samples).await {
                    Ok(text) => Input::Transcribed { utterance, text },
                    Err(error) => {
                        tracing::warn!(code = %error.code, "voice transcription failed");
                        Input::TranscriptionFailed { utterance }
                    }
                },
            };
            let _ = sender.send(Message::Input(input));
        });
    }

    fn render(&mut self, turn: u64, index: usize, text: String) {
        let sender = self.sender.clone();
        let voice = self.voice.clone();
        let rate = self.io.player.rate();
        tauri::async_runtime::spawn(async move {
            let message = match requests::render_speech(&voice, &text).await {
                Ok((samples, clip_rate)) => Message::Clip {
                    turn,
                    index,
                    samples: super::resample::resample(&samples, clip_rate, rate),
                },
                Err(error) => {
                    tracing::warn!(code = %error.code, "voice sentence could not be rendered");
                    Message::Input(Input::RenderFailed { turn, index })
                }
            };
            let _ = sender.send(message);
        });
    }
}

/// dBFS to 0..1 for the level meter: -60 dB and below is still, 0 is full.
fn db_to_unit(db: f32) -> f32 {
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_are_named_by_their_kind_in_the_persons_language() {
        use crate::i18n::{with_locale, Locale};
        with_locale(Locale::En, || {
            assert_eq!(fence_label("python"), "There is some code here.");
            assert_eq!(fence_label(" subrosa:places "), "There are places here.");
            assert_eq!(fence_label("subrosa:links"), "There are links here.");
            assert_eq!(fence_label("subrosa:whatever"), "There is a card here.");
        });
        with_locale(Locale::Fr, || {
            assert_eq!(fence_label("rust"), "Il y a du code ici.");
        });
    }

    #[test]
    fn the_meter_maps_decibels_to_a_unit() {
        assert_eq!(db_to_unit(-100.0), 0.0);
        assert_eq!(db_to_unit(0.0), 1.0);
        assert!((db_to_unit(-30.0) - 0.5).abs() < 1.0e-6);
    }
}
