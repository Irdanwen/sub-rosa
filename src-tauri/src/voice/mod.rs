//! The voice conversation (ADR-0093): talk to the assistant and hear it
//! answer, hands free, on every shell.
//!
//! A cascade, not a speech-to-speech model: the microphone is cut into
//! utterances by a local detector (`vad.rs`), each utterance is
//! transcribed on the dictation's fast rail, the words go out as an
//! ordinary chat turn, and the reply is read back sentence by sentence as
//! it streams (`sentences.rs`), one sentence rendered ahead of the one
//! playing. Speaking over the reply stops the speaker and the turn
//! (barge-in). The loop is a pure state machine (`machine.rs`, joined to the
//! detector in `engine.rs`) driven by one session thread (`session.rs`) that
//! owns the platform audio (`io.rs`).
//!
//! Distinct from dictation (text into the foreground app, ADR-0041) and from
//! read aloud (one finished reply played on request): see CONTEXT.md.
//!
//! The webview sends the turns, because a turn belongs to the shell's chat:
//! the desktop agent runtime or the phone's agent-lite, with their history,
//! tools, connectors and memory. Protected mode's "Voice off" and quiet
//! hours are refused here, in Rust, when a conversation starts and again
//! for every utterance (ADR-0084).

mod engine;
mod io;
#[cfg(target_os = "android")]
mod io_android;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod io_apple;
pub mod machine;
mod player;
mod requests;
mod resample;
#[cfg(target_os = "macos")]
mod screen;
#[cfg(any(target_os = "macos", windows, test))]
mod screen_frame;
#[cfg(windows)]
mod screen_windows;
#[cfg(debug_assertions)]
pub mod selftest;
mod sentences;
mod session;
mod vad;

use crate::domain::types::AppError;
use machine::{Input, Notice, Phase};
use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

pub use requests::SpeechVoice;

/// Everything the session tells the webview, on one event.
pub const VOICE_EVENT: &str = "voice://event";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptionRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceEvent {
    Phase {
        phase: Phase,
    },
    /// Send these words as a chat turn, and report its reply under `turn`.
    Turn {
        turn: u64,
        text: String,
    },
    /// Stop the chat turn `turn`: the person spoke over it.
    Cancel {
        turn: u64,
    },
    Caption {
        role: CaptionRole,
        text: String,
    },
    Notice {
        notice: Notice,
    },
    /// Microphone and speaker levels, 0 to 1, for the meter.
    Level {
        input: f32,
        output: f32,
    },
    /// The platform's echo cancellation is (no longer) in use.
    EchoCancellation {
        active: bool,
    },
    Error {
        code: String,
        message: String,
    },
    Ended,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceEventPayload<'a> {
    session_id: &'a str,
    #[serde(flatten)]
    event: &'a VoiceEvent,
}

struct Active {
    id: String,
    sender: std::sync::mpsc::Sender<session::Message>,
}

static ACTIVE: LazyLock<Mutex<Option<Active>>> = LazyLock::new(|| Mutex::new(None));

fn send(session_id: &str, message: session::Message) -> Result<(), AppError> {
    let active = ACTIVE.lock().map_err(|_| {
        AppError::new(
            "voice_state_failed",
            "The voice conversation is unavailable.",
        )
    })?;
    match active.as_ref() {
        Some(active) if active.id == session_id => {
            let _ = active.sender.send(message);
            Ok(())
        }
        _ => Err(AppError::new(
            "voice_not_active",
            "The voice conversation has ended.",
        )),
    }
}

fn stop_active() {
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(active) = active.take() {
            let _ = active.sender.send(session::Message::Stop);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartRequest {
    pub speech: SpeechVoice,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartedDto {
    pub session_id: String,
    /// Whether the platform cancels the reply's echo. Without it the screen
    /// suggests headphones.
    pub echo_cancelled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAvailabilityDto {
    /// Whether a conversation may start now.
    pub allowed: bool,
    /// Why not, in the person's language.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Whether this shell can share a picture of the screen.
    pub screen: bool,
}

/// Whether a voice conversation may start, before the person taps it.
#[tauri::command]
pub fn voice_availability() -> VoiceAvailabilityDto {
    let refusal = crate::protected_mode::check_voice().err();
    VoiceAvailabilityDto {
        allowed: refusal.is_none(),
        reason: refusal.map(|error| crate::i18n::translate_known(&error.message)),
        screen: cfg!(any(target_os = "macos", windows)),
    }
}

/// Starts a conversation (ending any other). Opens the microphone and the
/// speaker; on the phone this is where the microphone permission is asked.
#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    request: VoiceStartRequest,
) -> Result<VoiceStartedDto, AppError> {
    crate::protected_mode::check_voice()?;
    stop_active();
    let session_id = uuid::Uuid::new_v4().to_string();
    let emit_id = session_id.clone();
    let emit: session::Emit = Box::new(move |event: VoiceEvent| {
        if event == VoiceEvent::Ended {
            // The thread is gone: forget it unless another took its place.
            if let Ok(mut active) = ACTIVE.lock() {
                if active.as_ref().is_some_and(|active| active.id == emit_id) {
                    *active = None;
                }
            }
        }
        let _ = app.emit(
            VOICE_EVENT,
            VoiceEventPayload {
                session_id: &emit_id,
                event: &event,
            },
        );
    });
    let speech = request.speech;
    let id = session_id.clone();
    // The iOS permission prompt blocks until answered: keep it off the
    // async runtime, like dictation does.
    let started = tokio::task::spawn_blocking(move || session::start(id, speech, emit))
        .await
        .map_err(|error| {
            tracing::error!(%error, "voice start task failed");
            AppError::new(
                "voice_start_failed",
                "The voice conversation could not start. Try again.",
            )
        })??;
    let echo_cancelled = started.echo_cancelled;
    drop(started.thread);
    let mut active = ACTIVE.lock().map_err(|_| {
        AppError::new(
            "voice_state_failed",
            "The voice conversation is unavailable.",
        )
    })?;
    *active = Some(Active {
        id: session_id.clone(),
        sender: started.sender,
    });
    Ok(VoiceStartedDto {
        session_id,
        echo_cancelled,
    })
}

/// Ends the conversation. The turns it sent stay in the chat.
#[tauri::command]
pub fn voice_stop() {
    stop_active();
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceReplyRequest {
    pub session_id: String,
    pub turn: u64,
    /// The reply so far, whole (not a delta).
    pub text: String,
    pub done: bool,
}

/// The webview's view of the reply to `turn`, as it streams.
#[tauri::command]
pub fn voice_reply(request: VoiceReplyRequest) -> Result<(), AppError> {
    send(
        &request.session_id,
        session::Message::Input(Input::Reply {
            turn: request.turn,
            text: request.text,
            done: request.done,
        }),
    )
}

/// The turn could not be sent, or failed before it replied.
#[tauri::command]
pub fn voice_turn_failed(session_id: String, turn: u64) -> Result<(), AppError> {
    send(
        &session_id,
        session::Message::Input(Input::TurnFailed { turn }),
    )
}

#[tauri::command]
pub fn voice_set_muted(session_id: String, muted: bool) -> Result<(), AppError> {
    send(&session_id, session::Message::Mute(muted))
}

/// Stops the reply being spoken, as a voice over it would.
#[tauri::command]
pub fn voice_interrupt(session_id: String) -> Result<(), AppError> {
    send(&session_id, session::Message::Input(Input::Interrupt))
}

/// One picture of the screen for the turn about to be sent (macOS, Windows).
#[tauri::command]
pub async fn voice_screen_frame() -> Result<String, AppError> {
    tokio::task::spawn_blocking(capture_screen_frame)
        .await
        .map_err(|_| {
            AppError::new(
                "voice_screen_failed",
                "The screen could not be captured. Try again.",
            )
        })?
}

#[cfg(target_os = "macos")]
fn capture_screen_frame() -> Result<String, AppError> {
    screen::capture().map(|path| path.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn capture_screen_frame() -> Result<String, AppError> {
    screen_windows::capture().map(|path| path.to_string_lossy().into_owned())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn capture_screen_frame() -> Result<String, AppError> {
    Err(AppError::new(
        "voice_screen_unavailable",
        "Screen sharing in a voice conversation needs the app on your computer.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_reach_the_webview_flat_and_tagged() {
        let payload = |event: &VoiceEvent| {
            serde_json::to_value(VoiceEventPayload {
                session_id: "s1",
                event,
            })
            .unwrap_or_default()
        };
        assert_eq!(
            payload(&VoiceEvent::Turn {
                turn: 3,
                text: "hello".into()
            }),
            serde_json::json!({"sessionId": "s1", "kind": "turn", "turn": 3, "text": "hello"})
        );
        assert_eq!(
            payload(&VoiceEvent::Phase {
                phase: Phase::Speaking
            }),
            serde_json::json!({"sessionId": "s1", "kind": "phase", "phase": "speaking"})
        );
        assert_eq!(
            payload(&VoiceEvent::Notice {
                notice: Notice::NothingHeard
            }),
            serde_json::json!({"sessionId": "s1", "kind": "notice", "notice": "nothingHeard"})
        );
        assert_eq!(
            payload(&VoiceEvent::Caption {
                role: CaptionRole::Assistant,
                text: "Hi.".into()
            }),
            serde_json::json!({"sessionId": "s1", "kind": "caption", "role": "assistant", "text": "Hi."})
        );
        assert_eq!(
            payload(&VoiceEvent::EchoCancellation { active: false }),
            serde_json::json!({"sessionId": "s1", "kind": "echoCancellation", "active": false})
        );
    }

    #[test]
    fn controls_for_an_ended_session_are_refused() {
        assert_eq!(
            voice_interrupt("not-a-session".into()).map_err(|error| error.code),
            Err("voice_not_active".to_string())
        );
    }
}
