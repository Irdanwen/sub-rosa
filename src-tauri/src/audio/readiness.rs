//! Whether each source can record right now, for a requested source mode.
//!
//! Readiness describes the machine, not the request: both sources are always
//! reported so the UI can explain why one is unavailable. Only `required`
//! follows the mode, so a microphone-only take is never blocked by a computer
//! that cannot capture its own sound, and a computer-only take never waits
//! on a microphone it will not open.

use crate::{
    audio::capture::{
        microphone_device_available, microphone_device_hint, microphone_permission_state,
    },
    domain::types::{
        AppError, RecordingSource, RecordingSourceMode, RecordingSourceReadinessDto,
        SourceReadinessDto,
    },
};

pub fn recording_source_readiness(source_mode: RecordingSourceMode) -> RecordingSourceReadinessDto {
    let (microphone_state, microphone_hint) = microphone_permission_state();
    // iOS reports "unknown" before the first prompt; keep it startable so the
    // record attempt can raise the system permission prompt (blocking here
    // would make it unreachable). Desktop gates on device availability because
    // macOS 14.0/14.1 can report a stale TCC permission state (JUN-223); an
    // explicit denied/restricted still blocks.
    let microphone_permission_blocked =
        matches!(microphone_state.as_str(), "denied" | "restricted");
    let microphone_device_available = microphone_device_available();
    let microphone_ready = microphone_state == "unknown"
        || (!microphone_permission_blocked && microphone_device_available);
    let microphone_message = if microphone_permission_blocked {
        microphone_hint.clone()
    } else if !microphone_device_available && microphone_state != "unknown" {
        Some(microphone_device_hint())
    } else {
        None
    };
    let microphone = SourceReadinessDto {
        source: RecordingSource::Microphone,
        required: true,
        ready: microphone_ready,
        permission_state: microphone_state.clone(),
        device_available: microphone_ready,
        capture_available: microphone_ready,
        recovery_action: microphone_permission_blocked
            .then(|| "openMicrophoneSettings".to_string()),
        message: microphone_message,
    };
    #[cfg(desktop)]
    let system = {
        let mut system = crate::audio::system::system_audio_readiness();
        let capture_active = crate::audio::capture::is_capture_active();
        if should_probe_system_audio_permission(source_mode, system.ready, capture_active) {
            system = apply_system_audio_permission_probe_result(
                system,
                crate::audio::system::permission_check(),
            );
        }
        system
    };
    // Mobile: system audio never becomes ready; report it as unsupported so
    // the UI can hide the option instead of dangling a probe.
    #[cfg(mobile)]
    let system = SourceReadinessDto {
        source: RecordingSource::System,
        required: true,
        ready: false,
        permission_state: "unsupported".to_string(),
        device_available: false,
        capture_available: false,
        recovery_action: None,
        message: Some("System audio capture is not available on this device.".to_string()),
    };
    assemble_recording_source_readiness(microphone, system, source_mode)
}

pub(crate) fn assemble_recording_source_readiness(
    mut microphone: SourceReadinessDto,
    mut system: SourceReadinessDto,
    source_mode: RecordingSourceMode,
) -> RecordingSourceReadinessDto {
    microphone.required = source_mode.includes_microphone();
    system.required = source_mode.includes_system();
    let sources = vec![microphone, system];
    let ready = sources
        .iter()
        .all(|source| !source.required || source.ready);
    RecordingSourceReadinessDto {
        source_mode,
        ready,
        checked_at: crate::db::repositories::timestamp(),
        sources,
    }
}

// System audio is desktop-only; mobile compiles these for nothing.
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn should_probe_system_audio_permission(
    source_mode: RecordingSourceMode,
    system_ready: bool,
    capture_active: bool,
) -> bool {
    source_mode.includes_system() && system_ready && !capture_active
}

#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn apply_system_audio_permission_probe_result(
    mut system: SourceReadinessDto,
    result: Result<(), AppError>,
) -> SourceReadinessDto {
    match result {
        Ok(()) => {
            system.permission_state = "granted".to_string();
        }
        Err(error) => {
            system.ready = false;
            system.capture_available = false;
            match error.code.as_str() {
                "system_audio_permission_denied" => {
                    system.permission_state = "denied".to_string();
                    system.recovery_action = Some("openSystemAudioSettings".to_string());
                }
                "system_audio_capture_unavailable" => {
                    system.permission_state = "granted".to_string();
                    system.recovery_action = Some("restartApp".to_string());
                }
                _ => {
                    system.permission_state = "unknown".to_string();
                    system.recovery_action = Some("restartApp".to_string());
                }
            }
            system.message = Some(error.message);
        }
    }
    system
}

#[cfg(test)]
mod tests {
    use super::{
        apply_system_audio_permission_probe_result, assemble_recording_source_readiness,
        should_probe_system_audio_permission,
    };
    use crate::domain::types::{
        AppError, RecordingSource, RecordingSourceMode, SourceReadinessDto,
    };

    #[test]
    fn skips_system_audio_permission_probe_while_capture_is_active() {
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            true,
            true
        ));
    }

    #[test]
    fn probes_system_audio_permission_only_when_available_and_idle() {
        assert!(should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            true,
            false
        ));
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            false,
            false
        ));
    }

    #[test]
    fn system_audio_permission_probe_is_skipped_for_microphone_only() {
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophoneOnly,
            true,
            false
        ));
    }

    #[test]
    fn computer_only_probes_the_system_audio_permission() {
        assert!(should_probe_system_audio_permission(
            RecordingSourceMode::SystemOnly,
            true,
            false
        ));
    }

    #[test]
    fn microphone_only_readiness_still_reports_the_system_source() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophoneOnly,
        );
        let system = source(&readiness.sources, RecordingSource::System);

        assert_eq!(system.permission_state, "unsupported");
        assert!(!system.required);
    }

    #[test]
    fn microphone_only_readiness_stays_ready_when_system_is_unsupported() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophoneOnly,
        );

        assert!(readiness.ready);
    }

    #[test]
    fn microphone_plus_system_keeps_the_system_source_required() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophonePlusSystem,
        );
        let system = source(&readiness.sources, RecordingSource::System);

        assert!(system.required);
        assert!(!readiness.ready);
    }

    #[test]
    fn computer_only_does_not_require_the_microphone() {
        let mut microphone = microphone_readiness();
        microphone.ready = false;
        microphone.permission_state = "denied".to_string();
        let readiness = assemble_recording_source_readiness(
            microphone,
            system_readiness(),
            RecordingSourceMode::SystemOnly,
        );

        assert!(!source(&readiness.sources, RecordingSource::Microphone).required);
        assert!(source(&readiness.sources, RecordingSource::System).required);
        assert!(readiness.ready);
    }

    #[test]
    fn computer_only_is_not_ready_without_the_system_source() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::SystemOnly,
        );

        assert!(!readiness.ready);
    }

    #[test]
    fn successful_system_audio_permission_probe_reports_granted() {
        let readiness = apply_system_audio_permission_probe_result(system_readiness(), Ok(()));

        assert!(readiness.ready);
        assert_eq!(readiness.permission_state, "granted");
        assert!(readiness.capture_available);
    }

    #[test]
    fn failed_system_audio_permission_probe_blocks_capture() {
        let readiness = apply_system_audio_permission_probe_result(
            system_readiness(),
            Err(AppError::new(
                "system_audio_permission_denied",
                "Grant access.",
            )),
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.permission_state, "denied");
        assert!(!readiness.capture_available);
        assert_eq!(readiness.message.as_deref(), Some("Grant access."));
    }

    #[test]
    fn failed_system_audio_capture_probe_keeps_permission_granted() {
        let readiness = apply_system_audio_permission_probe_result(
            system_readiness(),
            Err(AppError::new(
                "system_audio_capture_unavailable",
                "Failed to create audio format for system tap.",
            )),
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.permission_state, "granted");
        assert!(!readiness.capture_available);
        assert_eq!(readiness.recovery_action.as_deref(), Some("restartApp"));
        assert_eq!(
            readiness.message.as_deref(),
            Some("Failed to create audio format for system tap.")
        );
    }

    fn source(sources: &[SourceReadinessDto], wanted: RecordingSource) -> &SourceReadinessDto {
        sources
            .iter()
            .find(|source| source.source == wanted)
            .expect("source readiness")
    }

    fn system_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: true,
            permission_state: "unknown".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: Some("openSystemAudioSettings".to_string()),
            message: None,
        }
    }

    fn unsupported_system_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            permission_state: "unsupported".to_string(),
            device_available: false,
            capture_available: false,
            recovery_action: Some("upgradeMacos".to_string()),
            message: Some("System audio capture requires macOS 14.2 or later.".to_string()),
        }
    }

    fn microphone_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::Microphone,
            required: true,
            ready: true,
            permission_state: "granted".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: None,
            message: None,
        }
    }
}
