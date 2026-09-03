// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::domain::types::{RecordingSource, RecordingSourceMode};

#[test]
fn dual_source_mode_requires_microphone_and_system_sources() {
    assert_eq!(
        RecordingSourceMode::MicrophonePlusSystem.required_sources(),
        vec![RecordingSource::Microphone, RecordingSource::System]
    );
}

#[test]
fn microphone_only_mode_requires_only_microphone() {
    assert_eq!(
        RecordingSourceMode::MicrophoneOnly.required_sources(),
        vec![RecordingSource::Microphone]
    );
}
