//! The voice loop once, end to end, against the real services and without
//! a microphone (ADR-0093).
//!
//! Debug builds only. Launched with `SUBROSA_VOICE_SELFTEST=1` (on the iOS
//! simulator: `SIMCTL_CHILD_SUBROSA_VOICE_SELFTEST=1 xcrun simctl launch
//! booted xyz.carpediem.subrosa`), the app runs the chain once its local
//! backend is up; the ignored test at the bottom runs the same chain from
//! `cargo test`, against a backend binary it starts itself. The report goes
//! to the log and to `voice-selftest.json` in the app's data folder (the
//! test prints it).
//!
//! What runs is the production code, stage by stage, with only the
//! microphone and the speaker taken out:
//!
//! 1. A spoken question. The real speech engine reads [`QUESTION`]; the clip
//!    is brought to 16 kHz and set in a second of quiet room on each side,
//!    so the detector measures a floor and hears the speech end.
//! 2. The detector and the state machine (`Engine`), fed 20 ms at a time as
//!    the session feeds them, cut the utterance.
//! 3. The utterance is transcribed on the dictation rail
//!    (`requests::transcribe`).
//! 4. The transcript goes in as `Transcribed`; the machine's `SendTurn` is
//!    sent as one streamed chat completion through the local backend (the
//!    phone's agent-lite seam; the desktop's turn is the agent runtime's,
//!    which this does not start) with the chat model of Settings. Each delta
//!    is fed back as `Reply`, as the webview does, until the machine asks
//!    for its first sentence to be rendered.
//! 5. That first sentence is rendered on `/audio/speech` (`render_speech`).
//!
//! Each stage is timed. The detector's cut is measured in audio time (the
//! clip is fed faster than real time), so the end-of-speech to first-sound
//! figure is that hangover plus the three network stages, which is what a
//! person waits through. Nothing runs before the credits are read: below one
//! credit available the test stops without spending anything, and it never
//! touches the payment rails.

use super::engine::Engine;
use super::machine::{Effect, Input};
use super::requests::{self, SpeechVoice};
use super::vad::{VadConfig, FRAME_SAMPLES, SAMPLE_RATE};
use crate::domain::types::AppError;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const ENV: &str = "SUBROSA_VOICE_SELFTEST";
pub const REPORT_FILE: &str = "voice-selftest.json";
const SESSION: &str = "voice-selftest";

/// The question, short so the whole run costs a few hundredths of a credit.
pub const QUESTION: &str = "What is the capital of France? Answer in one short sentence.";
/// Stands in for the shell's own instructions, which this does not load.
const SYSTEM: &str = "You are Sub Rosa. The person is talking to you by voice: answer in one or two short spoken sentences, without markdown.";
/// The cheapest engine the catalog lists with a one-call rail.
const DEFAULT_SPEECH_MODEL: &str = "tts-kokoro";
/// Below this many credits available nothing is sent.
const MIN_CREDITS: f64 = 1.0;
/// Quiet room around the question: long enough for the floor and the
/// detector's 700 ms hangover.
const ROOM_MS: usize = 1_000;
/// About -70 dBFS of noise: a quiet room, not digital silence.
const ROOM_NOISE: f32 = 0.0003;
/// Quieter than this, a frame of the rendered question is not voice.
const QUIET_DB: f32 = -50.0;
const CHAT_MAX_TOKENS: u32 = 300;
const BACKEND_WAIT: Duration = Duration::from_secs(90);

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub credits_available: f64,
    pub speech_model: String,
    pub transcription_model: String,
    pub chat_model: String,
    pub question: String,
    /// The question's own rendering: setup, not part of the loop.
    pub question_render_ms: u64,
    pub question_audio_ms: u64,
    /// What the detector cut, and how long after the speech ended (audio
    /// time: the hangover the person waits through).
    pub utterance_ms: u64,
    pub detector_cut_after_speech_ms: u64,
    pub transcription_ms: u64,
    pub transcript: String,
    pub chat_first_token_ms: u64,
    pub chat_first_sentence_ms: u64,
    pub chat_done_ms: u64,
    pub reply: String,
    pub first_sentence: String,
    pub speech_ms: u64,
    pub first_sentence_audio_ms: u64,
    /// Hangover + transcription + first sentence + its speech.
    pub end_of_speech_to_first_sound_ms: u64,
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn samples_ms(samples: usize) -> u64 {
    (samples as u64 * 1_000) / u64::from(SAMPLE_RATE)
}

fn selftest_error(message: impl Into<String>) -> AppError {
    AppError::new("voice_selftest_failed", message)
}

/// The available balance, or a refusal below [`MIN_CREDITS`].
fn credits_allow(credits: &serde_json::Value) -> Result<f64, AppError> {
    let available = credits
        .get("availableCredits")
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| selftest_error("The credits response has no availableCredits."))?;
    if available < MIN_CREDITS {
        return Err(selftest_error(format!(
            "Only {available} credits are available; the voice self-test needs at least {MIN_CREDITS}."
        )));
    }
    Ok(available)
}

async fn available_credits() -> Result<f64, AppError> {
    let (base, key) = crate::carpe_diem::settings::credentials()
        .ok_or_else(|| selftest_error("No Carpe Diem key is stored."))?;
    let url = format!(
        "{}/credits",
        crate::carpe_diem::settings::catalog_base_url_of(&base)
    );
    let credits: serde_json::Value = crate::http_client::credentialed(Duration::from_secs(20))
        .build()
        .map_err(|error| selftest_error(error.to_string()))?
        .get(url)
        .bearer_auth(key.expose_str())
        .send()
        .await
        .map_err(|error| selftest_error(error.to_string()))?
        .error_for_status()
        .map_err(|error| selftest_error(error.to_string()))?
        .json()
        .await
        .map_err(|error| selftest_error(error.to_string()))?;
    credits_allow(&credits)
}

/// The clip without the quiet a speech engine leaves around the words, so
/// "where the speech ends" is where the voice stops, not the file.
fn trim_quiet(clip: &[f32]) -> &[f32] {
    let voiced = |frame: &[f32]| super::vad::frame_db(frame) > QUIET_DB;
    let frames: Vec<&[f32]> = clip.chunks(FRAME_SAMPLES).collect();
    let Some(first) = frames.iter().position(|frame| voiced(frame)) else {
        return &[];
    };
    let last = frames
        .iter()
        .rposition(|frame| voiced(frame))
        .unwrap_or(first);
    let end = ((last + 1) * FRAME_SAMPLES).min(clip.len());
    &clip[first * FRAME_SAMPLES..end]
}

/// The question at 16 kHz in a quiet room. Answers the audio and where the
/// speech ends in it.
fn in_a_room(speech: &[f32]) -> (Vec<f32>, usize) {
    let speech = trim_quiet(speech);
    let room = SAMPLE_RATE as usize * ROOM_MS / 1_000;
    let mut state = 0x2545_f491_u32;
    let mut noise = || {
        // xorshift: the same quiet room every run.
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state as f32 / u32::MAX as f32 * 2.0 - 1.0) * ROOM_NOISE
    };
    let mut audio: Vec<f32> = (0..room).map(|_| noise()).collect();
    audio.extend(speech.iter().map(|sample| sample + noise()));
    let speech_end = audio.len();
    audio.extend((0..room).map(|_| noise()));
    (audio, speech_end)
}

/// What the detector made of the audio: the utterance it handed over for
/// transcription, and how long after `speech_end` it cut.
#[derive(Debug)]
struct Cut {
    utterance: u64,
    samples: Vec<f32>,
    after_speech_ms: u64,
}

fn cut_utterance(engine: &mut Engine, audio: &[f32], speech_end: usize) -> Option<Cut> {
    for (index, frame) in audio.chunks(FRAME_SAMPLES).enumerate() {
        let fed = (index * FRAME_SAMPLES + frame.len()).min(audio.len());
        for effect in engine.push_audio(frame, None) {
            if let Effect::Transcribe { utterance } = effect {
                let samples = engine.take_utterance(utterance)?;
                return Some(Cut {
                    utterance,
                    samples,
                    after_speech_ms: samples_ms(fed.saturating_sub(speech_end)),
                });
            }
        }
    }
    None
}

fn turn_of(effects: &[Effect]) -> Option<(u64, String)> {
    effects.iter().find_map(|effect| match effect {
        Effect::SendTurn { turn, text } => Some((*turn, text.clone())),
        _ => None,
    })
}

/// The first sentence the machine asks to be rendered, if these effects
/// ask for it.
fn first_render(effects: &[Effect]) -> Option<String> {
    effects.iter().find_map(|effect| match effect {
        Effect::Render { index: 0, text, .. } => Some(text.clone()),
        _ => None,
    })
}

/// The reply as the machine receives it: the whole text so far, each time.
#[derive(Default)]
struct ReplyFeed {
    text: String,
    first_token: Option<Instant>,
    first_sentence: Option<(String, Instant)>,
}

impl ReplyFeed {
    fn push(&mut self, engine: &mut Engine, turn: u64, delta: &str, done: bool) {
        self.first_token.get_or_insert_with(Instant::now);
        self.text.push_str(delta);
        let effects = engine.handle(Input::Reply {
            turn,
            text: self.text.clone(),
            done,
        });
        if self.first_sentence.is_none() {
            self.first_sentence = first_render(&effects).map(|text| (text, Instant::now()));
        }
    }
}

async fn stream_reply(
    engine: &mut Engine,
    turn: u64,
    text: &str,
    model: &str,
) -> Result<ReplyFeed, AppError> {
    let mut response = crate::june_api::proxy_agent_chat_completions(serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": text }
        ],
        "max_tokens": CHAT_MAX_TOKENS,
        "stream": true
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        let status = response.status;
        let body = response.collect_body().await.unwrap_or_default();
        return Err(selftest_error(format!(
            "The chat answered {status}: {}",
            String::from_utf8_lossy(&body)
                .chars()
                .take(300)
                .collect::<String>()
        )));
    }
    let mut feed = ReplyFeed::default();
    if response.content_type.contains("event-stream") {
        crate::sse_lines::read_content(&mut response, |delta| {
            feed.push(engine, turn, delta, false);
        })
        .await?;
    } else {
        let body = response.collect_body().await?;
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|error| selftest_error(error.to_string()))?;
        let whole = crate::june_api::extract_chat_completion_text(&value).unwrap_or_default();
        feed.push(engine, turn, &whole, false);
    }
    feed.push(engine, turn, "", true);
    Ok(feed)
}

/// The speech engine and voice for the run: Settings' choice lives in the
/// webview, so the cheapest one-call engine stands in unless the
/// environment names one (`SUBROSA_VOICE_SELFTEST_SPEECH_MODEL`, `_VOICE`).
pub fn speech_voice_from_env() -> SpeechVoice {
    let read = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    SpeechVoice {
        model: read("SUBROSA_VOICE_SELFTEST_SPEECH_MODEL")
            .unwrap_or_else(|| DEFAULT_SPEECH_MODEL.to_string()),
        voice: read("SUBROSA_VOICE_SELFTEST_VOICE"),
        format: "mp3".to_string(),
    }
}

/// Runs the chain once. Needs the local backend up and a key stored.
pub async fn run_chain(voice: &SpeechVoice) -> Result<Report, AppError> {
    let mut report = Report {
        credits_available: available_credits().await?,
        speech_model: voice.model.clone(),
        transcription_model: crate::providers::transcription_model(),
        chat_model: crate::providers::generation_model(),
        question: QUESTION.to_string(),
        ..Report::default()
    };

    let started = Instant::now();
    let (spoken, rate) = requests::render_speech(voice, QUESTION).await?;
    report.question_render_ms = millis(started.elapsed());
    let speech = super::resample::resample(&spoken, rate, SAMPLE_RATE);
    report.question_audio_ms = samples_ms(speech.len());
    let (audio, speech_end) = in_a_room(&speech);

    let mut engine = Engine::new(VadConfig::default(), super::session::fence_label);
    let cut = cut_utterance(&mut engine, &audio, speech_end)
        .ok_or_else(|| selftest_error("The detector heard no utterance in the question."))?;
    report.utterance_ms = samples_ms(cut.samples.len());
    report.detector_cut_after_speech_ms = cut.after_speech_ms;

    let started = Instant::now();
    let transcript = requests::transcribe(SESSION, cut.utterance, cut.samples).await?;
    report.transcription_ms = millis(started.elapsed());
    report.transcript = transcript.clone();
    let (turn, text) = turn_of(&engine.handle(Input::Transcribed {
        utterance: cut.utterance,
        text: transcript,
    }))
    .ok_or_else(|| selftest_error("The transcript did not become a turn."))?;

    let started = Instant::now();
    let feed = stream_reply(&mut engine, turn, &text, &report.chat_model).await?;
    report.chat_done_ms = millis(started.elapsed());
    report.chat_first_token_ms = feed
        .first_token
        .map_or(0, |at| millis(at.duration_since(started)));
    let (first_sentence, first_at) = feed
        .first_sentence
        .ok_or_else(|| selftest_error("The reply never gave a sentence to speak."))?;
    report.chat_first_sentence_ms = millis(first_at.duration_since(started));
    report.reply = feed.text;
    report.first_sentence = first_sentence.clone();

    let started = Instant::now();
    let (audio, rate) = requests::render_speech(voice, &first_sentence).await?;
    report.speech_ms = millis(started.elapsed());
    report.first_sentence_audio_ms = (audio.len() as u64 * 1_000) / u64::from(rate.max(1));
    report.end_of_speech_to_first_sound_ms = report.detector_cut_after_speech_ms
        + report.transcription_ms
        + report.chat_first_sentence_ms
        + report.speech_ms;
    Ok(report)
}

/// In the app: runs once the backend is up, when `SUBROSA_VOICE_SELFTEST=1`.
pub fn spawn_if_requested(app: &AppHandle) {
    if std::env::var(ENV).ok().as_deref() != Some("1") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        while !crate::carpe_diem::local_session::is_active() && started.elapsed() < BACKEND_WAIT {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let outcome = run_chain(&speech_voice_from_env()).await;
        let json = match &outcome {
            Ok(report) => serde_json::to_value(report).unwrap_or_default(),
            Err(error) => serde_json::json!({ "error": error.code, "message": error.message }),
        };
        tracing::info!(report = %json, "voice self-test finished");
        let written = app.path().app_data_dir().map(|dir| dir.join(REPORT_FILE));
        match (written, serde_json::to_vec_pretty(&json)) {
            (Ok(path), Ok(bytes)) => {
                let saved = path
                    .parent()
                    .map(std::fs::create_dir_all)
                    .transpose()
                    .and_then(|_| std::fs::write(&path, bytes));
                if let Err(error) = saved {
                    tracing::warn!(%error, "voice self-test report not written");
                }
            }
            _ => tracing::warn!("voice self-test report not written"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        Engine::new(VadConfig::default(), |_| String::new())
    }

    /// A voiced stand-in: a 220 Hz tone at about -12 dBFS.
    fn tone(ms: usize) -> Vec<f32> {
        let count = SAMPLE_RATE as usize * ms / 1_000;
        (0..count)
            .map(|index| {
                let phase = index as f32 * 220.0 * std::f32::consts::TAU / SAMPLE_RATE as f32;
                0.35 * phase.sin()
            })
            .collect()
    }

    #[test]
    fn the_engines_own_quiet_is_not_counted_as_speech() {
        let mut clip = vec![0.0; 8_000];
        clip.extend(tone(1_000));
        clip.extend(vec![0.0; 8_000]);
        assert_eq!(trim_quiet(&clip).len(), tone(1_000).len());
        assert!(trim_quiet(&[0.0; 4_000]).is_empty());
    }

    #[test]
    fn a_spoken_question_is_cut_once_after_the_hangover() {
        // Half a second of the engine's own silence after the words.
        let mut clip = tone(1_500);
        clip.extend(vec![0.0; 8_000]);
        let (audio, speech_end) = in_a_room(&clip);
        assert_eq!(audio.len(), speech_end + SAMPLE_RATE as usize);
        let mut engine = engine();
        let cut = cut_utterance(&mut engine, &audio, speech_end)
            .unwrap_or_else(|| panic!("no utterance"));
        // The detector waits out its 700 ms of quiet, give or take a frame.
        assert!(
            (680..=760).contains(&cut.after_speech_ms),
            "{}",
            cut.after_speech_ms
        );
        // The tone, its pre-roll and the quiet it waited through.
        let length = samples_ms(cut.samples.len());
        assert!((1_500..=2_600).contains(&length), "{length}");
    }

    #[test]
    fn a_silent_room_gives_no_utterance() {
        let (audio, speech_end) = in_a_room(&[]);
        assert!(cut_utterance(&mut engine(), &audio, speech_end).is_none());
    }

    #[test]
    fn the_first_sentence_is_asked_for_as_soon_as_it_is_whole() {
        let mut engine = engine();
        let (audio, speech_end) = in_a_room(&tone(800));
        let cut = cut_utterance(&mut engine, &audio, speech_end)
            .unwrap_or_else(|| panic!("no utterance"));
        let (turn, text) = turn_of(&engine.handle(Input::Transcribed {
            utterance: cut.utterance,
            text: "What is the capital of France?".into(),
        }))
        .unwrap_or_else(|| panic!("no turn"));
        assert_eq!(text, "What is the capital of France?");
        let mut feed = ReplyFeed::default();
        feed.push(&mut engine, turn, "The capital", false);
        assert!(feed.first_token.is_some());
        assert!(feed.first_sentence.is_none());
        feed.push(&mut engine, turn, " of France is Paris. It", false);
        let (first, _) = feed
            .first_sentence
            .as_ref()
            .unwrap_or_else(|| panic!("no sentence"));
        assert_eq!(first, "The capital of France is Paris.");
        feed.push(&mut engine, turn, " sits on the Seine.", true);
        assert_eq!(
            feed.text,
            "The capital of France is Paris. It sits on the Seine."
        );
    }

    #[test]
    fn nothing_is_spent_below_one_credit() {
        assert_eq!(
            credits_allow(&serde_json::json!({ "availableCredits": 151.6 }))
                .map_err(|error| error.code),
            Ok(151.6)
        );
        assert_eq!(
            credits_allow(&serde_json::json!({ "availableCredits": 0.4 }))
                .map_err(|error| error.code),
            Err("voice_selftest_failed".to_string())
        );
        assert!(credits_allow(&serde_json::json!({ "escrowCredits": 9 })).is_err());
    }

    #[test]
    fn the_speech_engine_defaults_to_the_cheapest_one_call_engine() {
        let voice = speech_voice_from_env();
        if std::env::var("SUBROSA_VOICE_SELFTEST_SPEECH_MODEL").is_err() {
            assert_eq!(voice.model, DEFAULT_SPEECH_MODEL);
        }
        assert_eq!(voice.format, "mp3");
    }

    /// The real chain, once, against the real services. Spends a few
    /// hundredths of a credit. Run on a Mac with:
    ///
    /// ```text
    /// SUBROSA_DEV_API_KEY="$(security find-generic-password -s xyz.carpediem.subrosa.carpe-diem -a api-key -w)" \
    /// SUBROSA_VOICE_SELFTEST_BACKEND="/Applications/Sub Rosa.app/Contents/MacOS/june-api" \
    /// cargo test --manifest-path src-tauri/Cargo.toml --lib voice::selftest -- --ignored --nocapture  # the report goes to stderr
    /// ```
    ///
    /// The backend binary is started the way the sidecar starts it (local
    /// mode, credentials on stdin), from the folder holding its
    /// `config.toml` (`SUBROSA_VOICE_SELFTEST_BACKEND_DIR`, else the app
    /// bundle's Resources, else the binary's own folder).
    #[cfg(desktop)]
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "spends credits on the real services"]
    async fn the_real_chain_answers_a_spoken_question() {
        let backend = backend::start().unwrap_or_else(|error| panic!("{error}"));
        let outcome = run_chain(&speech_voice_from_env()).await;
        drop(backend);
        let report = outcome.unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_default()
        );
        assert!(
            report.transcript.to_lowercase().contains("france"),
            "{}",
            report.transcript
        );
        assert!(!report.first_sentence.is_empty());
        assert!(report.first_sentence_audio_ms > 0);
    }

    #[cfg(desktop)]
    mod backend {
        use crate::carpe_diem::local_session::{self, LocalSession};
        use std::io::Write;
        use std::path::PathBuf;
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};

        pub struct Backend(Child);

        impl Drop for Backend {
            fn drop(&mut self) {
                local_session::clear();
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        fn config_dir(binary: &std::path::Path) -> PathBuf {
            if let Ok(dir) = std::env::var("SUBROSA_VOICE_SELFTEST_BACKEND_DIR") {
                return PathBuf::from(dir);
            }
            let folder = binary
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let resources = folder.join("../Resources");
            if resources.join("config.toml").exists() {
                resources
            } else {
                folder
            }
        }

        /// The sidecar's contract (`carpe_diem::sidecar::apply_june_api_env`
        /// and `stdin_secrets`), without the app.
        pub fn start() -> Result<Backend, String> {
            let binary = PathBuf::from(
                std::env::var("SUBROSA_VOICE_SELFTEST_BACKEND")
                    .map_err(|_| "SUBROSA_VOICE_SELFTEST_BACKEND is not set".to_string())?,
            );
            let (base, key) = crate::carpe_diem::settings::credentials()
                .ok_or_else(|| "no key: set SUBROSA_DEV_API_KEY".to_string())?;
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .and_then(|listener| listener.local_addr())
                .map_err(|error| error.to_string())?
                .port();
            let token = local_session::new_bearer_token();
            let mut child = Command::new(&binary)
                .arg("serve")
                .current_dir(config_dir(&binary))
                .env("JUNE__SERVER__HOST", "127.0.0.1")
                .env("JUNE__SERVER__PORT", port.to_string())
                .env(
                    "JUNE__SERVER__MAX_JSON_BYTES",
                    (16 * 1024 * 1024).to_string(),
                )
                .env("JUNE__LOCAL_DEV__ENABLED", "true")
                .env("JUNE__LOCAL_DEV__USER_ID", "usr_local")
                .env("JUNE__UPSTREAMS__VENICE__BASE_URL", &base)
                .env("JUNE_SECRETS_ON_STDIN", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("{}: {error}", binary.display()))?;
            if let Some(mut stdin) = child.stdin.take() {
                let secrets = format!(
                    "local_dev.bearer_token={token}\nupstreams.venice.api_key={}\n",
                    key.expose_str()
                );
                stdin
                    .write_all(secrets.as_bytes())
                    .map_err(|error| error.to_string())?;
            }
            let backend = Backend(child);
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(30) {
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    local_session::publish(LocalSession {
                        api_url: format!("http://127.0.0.1:{port}"),
                        bearer_token: crate::redacted::Redacted::new(token),
                        user_id: "usr_local".to_string(),
                    });
                    return Ok(backend);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err("the backend did not start listening".to_string())
        }
    }
}
