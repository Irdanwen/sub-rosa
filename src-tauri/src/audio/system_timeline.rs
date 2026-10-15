//! Keeps the Windows system lane on the wall clock (ADR-0112).
//!
//! WASAPI loopback delivers nothing while nothing plays, so a file written
//! from its packets alone would be shorter than the take, and every turn
//! after a silence would land early against the microphone (ADR-0005: turns
//! are the only join between the two lanes, by `start_ms`). The worker asks
//! this ledger how much silence belongs before what it is about to write,
//! the rule the macOS helper applies in `main.swift`.
//!
//! Pure on purpose: time is passed in as the duration since capture began,
//! so the rules are tested on any host while the loopback itself only
//! compiles for Windows.

use std::time::Duration;

/// Gaps shorter than this are packet jitter, not silence.
const PAD_TOLERANCE: Duration = Duration::from_millis(80);
/// No packet for this long means nothing is playing.
const IDLE_AFTER: Duration = Duration::from_millis(200);
/// While idle, stop this far short of now: a packet already in flight
/// must not land after silence that claims its time.
const IDLE_HEADROOM: Duration = Duration::from_millis(100);

#[derive(Debug, Clone)]
pub struct SilencePadder {
    rate: u32,
    accumulated_active: Duration,
    /// When the current active stretch began; `None` while paused.
    active_since: Option<Duration>,
    written: u64,
}

impl SilencePadder {
    pub fn new(rate: u32, now: Duration) -> Self {
        Self {
            rate: rate.max(1),
            accumulated_active: Duration::ZERO,
            active_since: Some(now),
            written: 0,
        }
    }

    pub fn is_paused(&self) -> bool {
        self.active_since.is_none()
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    fn active_elapsed(&self, now: Duration) -> Duration {
        self.accumulated_active
            + self
                .active_since
                .map(|since| now.saturating_sub(since))
                .unwrap_or_default()
    }

    fn frames(&self, duration: Duration) -> u64 {
        (duration.as_secs_f64() * f64::from(self.rate)).round() as u64
    }

    fn missing_at(&self, at: Duration, incoming: u64) -> u64 {
        let expected = self.frames(self.active_elapsed(at));
        expected.saturating_sub(self.written + incoming)
    }

    /// Silence to write before `incoming` captured frames that arrive at
    /// `now`. Zero while paused or when the gap is only jitter.
    pub fn padding_before(&self, now: Duration, incoming: u64) -> u64 {
        if self.is_paused() {
            return 0;
        }
        let missing = self.missing_at(now, incoming);
        if missing > self.frames(PAD_TOLERANCE) {
            missing
        } else {
            0
        }
    }

    /// Silence to write on a tick when no packet has arrived since
    /// `last_packet_at` (or ever).
    pub fn idle_padding(&self, now: Duration, last_packet_at: Option<Duration>) -> u64 {
        if self.is_paused() {
            return 0;
        }
        let idle_since = last_packet_at.unwrap_or_default();
        if now.saturating_sub(idle_since) <= IDLE_AFTER {
            return 0;
        }
        self.missing_at(now.saturating_sub(IDLE_HEADROOM), 0)
    }

    /// Silence that brings the lane up to `now` exactly, before a pause or
    /// the end of the take.
    pub fn padding_to(&self, now: Duration) -> u64 {
        if self.is_paused() {
            return 0;
        }
        self.missing_at(now, 0)
    }

    pub fn record_written(&mut self, frames: u64) {
        self.written += frames;
    }

    pub fn pause(&mut self, now: Duration) {
        if let Some(since) = self.active_since.take() {
            self.accumulated_active += now.saturating_sub(since);
        }
    }

    pub fn resume(&mut self, now: Duration) {
        if self.active_since.is_none() {
            self.active_since = Some(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SilencePadder;
    use std::time::Duration;

    const RATE: u32 = 48_000;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    fn frames(value_ms: u64) -> u64 {
        value_ms * u64::from(RATE) / 1_000
    }

    #[test]
    fn steady_packets_need_no_padding() {
        let mut padder = SilencePadder::new(RATE, ms(0));
        for tick in 1..=100 {
            let now = ms(tick * 10);
            assert_eq!(padder.padding_before(now, frames(10)), 0);
            padder.record_written(frames(10));
        }
        assert_eq!(padder.written(), frames(1_000));
    }

    #[test]
    fn jitter_below_the_tolerance_is_not_padded() {
        let padder = SilencePadder::new(RATE, ms(0));
        // 60 ms late against a 10 ms packet: jitter, not a silence.
        assert_eq!(padder.padding_before(ms(70), frames(10)), 0);
    }

    #[test]
    fn a_silence_is_filled_before_the_first_packet_after_it() {
        let mut padder = SilencePadder::new(RATE, ms(0));
        padder.record_written(frames(1_000));
        // Nothing played for four seconds, then a 10 ms packet arrives.
        let pad = padder.padding_before(ms(5_000), frames(10));
        assert_eq!(pad, frames(3_990));
        padder.record_written(pad + frames(10));
        assert_eq!(padder.written(), frames(5_000));
    }

    #[test]
    fn idle_ticks_pad_up_to_now_minus_headroom() {
        let mut padder = SilencePadder::new(RATE, ms(0));
        padder.record_written(frames(1_000));
        // 150 ms since the last packet: not idle yet.
        assert_eq!(padder.idle_padding(ms(1_150), Some(ms(1_000))), 0);
        // 2 s since the last packet: pad to 1.9 s.
        let pad = padder.idle_padding(ms(3_000), Some(ms(1_000)));
        assert_eq!(pad, frames(1_900));
        padder.record_written(pad);
        // A packet landing now is owed what the headroom held back.
        assert_eq!(padder.padding_before(ms(3_000), frames(10)), frames(90));
        // One that was already in flight, stamped just after the tick,
        // lands within the tolerance and is written as is.
        assert_eq!(padder.padding_before(ms(2_960), frames(10)), 0);
    }

    #[test]
    fn a_take_that_never_heard_a_packet_is_still_padded() {
        let padder = SilencePadder::new(RATE, ms(0));
        assert_eq!(padder.idle_padding(ms(1_000), None), frames(900));
    }

    #[test]
    fn a_pause_freezes_the_clock_and_pads_nothing() {
        let mut padder = SilencePadder::new(RATE, ms(0));
        padder.record_written(padder.padding_to(ms(2_000)));
        padder.pause(ms(2_000));
        assert!(padder.is_paused());
        assert_eq!(padder.idle_padding(ms(60_000), Some(ms(2_000))), 0);
        assert_eq!(padder.padding_before(ms(60_000), frames(10)), 0);
        padder.resume(ms(60_000));
        // One second after resuming, one second is owed: not the pause.
        assert_eq!(padder.padding_to(ms(61_000)), frames(1_000));
    }

    #[test]
    fn a_lane_ahead_of_the_clock_is_never_padded() {
        let mut padder = SilencePadder::new(RATE, ms(0));
        padder.record_written(frames(2_000));
        assert_eq!(padder.padding_before(ms(1_000), frames(10)), 0);
        assert_eq!(padder.idle_padding(ms(1_500), Some(ms(1_000))), 0);
        assert_eq!(padder.padding_to(ms(1_000)), 0);
    }
}
