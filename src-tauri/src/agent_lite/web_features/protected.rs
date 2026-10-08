//! The web client's protected mode, as Rust says it (see `mod.rs`): what
//! makes a model adult, the instruction every chat prompt carries while it is
//! on, the refusals, and the PIN's rules (ADR-0084). The browser holds its
//! own switch; only the words and the predicate come from here.

use crate::protected_mode::{guards, pin, restrictions};

fn export() -> serde_json::Value {
    let pin_format = pin::validate("12")
        .expect_err("a two digit PIN is refused")
        .message;
    let mut throttle = pin::Throttle::default();
    let now = std::time::Instant::now();
    for _ in 0..pin::MAX_FAILURES {
        throttle.record(false, now);
    }
    let locked = throttle
        .check(now)
        .expect_err("the throttle locks after its failures")
        .message;
    let invalid_window = restrictions::validate(&restrictions::Restrictions {
        quiet_hours: Some(restrictions::QuietHours {
            start_minute: 60,
            end_minute: 60,
        }),
        ..Default::default()
    })
    .expect_err("an empty window is refused")
    .message;
    serde_json::json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/protected.rs",
        "adultMarkers": guards::ADULT_MARKERS,
        "promptBlock": guards::prompt_block(true),
        "pin": {
            "minDigits": 4,
            "maxDigits": 6,
            "maxFailures": pin::MAX_FAILURES,
            "lockoutSeconds": pin::LOCKOUT.as_secs(),
        },
        "refusals": {
            "model": guards::blocked_model().message,
            "quietHours": restrictions::quiet_hours_refusal().message,
            "mediaOff": restrictions::media_refusal().message,
            "voiceOff": restrictions::voice_refusal().message,
            "wrongPin": crate::protected_mode::wrong_pin().message,
            "pinFormat": pin_format,
            "locked": locked,
            "quietHoursInvalid": invalid_window,
        },
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("protected", export());
}
