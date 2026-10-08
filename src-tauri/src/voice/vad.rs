//! When the person starts and stops talking, from the microphone alone.
//!
//! An energy detector, like the turn detection of a recorded note
//! (`audio::turns`) and the live preview's silence floor, but online: it
//! sees one 20 ms frame at a time and has to decide now. Three things make
//! it usable for a conversation rather than a recording:
//!
//! - **An adaptive floor.** The threshold sits a margin above the room's
//!   own noise: the quietest frame of the last few seconds (speech has gaps
//!   between syllables, a fan does not), with an absolute minimum so a
//!   silent studio does not turn breathing into speech.
//! - **Hysteresis and a hangover.** Speech starts after a short run of
//!   loud frames and ends after `end_silence_ms` below a lower threshold,
//!   so a pause between two clauses does not cut the sentence in half.
//! - **An echo-aware threshold.** While the app is speaking, the microphone
//!   hears the app. The threshold then rises to the expected echo (the
//!   playback level plus the path's coupling) plus a margin, and the onset
//!   needs a longer run: barging in takes a real voice, not the reply's own
//!   sound. The coupling is small where the platform cancels echo (voice
//!   processing on iOS, the communication input on Android) and large where
//!   it does not (a laptop's speakers next to its microphone).
//!
//! Pure: frames in, events out, no clock and no device, so every case is a
//! unit test over synthetic audio.

use std::collections::VecDeque;

/// The rate the detector, and the utterances it cuts, run at. It is also
/// what the transcription rail wants.
pub const SAMPLE_RATE: u32 = 16_000;
/// One analysis frame: 20 ms.
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize) / 50;
const FRAME_MS: u32 = 20;
/// The window the noise floor is the minimum of: 5 s.
const FLOOR_WINDOW_FRAMES: usize = 250;
/// Before this much history the floor is assumed, not measured.
const FLOOR_MIN_HISTORY: usize = 10;
const ASSUMED_FLOOR_DB: f32 = -60.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VadConfig {
    /// Nothing quieter than this is speech, whatever the room.
    pub min_speech_db: f32,
    /// How far above the noise floor speech must be.
    pub above_floor_db: f32,
    /// How much lower the threshold is once speech has started.
    pub hysteresis_db: f32,
    /// Loud time needed to start speech.
    pub onset_ms: u32,
    /// Loud time needed to start speech while the app is speaking.
    pub barge_in_onset_ms: u32,
    /// Quiet time that ends an utterance.
    pub end_silence_ms: u32,
    /// An utterance with less voiced time than this was a click or a cough.
    pub min_voiced_ms: u32,
    /// An utterance is cut here even if the person keeps talking.
    pub max_utterance_ms: u32,
    /// Audio kept from before the onset, so the first syllable is not lost.
    pub pre_roll_ms: u32,
    /// Playback level minus what the microphone hears of it. Close to zero
    /// without echo cancellation, far below with it.
    pub echo_coupling_db: f32,
    /// How far above the expected echo a voice must be to barge in.
    pub echo_margin_db: f32,
}

impl VadConfig {
    /// The defaults where the platform cancels the reply's echo.
    pub fn with_echo_cancellation() -> Self {
        Self {
            echo_coupling_db: -24.0,
            ..Self::default()
        }
    }
}

impl Default for VadConfig {
    /// Without echo cancellation (laptop speakers, Windows): barging in
    /// over the reply takes a voice nearly as loud as the reply itself.
    fn default() -> Self {
        Self {
            min_speech_db: -48.0,
            above_floor_db: 10.0,
            hysteresis_db: 4.0,
            onset_ms: 160,
            barge_in_onset_ms: 300,
            end_silence_ms: 700,
            min_voiced_ms: 300,
            max_utterance_ms: 30_000,
            pre_roll_ms: 300,
            echo_coupling_db: -6.0,
            echo_margin_db: 8.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum VadEvent {
    /// The person started talking (the onset run is complete).
    SpeechStarted,
    /// They stopped: the utterance at [`SAMPLE_RATE`], pre-roll included.
    UtteranceEnded { samples: Vec<f32> },
    /// What started as speech was too short to be any.
    UtteranceDiscarded,
}

#[derive(Debug)]
pub struct Vad {
    config: VadConfig,
    levels: VecDeque<f32>,
    onset_run: u32,
    pre_roll: VecDeque<f32>,
    speech: Option<Speech>,
}

#[derive(Debug)]
struct Speech {
    samples: Vec<f32>,
    voiced_frames: u32,
    silent_run: u32,
    frames: u32,
}

/// Root mean square of a frame, in dBFS (silence reads as -100).
pub fn frame_db(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return -100.0;
    }
    let power = frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32;
    if power <= 1.0e-10 {
        -100.0
    } else {
        10.0 * power.log10()
    }
}

impl Vad {
    pub fn new(config: VadConfig) -> Self {
        Self {
            config,
            levels: VecDeque::new(),
            onset_run: 0,
            pre_roll: VecDeque::new(),
            speech: None,
        }
    }

    /// Whether an utterance is in progress.
    pub fn in_speech(&self) -> bool {
        self.speech.is_some()
    }

    /// The level speech must reach now. `playback_db` is the level the app
    /// is playing at (`None` while it is silent).
    pub fn threshold_db(&self, playback_db: Option<f32>) -> f32 {
        let base = (self.floor_db() + self.config.above_floor_db).max(self.config.min_speech_db);
        match playback_db {
            Some(playback) => {
                base.max(playback + self.config.echo_coupling_db + self.config.echo_margin_db)
            }
            None => base,
        }
    }

    /// Forgets a half-heard utterance (the person muted, or the session
    /// changed what it listens for).
    pub fn reset(&mut self) {
        self.onset_run = 0;
        self.speech = None;
        self.pre_roll.clear();
    }

    /// One frame of [`FRAME_SAMPLES`] samples (shorter frames are accepted
    /// and weighed as frames all the same).
    pub fn push_frame(&mut self, frame: &[f32], playback_db: Option<f32>) -> Option<VadEvent> {
        let level = frame_db(frame);
        let threshold = self.threshold_db(playback_db);
        // The floor learns from every frame but the app's own voice.
        if playback_db.is_none() {
            self.levels.push_back(level);
            while self.levels.len() > FLOOR_WINDOW_FRAMES {
                self.levels.pop_front();
            }
        }
        match self.speech.as_mut() {
            None => {
                let voiced = level >= threshold;
                if voiced {
                    self.onset_run += 1;
                } else {
                    self.onset_run = self.onset_run.saturating_sub(2);
                }
                self.pre_roll.extend(frame.iter().copied());
                let keep = (self.config.pre_roll_ms * SAMPLE_RATE / 1000) as usize;
                while self.pre_roll.len() > keep {
                    self.pre_roll.pop_front();
                }
                let onset_ms = if playback_db.is_some() {
                    self.config.barge_in_onset_ms
                } else {
                    self.config.onset_ms
                };
                if self.onset_run * FRAME_MS >= onset_ms {
                    self.onset_run = 0;
                    let samples: Vec<f32> = self.pre_roll.drain(..).collect();
                    let frames = (samples.len() / FRAME_SAMPLES.max(1)) as u32;
                    self.speech = Some(Speech {
                        samples,
                        voiced_frames: onset_ms / FRAME_MS,
                        silent_run: 0,
                        frames,
                    });
                    return Some(VadEvent::SpeechStarted);
                }
                None
            }
            Some(speech) => {
                speech.samples.extend_from_slice(frame);
                speech.frames += 1;
                if level >= threshold - self.config.hysteresis_db {
                    speech.voiced_frames += 1;
                    speech.silent_run = 0;
                } else {
                    speech.silent_run += 1;
                }
                let ended = speech.silent_run * FRAME_MS >= self.config.end_silence_ms;
                let too_long = speech.frames * FRAME_MS >= self.config.max_utterance_ms;
                if !ended && !too_long {
                    return None;
                }
                let speech = self.speech.take()?;
                if speech.voiced_frames * FRAME_MS < self.config.min_voiced_ms {
                    return Some(VadEvent::UtteranceDiscarded);
                }
                let mut samples = speech.samples;
                if ended {
                    // Keep a short tail of the silence, drop the rest: the
                    // transcription pays for every second it is sent.
                    let tail = (speech.silent_run.saturating_sub(10) as usize) * FRAME_SAMPLES;
                    samples.truncate(samples.len().saturating_sub(tail));
                }
                Some(VadEvent::UtteranceEnded { samples })
            }
        }
    }

    /// The room's noise: the quietest recent frame.
    fn floor_db(&self) -> f32 {
        if self.levels.len() < FLOOR_MIN_HISTORY {
            return ASSUMED_FLOOR_DB;
        }
        self.levels
            .iter()
            .copied()
            .fold(f32::INFINITY, f32::min)
            .max(-90.0)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A 20 ms frame of a tone at `db` dBFS (RMS), or silence below -90.
    pub(crate) fn tone(db: f32, phase: &mut f32) -> Vec<f32> {
        if db <= -90.0 {
            return vec![0.0; FRAME_SAMPLES];
        }
        // RMS of a sine is amplitude / sqrt(2).
        let amplitude = 10f32.powf(db / 20.0) * std::f32::consts::SQRT_2;
        (0..FRAME_SAMPLES)
            .map(|_| {
                *phase += 2.0 * std::f32::consts::PI * 220.0 / SAMPLE_RATE as f32;
                amplitude * phase.sin()
            })
            .collect()
    }

    fn run(vad: &mut Vad, db: f32, ms: u32, playback: Option<f32>) -> Vec<VadEvent> {
        let mut phase = 0.0;
        (0..ms / FRAME_MS)
            .filter_map(|_| vad.push_frame(&tone(db, &mut phase), playback))
            .collect()
    }

    #[test]
    fn frame_db_measures_rms() {
        let mut phase = 0.0;
        assert!((frame_db(&tone(-20.0, &mut phase)) + 20.0).abs() < 0.5);
        assert_eq!(frame_db(&[0.0; 10]), -100.0);
        assert_eq!(frame_db(&[]), -100.0);
    }

    #[test]
    fn an_utterance_starts_ends_and_keeps_its_first_syllable() {
        let mut vad = Vad::new(VadConfig::default());
        assert!(run(&mut vad, -70.0, 1_000, None).is_empty());
        let started = run(&mut vad, -25.0, 1_200, None);
        assert_eq!(started, vec![VadEvent::SpeechStarted]);
        assert!(vad.in_speech());
        let ended = run(&mut vad, -70.0, 1_000, None);
        let [VadEvent::UtteranceEnded { samples }] = ended.as_slice() else {
            panic!("expected one utterance, got {ended:?}");
        };
        let seconds = samples.len() as f32 / SAMPLE_RATE as f32;
        // 1.2 s of voice, the 300 ms pre-roll, and a short silent tail.
        assert!((1.4..1.9).contains(&seconds), "{seconds}");
        assert!(!vad.in_speech());
    }

    #[test]
    fn a_pause_shorter_than_the_hangover_does_not_cut_the_sentence() {
        let mut vad = Vad::new(VadConfig::default());
        run(&mut vad, -70.0, 500, None);
        let mut events = run(&mut vad, -25.0, 800, None);
        events.extend(run(&mut vad, -70.0, 400, None));
        events.extend(run(&mut vad, -25.0, 800, None));
        events.extend(run(&mut vad, -70.0, 900, None));
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0], VadEvent::SpeechStarted);
        assert!(matches!(events[1], VadEvent::UtteranceEnded { .. }));
    }

    #[test]
    fn a_click_is_not_speech_and_a_cough_is_discarded() {
        let mut vad = Vad::new(VadConfig::default());
        run(&mut vad, -70.0, 500, None);
        // 60 ms: shorter than the onset.
        assert!(run(&mut vad, -20.0, 60, None).is_empty());
        assert!(run(&mut vad, -70.0, 500, None).is_empty());
        // 200 ms: an onset, but not enough voiced time to be words.
        let mut events = run(&mut vad, -20.0, 200, None);
        events.extend(run(&mut vad, -70.0, 900, None));
        assert_eq!(
            events,
            vec![VadEvent::SpeechStarted, VadEvent::UtteranceDiscarded]
        );
    }

    #[test]
    fn a_steady_noise_is_learned_as_the_floor() {
        let mut vad = Vad::new(VadConfig::default());
        // A fan at -42 dBFS: louder than the absolute minimum, so in the
        // first instant it reads as speech...
        let first = run(&mut vad, -42.0, 400, None);
        assert_eq!(first.first(), Some(&VadEvent::SpeechStarted));
        // ...until the floor learns it, and the "utterance" is discarded.
        let after = run(&mut vad, -42.0, 2_000, None);
        assert_eq!(after, vec![VadEvent::UtteranceDiscarded]);
        assert!(vad.threshold_db(None) > -42.0);
        assert!(run(&mut vad, -42.0, 2_000, None).is_empty());
        // A voice well above the fan still starts.
        assert_eq!(
            run(&mut vad, -20.0, 400, None),
            vec![VadEvent::SpeechStarted]
        );
    }

    #[test]
    fn the_reply_echo_does_not_barge_in_but_a_voice_over_it_does() {
        let mut vad = Vad::new(VadConfig::default());
        run(&mut vad, -70.0, 500, None);
        // The app plays at -20 dBFS; the microphone hears it at -26.
        assert!(run(&mut vad, -26.0, 2_000, Some(-20.0)).is_empty());
        // Someone talks louder than the echo, for long enough.
        assert_eq!(
            run(&mut vad, -14.0, 400, Some(-20.0)),
            vec![VadEvent::SpeechStarted]
        );
    }

    #[test]
    fn echo_cancellation_lets_a_normal_voice_barge_in() {
        let mut vad = Vad::new(VadConfig::with_echo_cancellation());
        run(&mut vad, -70.0, 500, None);
        // Cancelled echo leaks at -50; the same -30 voice that would not
        // beat raw speakers beats it.
        assert!(run(&mut vad, -50.0, 1_000, Some(-20.0)).is_empty());
        assert_eq!(
            run(&mut vad, -30.0, 400, Some(-20.0)),
            vec![VadEvent::SpeechStarted]
        );
        let mut raw = Vad::new(VadConfig::default());
        run(&mut raw, -70.0, 500, None);
        assert!(run(&mut raw, -30.0, 400, Some(-20.0)).is_empty());
    }

    #[test]
    fn a_monologue_is_cut_at_the_maximum() {
        let config = VadConfig {
            max_utterance_ms: 2_000,
            ..VadConfig::default()
        };
        let mut vad = Vad::new(config);
        run(&mut vad, -70.0, 500, None);
        let events = run(&mut vad, -25.0, 3_000, None);
        assert_eq!(events[0], VadEvent::SpeechStarted);
        assert!(matches!(events[1], VadEvent::UtteranceEnded { .. }));
    }
}
