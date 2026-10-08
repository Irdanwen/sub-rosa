//! The speaker side of the loop: one sentence at a time, stopped at once.
//!
//! The audio callback pulls from here; the session pushes a clip, stops it
//! on a barge-in, and polls for clips that finished. It also reports how
//! loud it has just been playing, held for a moment past the end of a
//! clip, which is what the detector's echo-aware threshold reads: the echo
//! of the last syllable reaches the microphone after the speaker went
//! quiet.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long the playback level is held after the speaker goes quiet.
const ECHO_TAIL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipId {
    pub turn: u64,
    pub index: usize,
}

#[derive(Default)]
struct Inner {
    clip: Option<(ClipId, Vec<f32>, usize)>,
    finished: Vec<ClipId>,
    level_db: f32,
    loud_until: Option<Instant>,
}

pub struct Player {
    rate: u32,
    inner: Mutex<Inner>,
}

impl Player {
    /// A player for an output that runs at `rate`.
    pub fn new(rate: u32) -> Self {
        Self {
            rate,
            inner: Mutex::new(Inner {
                level_db: -100.0,
                ..Inner::default()
            }),
        }
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// Starts `samples` (mono, at [`Self::rate`]), replacing whatever played.
    pub fn play(&self, id: ClipId, samples: Vec<f32>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.clip = Some((id, samples, 0));
        }
    }

    /// Silences the speaker now. The clip is not reported as finished.
    pub fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.clip = None;
        }
    }

    /// Clips that played to their end since the last call.
    pub fn take_finished(&self) -> Vec<ClipId> {
        self.inner
            .lock()
            .map(|mut inner| std::mem::take(&mut inner.finished))
            .unwrap_or_default()
    }

    /// What the speaker is playing, in dBFS, or `None` once it has been
    /// quiet for the echo tail.
    pub fn level_db(&self) -> Option<f32> {
        self.level_db_at(Instant::now())
    }

    fn level_db_at(&self, now: Instant) -> Option<f32> {
        let inner = self.inner.lock().ok()?;
        match inner.loud_until {
            Some(until) if now < until => Some(inner.level_db),
            _ => None,
        }
    }

    /// Fills an interleaved output buffer of `channels` channels. Called
    /// from the audio callback.
    pub fn fill(&self, out: &mut [f32], channels: usize) {
        self.fill_at(out, channels, Instant::now());
    }

    fn fill_at(&self, out: &mut [f32], channels: usize, now: Instant) {
        let channels = channels.max(1);
        let Ok(mut inner) = self.inner.lock() else {
            out.fill(0.0);
            return;
        };
        // Power of what was written, measured here rather than collected:
        // this runs on the audio thread and must not allocate.
        let mut power = 0.0f32;
        let mut written = 0usize;
        let mut done = None;
        if let Some((id, samples, cursor)) = inner.clip.as_mut() {
            for frame in out.chunks_mut(channels) {
                let sample = samples.get(*cursor).copied().unwrap_or(0.0);
                if *cursor < samples.len() {
                    *cursor += 1;
                    power += sample * sample;
                    written += 1;
                }
                frame.fill(sample);
            }
            if *cursor >= samples.len() {
                done = Some(*id);
            }
        } else {
            out.fill(0.0);
        }
        if let Some(id) = done {
            inner.clip = None;
            inner.finished.push(id);
        }
        if written > 0 {
            let mean = power / written as f32;
            let level = if mean <= 1.0e-10 {
                -100.0
            } else {
                10.0 * mean.log10()
            };
            // Peak-hold with a slow release, so a pause between two words
            // does not drop the threshold under the reply's next syllable.
            let held = match inner.loud_until {
                Some(until) if now < until => inner.level_db - 0.5,
                _ => -100.0,
            };
            inner.level_db = level.max(held);
            inner.loud_until = Some(now + ECHO_TAIL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: ClipId = ClipId { turn: 1, index: 0 };

    #[test]
    fn a_clip_plays_to_its_end_once_on_every_channel() {
        let player = Player::new(48_000);
        player.play(ID, vec![0.5; 6]);
        let mut out = vec![9.0; 8];
        player.fill(&mut out, 2);
        assert_eq!(out, vec![0.5; 8]);
        assert!(player.take_finished().is_empty());
        let mut out = vec![9.0; 8];
        player.fill(&mut out, 2);
        assert_eq!(out, vec![0.5, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(player.take_finished(), vec![ID]);
        assert!(player.take_finished().is_empty());
        let mut out = vec![9.0; 4];
        player.fill(&mut out, 2);
        assert_eq!(out, vec![0.0; 4]);
    }

    #[test]
    fn stop_silences_without_finishing() {
        let player = Player::new(16_000);
        player.play(ID, vec![0.5; 100]);
        player.stop();
        let mut out = vec![1.0; 10];
        player.fill(&mut out, 1);
        assert_eq!(out, vec![0.0; 10]);
        assert!(player.take_finished().is_empty());
    }

    #[test]
    fn the_level_is_held_for_the_echo_tail() {
        let player = Player::new(16_000);
        let start = Instant::now();
        assert_eq!(player.level_db_at(start), None);
        player.play(ID, vec![0.1; 320]);
        let mut out = vec![0.0; 320];
        player.fill_at(&mut out, 1, start);
        let level = player.level_db_at(start).unwrap_or(-100.0);
        assert!((level + 20.0).abs() < 0.5, "{level}");
        // Quiet output keeps the held level for the tail, then lets go.
        player.fill_at(&mut out, 1, start + Duration::from_millis(20));
        assert!(player
            .level_db_at(start + Duration::from_millis(200))
            .is_some());
        assert_eq!(player.level_db_at(start + Duration::from_millis(300)), None);
    }
}
