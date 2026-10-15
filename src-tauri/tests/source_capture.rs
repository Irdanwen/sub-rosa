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

#[test]
fn computer_only_mode_requires_only_the_system_source() {
    let mode = RecordingSourceMode::SystemOnly;

    assert_eq!(mode.required_sources(), vec![RecordingSource::System]);
    assert!(!mode.includes_microphone());
    assert!(mode.includes_system());
    assert_eq!(mode.primary_source(), RecordingSource::System);
}

#[test]
fn source_modes_round_trip_through_storage_and_ipc() {
    for mode in [
        RecordingSourceMode::MicrophoneOnly,
        RecordingSourceMode::MicrophonePlusSystem,
        RecordingSourceMode::SystemOnly,
    ] {
        assert_eq!(RecordingSourceMode::from(mode.as_db()), mode);
        let wire = serde_json::to_string(&mode).unwrap();
        assert_eq!(
            serde_json::from_str::<RecordingSourceMode>(&wire).unwrap(),
            mode
        );
    }
    assert_eq!(
        serde_json::to_string(&RecordingSourceMode::SystemOnly).unwrap(),
        "\"systemOnly\""
    );
    // A value written by a newer app degrades to the safest mode.
    assert_eq!(
        RecordingSourceMode::from("something_new"),
        RecordingSourceMode::MicrophoneOnly
    );
}
