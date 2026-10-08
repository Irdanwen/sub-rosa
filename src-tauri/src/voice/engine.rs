//! The detector and the state machine joined: 16 kHz audio and session
//! inputs in, effects out. Still pure, so the whole loop (microphone,
//! transcription, chat, speech, speaker) runs in a test with fakes.

use super::machine::{Effect, Input, Machine};
use super::vad::{Vad, VadConfig, VadEvent, FRAME_SAMPLES};
use std::collections::HashMap;

pub struct Engine {
    vad: Vad,
    machine: Machine,
    /// Audio not yet a whole frame.
    partial: Vec<f32>,
    next_utterance: u64,
    utterances: HashMap<u64, Vec<f32>>,
    muted: bool,
}

impl Engine {
    pub fn new(config: VadConfig, fence_label: fn(&str) -> String) -> Self {
        Self {
            vad: Vad::new(config),
            machine: Machine::new(fence_label),
            partial: Vec::new(),
            next_utterance: 0,
            utterances: HashMap::new(),
            muted: false,
        }
    }

    #[cfg(test)]
    pub fn phase(&self) -> super::machine::Phase {
        self.machine.phase()
    }

    /// Microphone audio at 16 kHz, any length. `playback_db` is what the
    /// speaker is playing now (`None` when silent).
    pub fn push_audio(&mut self, samples: &[f32], playback_db: Option<f32>) -> Vec<Effect> {
        if self.muted {
            return Vec::new();
        }
        self.partial.extend_from_slice(samples);
        let mut effects = Vec::new();
        let mut start = 0;
        while self.partial.len() - start >= FRAME_SAMPLES {
            let frame = &self.partial[start..start + FRAME_SAMPLES];
            if let Some(event) = self.vad.push_frame(frame, playback_db) {
                effects.extend(self.on_vad(event));
            }
            start += FRAME_SAMPLES;
        }
        self.partial.drain(..start);
        effects
    }

    fn on_vad(&mut self, event: VadEvent) -> Vec<Effect> {
        match event {
            VadEvent::SpeechStarted => self.machine.handle(Input::SpeechStarted),
            VadEvent::UtteranceDiscarded => self.machine.handle(Input::UtteranceDiscarded),
            VadEvent::UtteranceEnded { samples } => {
                self.next_utterance += 1;
                let utterance = self.next_utterance;
                self.utterances.insert(utterance, samples);
                self.machine.handle(Input::UtteranceEnded { utterance })
            }
        }
    }

    pub fn handle(&mut self, input: Input) -> Vec<Effect> {
        self.machine.handle(input)
    }

    /// The audio of an utterance, handed over once for its transcription.
    pub fn take_utterance(&mut self, utterance: u64) -> Option<Vec<f32>> {
        self.utterances.remove(&utterance)
    }

    /// Muting drops a half-heard utterance: what was said before the tap is
    /// not sent after it.
    pub fn set_muted(&mut self, muted: bool) -> Vec<Effect> {
        if self.muted == muted {
            return Vec::new();
        }
        self.muted = muted;
        if !muted {
            return Vec::new();
        }
        self.partial.clear();
        let was_speaking = self.vad.in_speech();
        self.vad.reset();
        if was_speaking {
            self.machine.handle(Input::UtteranceDiscarded)
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::machine::{Notice, Phase};
    use super::super::vad::tests::tone;
    use super::*;
    use std::collections::VecDeque;

    /// The world around the engine: a microphone script, a transcriber, a
    /// chat that streams its reply in pieces, a speech engine, a speaker.
    /// Every effect is executed the way the session executes it, with the
    /// answers fed back as inputs.
    struct World {
        engine: Engine,
        log: Vec<String>,
        /// Inputs waiting to be delivered (the "network").
        inbox: VecDeque<Input>,
        transcripts: VecDeque<&'static str>,
        replies: VecDeque<&'static str>,
        /// The clip on the speaker: turn, index, frames left.
        speaker: Option<(u64, usize, u32)>,
        sent: Vec<String>,
        cancelled: Vec<u64>,
        phase: f32,
    }

    impl World {
        fn new(config: VadConfig) -> Self {
            Self {
                engine: Engine::new(config, |info| format!("[{info}]")),
                log: Vec::new(),
                inbox: VecDeque::new(),
                transcripts: VecDeque::new(),
                replies: VecDeque::new(),
                speaker: None,
                sent: Vec::new(),
                cancelled: Vec::new(),
                phase: 0.0,
            }
        }

        fn apply(&mut self, effects: Vec<Effect>) {
            for effect in effects {
                match effect {
                    Effect::Transcribe { utterance } => {
                        let audio = self.engine.take_utterance(utterance).unwrap_or_default();
                        assert!(!audio.is_empty(), "utterance {utterance} has audio");
                        let text = self.transcripts.pop_front().unwrap_or("");
                        self.inbox.push_back(Input::Transcribed {
                            utterance,
                            text: text.into(),
                        });
                    }
                    Effect::SendTurn { turn, text } => {
                        self.log.push(format!("send {turn}: {text}"));
                        self.sent.push(text);
                        let reply = self.replies.pop_front().unwrap_or("");
                        // The chat streams its reply in three pieces.
                        let chars: Vec<char> = reply.chars().collect();
                        for cut in [chars.len() / 3, 2 * chars.len() / 3] {
                            self.inbox.push_back(Input::Reply {
                                turn,
                                text: chars[..cut].iter().collect(),
                                done: false,
                            });
                        }
                        self.inbox.push_back(Input::Reply {
                            turn,
                            text: reply.into(),
                            done: true,
                        });
                    }
                    Effect::CancelTurn { turn } => {
                        self.log.push(format!("cancel {turn}"));
                        self.cancelled.push(turn);
                    }
                    Effect::Render { turn, index, .. } => {
                        self.inbox.push_back(Input::Rendered { turn, index });
                    }
                    Effect::Play { turn, index } => {
                        self.log.push(format!("play {turn}.{index}"));
                        // Each sentence plays for 400 ms (20 frames).
                        self.speaker = Some((turn, index, 20));
                    }
                    Effect::StopPlayback => {
                        self.log.push("stop".into());
                        self.speaker = None;
                    }
                    Effect::Phase(phase) => self.log.push(format!("{phase:?}")),
                    Effect::Notice(notice) => self.log.push(format!("notice {notice:?}")),
                    Effect::Heard { .. } | Effect::Saying { .. } => {}
                }
            }
        }

        /// Runs `ms` of microphone audio at `mic_db` (what the person does;
        /// the speaker's own echo is added when it plays), delivering the
        /// network's answers between frames.
        fn run(&mut self, mic_db: f32, ms: u32) {
            for _ in 0..ms / 20 {
                while let Some(input) = self.inbox.pop_front() {
                    let effects = self.engine.handle(input);
                    self.apply(effects);
                }
                let playback = self.speaker.map(|_| -20.0f32);
                // Without echo cancellation the microphone hears the
                // speaker 6 dB down; the person's voice adds on top.
                let heard = match playback {
                    Some(level) => {
                        let echo = 10f32.powf((level - 6.0) / 10.0);
                        let voice = if mic_db > -90.0 {
                            10f32.powf(mic_db / 10.0)
                        } else {
                            0.0
                        };
                        10.0 * (echo + voice).log10()
                    }
                    None => mic_db,
                };
                let frame = tone(heard, &mut self.phase);
                let effects = self.engine.push_audio(&frame, playback);
                self.apply(effects);
                if let Some((turn, index, left)) = self.speaker {
                    if left <= 1 {
                        self.speaker = None;
                        let effects = self.engine.handle(Input::PlaybackFinished { turn, index });
                        self.apply(effects);
                    } else {
                        self.speaker = Some((turn, index, left - 1));
                    }
                }
            }
        }
    }

    const REPLY: &str = "It will be sunny in Geneva tomorrow. Take sunglasses with you. \
                         The evening should stay mild.";

    #[test]
    fn a_spoken_question_gets_a_spoken_answer() {
        let mut world = World::new(VadConfig::default());
        world.transcripts.push_back("What is the weather tomorrow?");
        world.replies.push_back(REPLY);
        world.run(-70.0, 500);
        world.run(-24.0, 1_200);
        world.run(-70.0, 4_000);
        assert_eq!(
            world.log,
            vec![
                "Transcribing",
                "send 1: What is the weather tomorrow?",
                "Thinking",
                "play 1.0",
                "Speaking",
                "play 1.1",
                "play 1.2",
                "Listening",
            ]
        );
        assert_eq!(world.engine.phase(), Phase::Listening);
    }

    #[test]
    fn its_own_echo_does_not_interrupt_it_but_the_person_does() {
        let mut world = World::new(VadConfig::default());
        world.transcripts.push_back("Tell me about Geneva");
        world.transcripts.push_back("Stop, just the weather");
        world.replies.push_back(REPLY);
        world
            .replies
            .push_back("Sunny and mild, with a light breeze tonight.");
        world.run(-70.0, 500);
        world.run(-24.0, 1_000);
        // Long enough for the first sentence to start playing.
        world.run(-70.0, 900);
        assert!(
            world.log.contains(&"play 1.0".to_string()),
            "{:?}",
            world.log
        );
        // The person talks over the reply, louder than its echo.
        world.run(-12.0, 1_000);
        world.run(-70.0, 4_000);
        assert_eq!(world.cancelled, vec![1]);
        let stop = world
            .log
            .iter()
            .position(|line| line == "stop")
            .unwrap_or(0);
        let cancel = world
            .log
            .iter()
            .position(|line| line == "cancel 1")
            .unwrap_or(0);
        assert!(stop > 0 && stop < cancel, "{:?}", world.log);
        assert_eq!(
            world.sent,
            vec!["Tell me about Geneva", "Stop, just the weather"]
        );
        assert!(
            world.log.contains(&"play 2.0".to_string()),
            "{:?}",
            world.log
        );
        assert_eq!(world.engine.phase(), Phase::Listening);
    }

    #[test]
    fn muting_drops_a_half_heard_utterance() {
        let mut world = World::new(VadConfig::default());
        world.run(-70.0, 500);
        world.run(-24.0, 600);
        let effects = world.engine.set_muted(true);
        assert!(effects.is_empty());
        world.run(-24.0, 2_000);
        world.engine.set_muted(false);
        world.run(-70.0, 2_000);
        assert!(world.sent.is_empty());
        assert_eq!(world.engine.phase(), Phase::Listening);
    }

    #[test]
    fn a_mumble_that_transcribes_to_nothing_says_so() {
        let mut world = World::new(VadConfig::default());
        world.transcripts.push_back("");
        world.run(-70.0, 500);
        world.run(-24.0, 800);
        world.run(-70.0, 1_500);
        assert!(world
            .log
            .contains(&format!("notice {:?}", Notice::NothingHeard)));
        assert!(world.sent.is_empty());
    }
}
