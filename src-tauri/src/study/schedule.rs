//! When a card comes back: SM-2, the algorithm spaced repetition grew up on,
//! with the four answers a review screen offers instead of its six grades.
//!
//! - **Again** is a lapse. The card starts over and comes back in ten
//!   minutes, inside the same sitting, because a card forgotten now is the
//!   one most worth seeing again before the session ends.
//! - **Hard**, **Good** and **Easy** are passes. The first pass waits a day,
//!   the second six, and each later one multiplies the last interval by the
//!   card's ease. Hard grows the interval by a fifth instead of by the ease,
//!   and Easy adds a bonus on top of it.
//! - The ease moves by the SM-2 formula and never drops under 1.3, below
//!   which a card would come back so often that it stops being reviewed and
//!   starts being drilled.

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;

pub const MIN_EASE: f64 = 1.3;
pub const START_EASE: f64 = 2.5;
/// How soon a forgotten card comes back.
pub const RELEARN_MINUTES: i64 = 10;
/// No interval past this: a card a person sees once every ten years is a
/// card they no longer have.
pub const MAX_INTERVAL_DAYS: i64 = 3650;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    /// The SM-2 quality the answer stands for.
    fn quality(self) -> f64 {
        match self {
            Grade::Again => 1.0,
            Grade::Hard => 3.0,
            Grade::Good => 4.0,
            Grade::Easy => 5.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CardState {
    pub ease: f64,
    pub interval_days: i64,
    pub repetitions: i64,
    pub lapses: i64,
}

impl Default for CardState {
    fn default() -> Self {
        Self {
            ease: START_EASE,
            interval_days: 0,
            repetitions: 0,
            lapses: 0,
        }
    }
}

/// The state after an answer, and when the card is due again.
pub fn review(state: CardState, grade: Grade, now: DateTime<Utc>) -> (CardState, DateTime<Utc>) {
    let q = grade.quality();
    let eased = state.ease + (0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02));
    if grade == Grade::Again {
        let next = CardState {
            ease: (state.ease - 0.2).max(MIN_EASE),
            interval_days: 0,
            repetitions: 0,
            lapses: state.lapses + 1,
        };
        return (next, now + Duration::minutes(RELEARN_MINUTES));
    }
    let repetitions = state.repetitions + 1;
    let previous = state.interval_days.max(1) as f64;
    let base = match repetitions {
        1 => 1,
        2 => 6,
        _ => (previous * state.ease).round() as i64,
    };
    let interval = match grade {
        Grade::Hard if repetitions > 2 => ((previous * 1.2).round() as i64).max(1),
        Grade::Hard => base,
        Grade::Easy => ((base as f64 * 1.3).round() as i64).max(base + 1),
        _ => base,
    }
    .clamp(1, MAX_INTERVAL_DAYS);
    let next = CardState {
        ease: eased.max(MIN_EASE),
        interval_days: interval,
        repetitions,
        lapses: state.lapses,
    };
    (next, now + Duration::days(interval))
}
