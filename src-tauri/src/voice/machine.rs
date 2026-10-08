//! The voice conversation as a state machine: listening, transcribing,
//! thinking, speaking, and back to listening, with the barge-in edges.
//!
//! Pure. Inputs are what happened (the detector heard an onset, a
//! transcription came back, the reply grew, a sentence finished playing);
//! effects are what the session must do about it (transcribe this
//! utterance, send this turn, render this sentence, stop the speaker). The
//! session in `session.rs` executes the effects with real audio and real
//! requests; the tests execute them with fakes.
//!
//! Three rules carry the design:
//!
//! - **A turn is a number.** Every user turn gets the next one, and every
//!   reply, rendered sentence and finished playback names the turn it
//!   belongs to. A barge-in forgets the turn, so whatever is still in flight
//!   for it (a sentence rendering, the rest of the reply streaming in)
//!   arrives for a turn nobody waits for and is dropped.
//! - **One sentence ahead.** A sentence is rendered while the one before it
//!   plays, never more: what the person interrupts was not paid for.
//! - **The person's words are kept together.** Someone who pauses, then
//!   carries on while the first part is being transcribed, sends one turn
//!   with both parts, not two turns.

use super::sentences::{next_sentences, SentenceCursor, Spoken};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Listening,
    Transcribing,
    Thinking,
    Speaking,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// The detector heard the start of speech.
    SpeechStarted,
    /// The detector cut an utterance; its audio waits under this id.
    UtteranceEnded {
        utterance: u64,
    },
    /// What started as speech was not.
    UtteranceDiscarded,
    Transcribed {
        utterance: u64,
        text: String,
    },
    TranscriptionFailed {
        utterance: u64,
    },
    /// The reply to `turn` so far (the whole text, not a delta).
    Reply {
        turn: u64,
        text: String,
        done: bool,
    },
    /// The turn could not be sent or failed before replying.
    TurnFailed {
        turn: u64,
    },
    Rendered {
        turn: u64,
        index: usize,
    },
    RenderFailed {
        turn: u64,
        index: usize,
    },
    PlaybackFinished {
        turn: u64,
        index: usize,
    },
    /// The person asked the reply to stop (a tap, not their voice).
    Interrupt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Notice {
    /// An utterance came back with no words in it.
    NothingHeard,
    TranscriptionFailed,
    /// A sentence could not be rendered and was skipped.
    SpeechFailed,
    TurnFailed,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Transcribe {
        utterance: u64,
    },
    /// Send the person's words as a chat turn.
    SendTurn {
        turn: u64,
        text: String,
    },
    /// Stop the chat turn (the reply keeps what it had written).
    CancelTurn {
        turn: u64,
    },
    Render {
        turn: u64,
        index: usize,
        text: String,
    },
    Play {
        turn: u64,
        index: usize,
    },
    StopPlayback,
    Phase(Phase),
    /// What the person said, for the captions.
    Heard {
        text: String,
    },
    /// The sentence being spoken, for the captions.
    Saying {
        text: String,
    },
    Notice(Notice),
}

#[derive(Debug, Default)]
struct Reply {
    cursor: SentenceCursor,
    sentences: Vec<String>,
    done: bool,
    next_render: usize,
    next_play: usize,
    playing: Option<usize>,
    ready: BTreeSet<usize>,
    skipped: BTreeSet<usize>,
}

#[derive(Debug)]
pub struct Machine {
    phase: Phase,
    /// The last turn number handed out.
    turn: u64,
    /// The turn whose reply is awaited or spoken, if any.
    awaiting: Option<u64>,
    reply: Reply,
    /// Utterances being transcribed.
    pending: BTreeSet<u64>,
    user_speaking: bool,
    /// Transcripts collected for the next turn.
    heard: Vec<String>,
    /// How a skipped fenced block is said, in the person's language.
    fence_label: fn(&str) -> String,
}

impl Machine {
    pub fn new(fence_label: fn(&str) -> String) -> Self {
        Self {
            phase: Phase::Listening,
            turn: 0,
            awaiting: None,
            reply: Reply::default(),
            pending: BTreeSet::new(),
            user_speaking: false,
            heard: Vec::new(),
            fence_label,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// The turn a reply is awaited for.
    pub fn awaiting(&self) -> Option<u64> {
        self.awaiting
    }

    pub fn handle(&mut self, input: Input) -> Vec<Effect> {
        let mut effects = Vec::new();
        match input {
            Input::SpeechStarted => {
                self.user_speaking = true;
                match self.phase {
                    Phase::Thinking | Phase::Speaking => self.barge_in(&mut effects),
                    Phase::Transcribing => self.set_phase(Phase::Listening, &mut effects),
                    Phase::Listening => {}
                }
            }
            Input::UtteranceEnded { utterance } => {
                self.user_speaking = false;
                self.pending.insert(utterance);
                effects.push(Effect::Transcribe { utterance });
                if self.awaiting.is_none() {
                    self.set_phase(Phase::Transcribing, &mut effects);
                }
            }
            Input::UtteranceDiscarded => {
                self.user_speaking = false;
                self.maybe_send(&mut effects);
            }
            Input::Transcribed { utterance, text } => {
                if !self.pending.remove(&utterance) {
                    return effects;
                }
                let text = text.trim();
                if text.is_empty() {
                    if self.pending.is_empty() && self.heard.is_empty() && !self.user_speaking {
                        effects.push(Effect::Notice(Notice::NothingHeard));
                    }
                } else {
                    self.heard.push(text.to_string());
                    effects.push(Effect::Heard {
                        text: self.heard.join(" "),
                    });
                }
                self.maybe_send(&mut effects);
            }
            Input::TranscriptionFailed { utterance } => {
                if !self.pending.remove(&utterance) {
                    return effects;
                }
                effects.push(Effect::Notice(Notice::TranscriptionFailed));
                self.maybe_send(&mut effects);
            }
            Input::Reply { turn, text, done } => {
                if self.awaiting != Some(turn) {
                    return effects;
                }
                for unit in next_sentences(&text, &mut self.reply.cursor, done) {
                    let sentence = match unit {
                        Spoken::Text(text) => text,
                        Spoken::Fence(info) => (self.fence_label)(&info),
                    };
                    if !sentence.trim().is_empty() {
                        self.reply.sentences.push(sentence);
                    }
                }
                self.reply.done |= done;
                self.advance(&mut effects);
            }
            Input::TurnFailed { turn } => {
                if self.awaiting != Some(turn) {
                    return effects;
                }
                if self.reply.playing.is_some() {
                    effects.push(Effect::StopPlayback);
                }
                self.awaiting = None;
                self.reply = Reply::default();
                effects.push(Effect::Notice(Notice::TurnFailed));
                self.settle(&mut effects);
            }
            Input::Rendered { turn, index } => {
                if self.awaiting != Some(turn) {
                    return effects;
                }
                self.reply.ready.insert(index);
                self.advance(&mut effects);
            }
            Input::RenderFailed { turn, index } => {
                if self.awaiting != Some(turn) {
                    return effects;
                }
                self.reply.skipped.insert(index);
                effects.push(Effect::Notice(Notice::SpeechFailed));
                self.advance(&mut effects);
            }
            Input::PlaybackFinished { turn, index } => {
                if self.awaiting != Some(turn) || self.reply.playing != Some(index) {
                    return effects;
                }
                self.reply.playing = None;
                self.reply.next_play += 1;
                self.advance(&mut effects);
            }
            Input::Interrupt => {
                if matches!(self.phase, Phase::Thinking | Phase::Speaking) {
                    self.barge_in(&mut effects);
                }
            }
        }
        effects
    }

    /// The person spoke over the reply, or tapped to stop it: silence the
    /// speaker first (that is what they hear), then stop the turn.
    fn barge_in(&mut self, effects: &mut Vec<Effect>) {
        if self.reply.playing.is_some() || self.phase == Phase::Speaking {
            effects.push(Effect::StopPlayback);
        }
        if let Some(turn) = self.awaiting.take() {
            effects.push(Effect::CancelTurn { turn });
        }
        self.reply = Reply::default();
        self.set_phase(Phase::Listening, effects);
    }

    /// Sends the words heard once nothing more is coming: no transcription
    /// in flight, nobody talking.
    fn maybe_send(&mut self, effects: &mut Vec<Effect>) {
        if !self.pending.is_empty() || self.user_speaking || self.awaiting.is_some() {
            return;
        }
        if self.heard.is_empty() {
            self.settle(effects);
            return;
        }
        self.turn += 1;
        let turn = self.turn;
        self.awaiting = Some(turn);
        self.reply = Reply::default();
        let text = std::mem::take(&mut self.heard).join(" ");
        effects.push(Effect::SendTurn { turn, text });
        self.set_phase(Phase::Thinking, effects);
    }

    /// Renders what the window allows, plays what is ready, and closes the
    /// turn once everything it said has been played.
    fn advance(&mut self, effects: &mut Vec<Effect>) {
        let Some(turn) = self.awaiting else {
            return;
        };
        let reply = &mut self.reply;
        if reply.playing.is_none() {
            while reply.skipped.contains(&reply.next_play) {
                reply.next_play += 1;
            }
        }
        // The sentence playing (or next to play) and one ahead of it.
        while reply.next_render < reply.sentences.len() && reply.next_render < reply.next_play + 2 {
            let index = reply.next_render;
            effects.push(Effect::Render {
                turn,
                index,
                text: reply.sentences[index].clone(),
            });
            reply.next_render += 1;
        }
        if reply.playing.is_none() && reply.ready.remove(&reply.next_play) {
            let index = reply.next_play;
            reply.playing = Some(index);
            effects.push(Effect::Play { turn, index });
            effects.push(Effect::Saying {
                text: reply.sentences[index].clone(),
            });
            self.set_phase(Phase::Speaking, effects);
            return;
        }
        let finished = self.reply.done
            && self.reply.playing.is_none()
            && self.reply.next_play >= self.reply.sentences.len();
        if finished {
            self.awaiting = None;
            self.reply = Reply::default();
            self.settle(effects);
        }
    }

    /// Where the conversation rests when no turn is in flight.
    fn settle(&mut self, effects: &mut Vec<Effect>) {
        let phase = if !self.pending.is_empty() && !self.user_speaking {
            Phase::Transcribing
        } else {
            Phase::Listening
        };
        self.set_phase(phase, effects);
    }

    fn set_phase(&mut self, phase: Phase, effects: &mut Vec<Effect>) {
        if self.phase != phase {
            self.phase = phase;
            effects.push(Effect::Phase(phase));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(info: &str) -> String {
        format!("[{info}]")
    }

    fn machine() -> Machine {
        Machine::new(label)
    }

    fn renders(effects: &[Effect]) -> Vec<usize> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Render { index, .. } => Some(*index),
                _ => None,
            })
            .collect()
    }

    /// Speaks, is transcribed as `text`, and returns the turn sent.
    fn say(machine: &mut Machine, utterance: u64, text: &str) -> u64 {
        machine.handle(Input::SpeechStarted);
        machine.handle(Input::UtteranceEnded { utterance });
        let effects = machine.handle(Input::Transcribed {
            utterance,
            text: text.into(),
        });
        effects
            .iter()
            .find_map(|effect| match effect {
                Effect::SendTurn { turn, .. } => Some(*turn),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no turn sent: {effects:?}"))
    }

    const TWO: &str = "The first sentence is right here. The second one follows it now.";

    #[test]
    fn a_full_turn_goes_round_the_loop() {
        let mut m = machine();
        assert_eq!(m.phase(), Phase::Listening);
        assert!(m.handle(Input::SpeechStarted).is_empty());
        assert_eq!(
            m.handle(Input::UtteranceEnded { utterance: 1 }),
            vec![
                Effect::Transcribe { utterance: 1 },
                Effect::Phase(Phase::Transcribing)
            ]
        );
        assert_eq!(
            m.handle(Input::Transcribed {
                utterance: 1,
                text: " What is the weather? ".into()
            }),
            vec![
                Effect::Heard {
                    text: "What is the weather?".into()
                },
                Effect::SendTurn {
                    turn: 1,
                    text: "What is the weather?".into()
                },
                Effect::Phase(Phase::Thinking)
            ]
        );
        let effects = m.handle(Input::Reply {
            turn: 1,
            text: TWO.into(),
            done: true,
        });
        assert_eq!(renders(&effects), vec![0, 1]);
        let effects = m.handle(Input::Rendered { turn: 1, index: 0 });
        assert!(effects.contains(&Effect::Play { turn: 1, index: 0 }));
        assert!(effects.contains(&Effect::Phase(Phase::Speaking)));
        m.handle(Input::Rendered { turn: 1, index: 1 });
        let effects = m.handle(Input::PlaybackFinished { turn: 1, index: 0 });
        assert!(effects.contains(&Effect::Play { turn: 1, index: 1 }));
        let effects = m.handle(Input::PlaybackFinished { turn: 1, index: 1 });
        assert_eq!(effects, vec![Effect::Phase(Phase::Listening)]);
        assert_eq!(m.awaiting(), None);
    }

    #[test]
    fn rendering_stays_one_sentence_ahead_of_playback() {
        let mut m = machine();
        let turn = say(&mut m, 1, "Read me a story");
        let story = "Once upon a time there was a fox. It lived in a deep dark wood. \
                     Every night it went looking for food. One night it found a farm. ";
        let effects = m.handle(Input::Reply {
            turn,
            text: story.into(),
            done: false,
        });
        assert_eq!(renders(&effects), vec![0, 1]);
        assert!(renders(&m.handle(Input::Rendered { turn, index: 1 })).is_empty());
        // Sentence 0 renders last but still plays first.
        let effects = m.handle(Input::Rendered { turn, index: 0 });
        assert!(effects.contains(&Effect::Play { turn, index: 0 }));
        let effects = m.handle(Input::PlaybackFinished { turn, index: 0 });
        assert_eq!(renders(&effects), vec![2]);
        assert!(effects.contains(&Effect::Play { turn, index: 1 }));
    }

    #[test]
    fn speaking_over_the_reply_stops_it_and_the_turn() {
        let mut m = machine();
        let turn = say(&mut m, 1, "Tell me everything");
        m.handle(Input::Reply {
            turn,
            text: TWO.into(),
            done: false,
        });
        m.handle(Input::Rendered { turn, index: 0 });
        assert_eq!(m.phase(), Phase::Speaking);
        assert_eq!(
            m.handle(Input::SpeechStarted),
            vec![
                Effect::StopPlayback,
                Effect::CancelTurn { turn },
                Effect::Phase(Phase::Listening)
            ]
        );
        // Whatever was in flight for the old turn is dropped.
        assert!(m.handle(Input::Rendered { turn, index: 1 }).is_empty());
        assert!(m
            .handle(Input::PlaybackFinished { turn, index: 0 })
            .is_empty());
        assert!(m
            .handle(Input::Reply {
                turn,
                text: format!("{TWO} And more words come in later."),
                done: true
            })
            .is_empty());
        // The new words make the next turn.
        let effects = m.handle(Input::UtteranceEnded { utterance: 2 });
        assert!(effects.contains(&Effect::Transcribe { utterance: 2 }));
        let effects = m.handle(Input::Transcribed {
            utterance: 2,
            text: "Actually, just the summary".into(),
        });
        assert!(effects.contains(&Effect::SendTurn {
            turn: turn + 1,
            text: "Actually, just the summary".into()
        }));
    }

    #[test]
    fn speaking_while_it_thinks_cancels_the_turn_without_touching_the_speaker() {
        let mut m = machine();
        let turn = say(&mut m, 1, "Search the web for flights");
        assert_eq!(m.phase(), Phase::Thinking);
        assert_eq!(
            m.handle(Input::SpeechStarted),
            vec![Effect::CancelTurn { turn }, Effect::Phase(Phase::Listening)]
        );
    }

    #[test]
    fn a_tap_interrupts_like_a_voice() {
        let mut m = machine();
        assert!(m.handle(Input::Interrupt).is_empty());
        let turn = say(&mut m, 1, "Hello there");
        m.handle(Input::Reply {
            turn,
            text: TWO.into(),
            done: true,
        });
        m.handle(Input::Rendered { turn, index: 0 });
        let effects = m.handle(Input::Interrupt);
        assert_eq!(effects[0], Effect::StopPlayback);
        assert!(effects.contains(&Effect::CancelTurn { turn }));
        assert_eq!(m.phase(), Phase::Listening);
    }

    #[test]
    fn talking_on_during_a_transcription_makes_one_turn() {
        let mut m = machine();
        m.handle(Input::SpeechStarted);
        m.handle(Input::UtteranceEnded { utterance: 1 });
        // They carry on while the first part is transcribed.
        let effects = m.handle(Input::SpeechStarted);
        assert_eq!(effects, vec![Effect::Phase(Phase::Listening)]);
        let effects = m.handle(Input::Transcribed {
            utterance: 1,
            text: "Book a table".into(),
        });
        assert!(!effects
            .iter()
            .any(|effect| matches!(effect, Effect::SendTurn { .. })));
        m.handle(Input::UtteranceEnded { utterance: 2 });
        let effects = m.handle(Input::Transcribed {
            utterance: 2,
            text: "for two at eight".into(),
        });
        assert!(effects.contains(&Effect::SendTurn {
            turn: 1,
            text: "Book a table for two at eight".into()
        }));
    }

    #[test]
    fn silence_and_failures_return_to_listening() {
        let mut m = machine();
        m.handle(Input::SpeechStarted);
        m.handle(Input::UtteranceEnded { utterance: 1 });
        assert_eq!(
            m.handle(Input::Transcribed {
                utterance: 1,
                text: "  ".into()
            }),
            vec![
                Effect::Notice(Notice::NothingHeard),
                Effect::Phase(Phase::Listening)
            ]
        );
        m.handle(Input::SpeechStarted);
        m.handle(Input::UtteranceEnded { utterance: 2 });
        assert_eq!(
            m.handle(Input::TranscriptionFailed { utterance: 2 }),
            vec![
                Effect::Notice(Notice::TranscriptionFailed),
                Effect::Phase(Phase::Listening)
            ]
        );
        // A stale transcription is ignored.
        assert!(m
            .handle(Input::Transcribed {
                utterance: 2,
                text: "late".into()
            })
            .is_empty());
        m.handle(Input::SpeechStarted);
        assert!(m.handle(Input::UtteranceDiscarded).is_empty());
    }

    #[test]
    fn a_failed_sentence_is_skipped_and_a_failed_turn_ends_it() {
        let mut m = machine();
        let turn = say(&mut m, 1, "Two things please");
        m.handle(Input::Reply {
            turn,
            text: TWO.into(),
            done: true,
        });
        let effects = m.handle(Input::RenderFailed { turn, index: 0 });
        assert!(effects.contains(&Effect::Notice(Notice::SpeechFailed)));
        let effects = m.handle(Input::Rendered { turn, index: 1 });
        assert!(effects.contains(&Effect::Play { turn, index: 1 }));
        let effects = m.handle(Input::PlaybackFinished { turn, index: 1 });
        assert_eq!(effects, vec![Effect::Phase(Phase::Listening)]);

        let turn = say(&mut m, 2, "Again");
        let effects = m.handle(Input::TurnFailed { turn });
        assert_eq!(
            effects,
            vec![
                Effect::Notice(Notice::TurnFailed),
                Effect::Phase(Phase::Listening)
            ]
        );
    }

    #[test]
    fn an_empty_reply_ends_the_turn_and_a_card_is_named() {
        let mut m = machine();
        let turn = say(&mut m, 1, "Nothing to say");
        assert_eq!(
            m.handle(Input::Reply {
                turn,
                text: String::new(),
                done: true
            }),
            vec![Effect::Phase(Phase::Listening)]
        );
        let turn = say(&mut m, 2, "Where should we eat");
        let effects = m.handle(Input::Reply {
            turn,
            text: "Here are three places near you:\n```subrosa:places\n{}\n```\n".into(),
            done: true,
        });
        let texts: Vec<String> = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Render { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec!["Here are three places near you:", "[subrosa:places]"]
        );
    }
}
