//! The web client's study mode (ADR-0089), as Rust says it (see `mod.rs`).
//!
//! The tutoring prompt and the review's limits are Rust values. The vectors
//! are what `study::schedule::review` answers for fixed answers, so the
//! TypeScript port of SM-2 is checked against the original.

use chrono::{TimeZone, Utc};

use crate::study::schedule::{self, CardState, Grade};

fn state(value: CardState) -> serde_json::Value {
    serde_json::json!({
        "ease": value.ease,
        "intervalDays": value.interval_days,
        "repetitions": value.repetitions,
        "lapses": value.lapses,
    })
}

fn vectors() -> serde_json::Value {
    let now = Utc.with_ymd_and_hms(2026, 10, 1, 9, 0, 0).unwrap();
    let starts = [
        CardState::default(),
        CardState {
            ease: 2.5,
            interval_days: 6,
            repetitions: 2,
            lapses: 0,
        },
        CardState {
            ease: 2.5,
            interval_days: 10,
            repetitions: 3,
            lapses: 0,
        },
        CardState {
            ease: 1.36,
            interval_days: 40,
            repetitions: 7,
            lapses: 2,
        },
        CardState {
            ease: 2.9,
            interval_days: 3000,
            repetitions: 9,
            lapses: 0,
        },
    ];
    let grades = [
        ("again", Grade::Again),
        ("hard", Grade::Hard),
        ("good", Grade::Good),
        ("easy", Grade::Easy),
    ];
    let mut out = Vec::new();
    for start in starts {
        for (name, grade) in grades {
            let (next, due) = schedule::review(start, grade, now);
            out.push(serde_json::json!({
                "state": state(start),
                "grade": name,
                "next": state(next),
                "due": crate::study::stamp(due),
            }));
        }
    }
    serde_json::json!({ "now": crate::study::stamp(now), "reviews": out })
}

fn export() -> serde_json::Value {
    serde_json::json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/study.rs",
        "promptVersion": crate::study::STUDY_PROMPT_VERSION,
        "prompt": crate::study::STUDY_PROMPT,
        "minEase": schedule::MIN_EASE,
        "startEase": schedule::START_EASE,
        "relearnMinutes": schedule::RELEARN_MINUTES,
        "maxIntervalDays": schedule::MAX_INTERVAL_DAYS,
        "maxCardsPerAdd": crate::study::MAX_CARDS_PER_ADD,
        "maxSideChars": crate::study::MAX_SIDE_CHARS,
        "maxDeckChars": crate::study::MAX_DECK_CHARS,
        "vectors": vectors(),
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("study", export());
}
