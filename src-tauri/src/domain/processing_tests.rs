//! Unit tests for [`super`], the audio-to-note pipeline.
//!
//! They live in their own file rather than at the foot of `processing.rs`
//! because that file sits against the size ratchet and the tests were two
//! fifths of it. `#[path]` keeps this a child module of `processing`, so
//! `use super::*` and the private items it reaches still resolve exactly as
//! they did inline.

use super::*;

// Test-only shims over the pipeline's private helpers. They lived in
// `processing.rs` behind `#[cfg(test)]`, which put test scaffolding in a file
// that is fighting for every line; a child module reaches the same private
// items, so this is where they belong.

async fn transcribe_turn_jobs_by_source_lane(
    jobs: Vec<TurnTranscriptionJob>,
    provider: String,
    title: String,
    dictionary_context: Option<String>,
    transcriber: TurnTranscriber,
) -> Result<TranscriptionOutcome, AppError> {
    transcribe_turn_jobs_bounded(
        jobs,
        &[],
        provider,
        title,
        dictionary_context,
        transcriber,
        None,
        DEFAULT_TURN_TRANSCRIPTION_CONCURRENCY,
        None,
    )
    .await
}

fn drop_silent_system_sources(
    sources: Vec<(String, String, PathBuf)>,
) -> Vec<(String, String, PathBuf)> {
    partition_silent_system_sources(sources).kept
}

fn note_transcript_cleanup_user_message(text: &str, context: Option<&str>) -> String {
    let context = context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("{value}\n\n"))
        .unwrap_or_default();
    format!(
        "{context}<asr_transcript>\n{}\n</asr_transcript>\n\nReturn only the corrected transcript text.",
        text.replace("</asr_transcript>", "<\\/asr_transcript>")
    )
}
use crate::june_api::TranscriptionProviderResult;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

#[test]
fn full_source_normalization_runs_once_per_source() {
    // Every turn of a source shares one normalized full-source copy; the
    // job loop used to produce a fresh one per turn (a full decode,
    // resample, and rewrite of the entire recording each time).
    let dir =
        std::env::temp_dir().join(format!("os-june-normalize-cache-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("microphone.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&source, spec).unwrap();
    // Quiet samples force a real normalization pass with an output file.
    for sample in [100i16, -120, 90, -80] {
        writer.write_sample(sample).unwrap();
    }
    writer.finalize().unwrap();

    let mut cache = HashMap::new();
    let first = normalized_full_source(&mut cache, &dir, "microphone", &source).unwrap();
    let second = normalized_full_source(&mut cache, &dir, "microphone", &source).unwrap();

    assert_eq!(first, second);
    let normalized_outputs = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains("source-normalized")
        })
        .count();
    assert_eq!(normalized_outputs, 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn session_temp_dir_sanitizes_untrusted_session_ids() {
    let temp_dir = session_temp_dir("os-june-turns", "../../outside/session");
    let file_name = temp_dir
        .file_name()
        .and_then(|value| value.to_str())
        .expect("temp dir file name");

    assert_eq!(file_name, "os-june-turns-______outside_session");
    assert!(!temp_dir
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir)));
}

#[test]
fn missing_system_turn_gets_full_source_fallback() {
    let mic_path = PathBuf::from("microphone.wav");
    let system_path = PathBuf::from("system.wav");
    let sources = vec![
        (
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        ),
        (
            "system-artifact".to_string(),
            "system".to_string(),
            system_path.clone(),
        ),
    ];
    let detected_mic_turn = AudioTurn {
        artifact_id: "mic-artifact".to_string(),
        source: "microphone".to_string(),
        source_path: mic_path,
        extraction_start_ms: 7_020,
        start_ms: 7_020,
        end_ms: 9_180,
        turn_index: 0,
    };

    let covered = add_full_source_turns_for_missing_sources(
        &sources,
        vec![detected_mic_turn],
        &EchoRejectionReport::default(),
    );

    assert_eq!(covered.len(), 2);
    assert!(covered.iter().any(|turn| {
        turn.artifact_id == "mic-artifact" && turn.start_ms == 7_020 && turn.end_ms == 9_180
    }));
    let system_fallback = covered
        .iter()
        .find(|turn| turn.artifact_id == "system-artifact")
        .expect("system source should receive a fallback turn");
    assert_eq!(system_fallback.source, "system");
    assert_eq!(system_fallback.source_path, system_path);
    assert_eq!(system_fallback.start_ms, 0);
    assert_eq!(system_fallback.end_ms, 0);
}

#[test]
fn source_coverage_does_not_duplicate_existing_turns() {
    let mic_path = PathBuf::from("microphone.wav");
    let system_path = PathBuf::from("system.wav");
    let sources = vec![
        (
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        ),
        (
            "system-artifact".to_string(),
            "system".to_string(),
            system_path.clone(),
        ),
    ];
    let turns = vec![
        AudioTurn {
            artifact_id: "mic-artifact".to_string(),
            source: "microphone".to_string(),
            source_path: mic_path,
            extraction_start_ms: 1_000,
            start_ms: 1_000,
            end_ms: 2_000,
            turn_index: 0,
        },
        AudioTurn {
            artifact_id: "system-artifact".to_string(),
            source: "system".to_string(),
            source_path: system_path,
            extraction_start_ms: 3_000,
            start_ms: 3_000,
            end_ms: 4_000,
            turn_index: 1,
        },
    ];

    let covered =
        add_full_source_turns_for_missing_sources(&sources, turns, &EchoRejectionReport::default());

    assert_eq!(covered.len(), 2);
    assert!(covered.iter().all(|turn| turn.end_ms > turn.start_ms));
}

#[test]
fn all_bleed_microphone_is_not_resurrected_as_a_full_file_turn() {
    // The flagship echo-rejection scenario: the user on speakers mostly
    // listens, every detected microphone turn was bleed, and echo
    // rejection dropped them all. The full-file fallback exists for
    // sources whose detector genuinely found nothing; resurrecting this
    // microphone would transcribe the entire raw recording and
    // re-attribute the whole remote meeting to the user.
    let mic_path = PathBuf::from("microphone.wav");
    let sources = vec![(
        "mic-artifact".to_string(),
        "microphone".to_string(),
        mic_path,
    )];
    let report = EchoRejectionReport {
        detected_turn_artifact_ids: vec!["mic-artifact".to_string()],
        dropped_turn_count: 1,
        ..EchoRejectionReport::default()
    };

    let covered = add_full_source_turns_for_missing_sources(&sources, Vec::new(), &report);

    assert!(
        covered.is_empty(),
        "deliberately rejected source must not be resurrected, got {covered:?}"
    );
}

#[test]
fn coalescing_does_not_bridge_trimmed_bleed_spans() {
    // Kept remainders around a trimmed interior bleed span sit closer
    // than the transcription coherence gap. Merging them would extract
    // one contiguous segment that contains the trimmed audio again.
    let turn = |start_ms: i64, end_ms: i64| AudioTurn {
        artifact_id: "mic-artifact".to_string(),
        source: "microphone".to_string(),
        source_path: PathBuf::from("microphone.wav"),
        extraction_start_ms: start_ms,
        start_ms,
        end_ms,
        turn_index: 0,
    };
    let remainders = vec![turn(0, 1_000), turn(2_000, 3_000)];

    // Without a bleed span in the gap the pair coalesces as before...
    let merged = coalesce_turns_for_transcription_avoiding_echo(remainders.clone(), &[]);
    assert_eq!(merged.len(), 1);
    assert_eq!((merged[0].start_ms, merged[0].end_ms), (0, 3_000));

    // ...but a trimmed bleed span between them forbids the bridge.
    let kept_apart = coalesce_turns_for_transcription_avoiding_echo(remainders, &[(1_000, 2_000)]);
    assert_eq!(kept_apart.len(), 2);
    assert_eq!(kept_apart[0].end_ms, 1_000);
    assert_eq!(kept_apart[1].start_ms, 2_000);
}

#[test]
fn empty_detection_gets_full_source_fallback_for_every_source() {
    let mic_path = PathBuf::from("microphone.wav");
    let system_path = PathBuf::from("system.wav");
    let sources = vec![
        (
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        ),
        (
            "system-artifact".to_string(),
            "system".to_string(),
            system_path.clone(),
        ),
    ];

    let covered = add_full_source_turns_for_missing_sources(
        &sources,
        Vec::new(),
        &EchoRejectionReport::default(),
    );
    let covered = coalesce_turns_for_transcription_avoiding_echo(covered, &[]);

    assert_eq!(covered.len(), 2);
    let microphone = covered
        .iter()
        .find(|turn| turn.artifact_id == "mic-artifact")
        .expect("microphone source should receive a fallback turn");
    assert_eq!(microphone.source, "microphone");
    assert_eq!(microphone.source_path, mic_path);
    assert_eq!(microphone.start_ms, 0);
    assert_eq!(microphone.end_ms, 0);

    let system = covered
        .iter()
        .find(|turn| turn.artifact_id == "system-artifact")
        .expect("system source should receive a fallback turn");
    assert_eq!(system.source, "system");
    assert_eq!(system.source_path, system_path);
    assert_eq!(system.start_ms, 0);
    assert_eq!(system.end_ms, 0);
}

#[tokio::test]
async fn transcribes_source_lanes_concurrently_and_keeps_turn_order() {
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));
    let contexts = Arc::new(Mutex::new(Vec::new()));
    let operation_ids = Arc::new(Mutex::new(Vec::new()));
    let transcriber = {
        let active = Arc::clone(&active);
        let max_active = Arc::clone(&max_active);
        let contexts = Arc::clone(&contexts);
        let operation_ids = Arc::clone(&operation_ids);
        Arc::new(move |request: TranscriptionRequest| {
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            let contexts = Arc::clone(&contexts);
            let operation_ids = Arc::clone(&operation_ids);
            Box::pin(async move {
                let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(now_active, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                let operation_id = request.operation_id();
                contexts.lock().unwrap().push((
                    request.audio_path.to_string_lossy().to_string(),
                    request.context,
                ));
                operation_ids.lock().unwrap().push(operation_id);
                Ok(TranscriptionProviderResult {
                    text: request.audio_path.to_string_lossy().to_string(),
                    language: Some("es".to_string()),
                    provider: "test".to_string(),
                })
            }) as TranscriptionFuture
        }) as TurnTranscriber
    };

    let outcome = transcribe_turn_jobs_by_source_lane(
        vec![
            test_job("m0", "microphone", 0),
            test_job("s1", "system", 1),
            test_job("m2", "microphone", 2),
        ],
        crate::providers::OPENAI_PROVIDER.to_string(),
        "Meeting".to_string(),
        None,
        transcriber,
    )
    .await
    .expect("source lanes should transcribe");

    assert!(max_active.load(Ordering::SeqCst) > 1);
    assert_eq!(
        outcome
            .candidates
            .iter()
            .map(|candidate| candidate.input.text.as_str())
            .collect::<Vec<_>>(),
        vec!["m0", "s1", "m2"]
    );

    let mut operation_ids = operation_ids.lock().unwrap().clone();
    operation_ids.sort();
    assert_eq!(
        operation_ids,
        vec![
            "artifact-m0-microphone-turn-0",
            "artifact-m2-microphone-turn-2",
            "artifact-s1-system-turn-1",
        ]
    );
}

#[tokio::test]
async fn bounded_turn_scheduler_uses_completed_context_when_available() {
    let contexts = Arc::new(Mutex::new(Vec::new()));
    let transcriber = {
        let contexts = Arc::clone(&contexts);
        Arc::new(move |request: TranscriptionRequest| {
            let contexts = Arc::clone(&contexts);
            Box::pin(async move {
                contexts.lock().unwrap().push((
                    request.audio_path.to_string_lossy().to_string(),
                    request.context,
                ));
                Ok(TranscriptionProviderResult {
                    text: request.audio_path.to_string_lossy().to_string(),
                    language: None,
                    provider: "test".to_string(),
                })
            }) as TranscriptionFuture
        }) as TurnTranscriber
    };

    transcribe_turn_jobs_bounded(
        vec![
            test_job("m0", "microphone", 0),
            test_job("s1", "system", 1),
            test_job("m2", "microphone", 2),
        ],
        &[],
        crate::providers::OPENAI_PROVIDER.to_string(),
        "Meeting".to_string(),
        None,
        transcriber,
        None,
        1,
        None,
    )
    .await
    .expect("turn jobs should transcribe");

    let contexts = contexts.lock().unwrap();
    let context_by_path = contexts.iter().cloned().collect::<HashMap<_, _>>();
    assert!(context_by_path["m0"].is_none());
    assert!(context_by_path["s1"]
        .as_ref()
        .expect("later turn should receive completed context")
        .contains("Microphone: m0"));
    assert!(context_by_path["m2"]
        .as_ref()
        .expect("later microphone turn should receive nearby context")
        .contains("System: s1"));
}

#[tokio::test]
async fn turn_transcription_requests_include_dictionary_context() {
    let contexts = Arc::new(Mutex::new(Vec::new()));
    let transcriber = {
        let contexts = Arc::clone(&contexts);
        Arc::new(move |request: TranscriptionRequest| {
            let contexts = Arc::clone(&contexts);
            Box::pin(async move {
                contexts.lock().unwrap().push((
                    request.audio_path.to_string_lossy().to_string(),
                    request.context,
                ));
                Ok(TranscriptionProviderResult {
                    text: request.audio_path.to_string_lossy().to_string(),
                    language: None,
                    provider: "test".to_string(),
                })
            }) as TranscriptionFuture
        }) as TurnTranscriber
    };

    transcribe_turn_jobs_bounded(
        vec![test_job("m0", "microphone", 0), test_job("s1", "system", 1)],
        &[],
        crate::providers::OPENAI_PROVIDER.to_string(),
        "Meeting".to_string(),
        Some("Custom dictionary terms:\n- DIM".to_string()),
        transcriber,
        None,
        1,
        None,
    )
    .await
    .expect("turn jobs should transcribe");

    let contexts = contexts.lock().unwrap();
    let context_by_path = contexts.iter().cloned().collect::<HashMap<_, _>>();
    let first_context = context_by_path["m0"]
        .as_ref()
        .expect("first turn should receive dictionary context");
    assert!(first_context.contains("Custom dictionary terms"));
    assert!(first_context.contains("DIM"));
    assert!(!first_context.contains("Previous transcript context"));

    let second_context = context_by_path["s1"]
        .as_ref()
        .expect("later turn should keep dictionary context");
    assert!(second_context.contains("Custom dictionary terms"));
    assert!(second_context.contains("DIM"));
    assert!(second_context.contains("Previous transcript context"));
    assert!(second_context.contains("Microphone: m0"));
}

#[tokio::test]
async fn source_lane_failures_keep_their_source_reason() {
    let transcriber = Arc::new(move |request: TranscriptionRequest| {
        Box::pin(async move {
            if request.audio_path == std::path::Path::new("s1") {
                Err(AppError::new(
                    "transcription_failed",
                    "System source was silent.",
                ))
            } else {
                Ok(TranscriptionProviderResult {
                    text: request.audio_path.to_string_lossy().to_string(),
                    language: None,
                    provider: "test".to_string(),
                })
            }
        }) as TranscriptionFuture
    }) as TurnTranscriber;

    let outcome = transcribe_turn_jobs_by_source_lane(
        vec![test_job("m0", "microphone", 0), test_job("s1", "system", 1)],
        crate::providers::OPENAI_PROVIDER.to_string(),
        "Meeting".to_string(),
        None,
        transcriber,
    )
    .await
    .expect("source lanes should complete despite one failed source");

    assert_eq!(outcome.candidates.len(), 1);
    assert_eq!(outcome.failures.len(), 1);
    assert_eq!(outcome.failures[0].input.source, "system");
    assert_eq!(
        source_failure_summary(&outcome.failures).as_deref(),
        Some("System: System source was silent.")
    );
}

#[tokio::test]
async fn transient_invalid_turn_response_retries_before_failing() {
    // Every transient class June API can surface without a provider result
    // must recover on retry rather than fail the whole note: an
    // invalid/empty envelope and explicit transient request failures.
    let transient_errors = [
        AppError::new(
            "june_api_response_invalid",
            "The processing service returned an invalid response.",
        ),
        AppError::new("june_request_failed", "authorization_denied"),
    ];

    for transient_error in transient_errors {
        let attempts = Arc::new(AtomicUsize::new(0));
        let transcriber = {
            let attempts = Arc::clone(&attempts);
            Arc::new(move |request: TranscriptionRequest| {
                let attempts = Arc::clone(&attempts);
                let transient_error = transient_error.clone();
                Box::pin(async move {
                    if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        return Err(transient_error);
                    }
                    Ok(TranscriptionProviderResult {
                        text: request.audio_path.to_string_lossy().to_string(),
                        language: None,
                        provider: "test".to_string(),
                    })
                }) as TranscriptionFuture
            }) as TurnTranscriber
        };

        let outcome = transcribe_turn_jobs_by_source_lane(
            vec![test_job("m0", "microphone", 0)],
            crate::providers::OPENAI_PROVIDER.to_string(),
            "Meeting".to_string(),
            None,
            transcriber,
        )
        .await
        .expect("transient response should be retried");

        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(outcome.failures.len(), 0);
        assert_eq!(outcome.candidates.len(), 1);
        assert_eq!(outcome.candidates[0].input.text, "m0");
    }
}

#[tokio::test]
async fn exhausted_invalid_tail_turn_stays_visible_as_failure() {
    // When a turn fails after the allowed attempt budget, or fails with a
    // non-retryable provider/metering error, it stays a visible per-turn
    // failure without dropping earlier successful turns. The surfaced
    // warning is user-facing copy, never the raw provider code.
    let cases = [
        (
            AppError::new(
                "june_api_response_invalid",
                "The processing service returned an invalid response.",
            ),
            "The processing service returned an invalid response.",
            TRANSIENT_TRANSCRIPTION_ATTEMPTS,
        ),
        (
            AppError::new("june_request_failed", "upstream_provider_failed"),
            "The transcription provider could not process this audio.",
            1,
        ),
        (
            AppError::new("june_request_failed", "metering_provider_failed"),
            "Billing is temporarily unavailable. Please try again in a moment.",
            1,
        ),
    ];

    for (tail_error, expected_warning, expected_attempts) in cases {
        let tail_attempts = Arc::new(AtomicUsize::new(0));
        let transcriber = {
            let tail_attempts = Arc::clone(&tail_attempts);
            Arc::new(move |request: TranscriptionRequest| {
                let tail_attempts = Arc::clone(&tail_attempts);
                let tail_error = tail_error.clone();
                Box::pin(async move {
                    if request.audio_path == std::path::Path::new("tail") {
                        tail_attempts.fetch_add(1, Ordering::SeqCst);
                        return Err(tail_error);
                    }
                    Ok(TranscriptionProviderResult {
                        text: request.audio_path.to_string_lossy().to_string(),
                        language: None,
                        provider: "test".to_string(),
                    })
                }) as TranscriptionFuture
            }) as TurnTranscriber
        };

        let outcome = transcribe_turn_jobs_by_source_lane(
            vec![
                test_job("intro", "microphone", 0),
                test_job("tail", "microphone", 1),
            ],
            crate::providers::OPENAI_PROVIDER.to_string(),
            "Meeting".to_string(),
            None,
            transcriber,
        )
        .await
        .expect("source lanes should complete despite a failed tail turn");

        assert_eq!(tail_attempts.load(Ordering::SeqCst), expected_attempts);
        assert_eq!(outcome.candidates.len(), 1);
        assert_eq!(outcome.failures.len(), 1);
        assert_eq!(outcome.candidates[0].input.text, "intro");
        assert_eq!(outcome.failures[0].input.source, "microphone");
        assert_eq!(outcome.failures[0].input.turn_index, Some(1));
        assert_eq!(
            outcome.failures[0].input.warning.as_deref(),
            Some(expected_warning)
        );
    }
}

#[test]
fn retry_after_delay_keeps_server_floor_and_adds_jitter() {
    let operation_id = (0..100)
        .map(|index| format!("retry-after-jitter-{index}"))
        .find(|operation_id| retry_jitter_ms(operation_id, 0) > 0)
        .expect("test jitter should produce a non-zero candidate");
    let mut error = AppError::new("june_request_failed", "authorization_denied");
    error.details = Some(serde_json::json!({ "retryAfterMs": 2_000 }));

    assert_eq!(
        transient_retry_delay(&operation_id, 0, &error),
        Duration::from_millis(2_000 + retry_jitter_ms(&operation_id, 0))
    );
}

#[test]
fn server_timeout_envelope_is_retryable_but_client_timeout_is_not() {
    assert!(is_retryable_transcription_error(&AppError::new(
        "june_request_failed",
        "timeout"
    )));
    assert!(!is_retryable_transcription_error(&AppError::new(
        "june_request_failed",
        "operation timed out"
    )));
    // `upstream_provider_failed` is not precise enough for desktop retry:
    // June API uses the same envelope for transient 5xxs and deterministic
    // provider 4xxs after taking a Hold.
    assert!(!is_retryable_transcription_error(&AppError::new(
        "june_request_failed",
        "upstream_provider_failed"
    )));
    // `metering_provider_failed` can come from a post-ASR charge failure;
    // replaying the desktop request would redo paid upstream work.
    assert!(!is_retryable_transcription_error(&AppError::new(
        "june_request_failed",
        "metering_provider_failed"
    )));
}

#[test]
fn turn_operation_id_includes_source_when_turn_indices_match() {
    let mic = test_job("m0", "microphone", 0);
    let system = test_job("s0", "system", 0);

    assert_ne!(turn_operation_id(&mic), turn_operation_id(&system));
    assert_eq!(turn_operation_id(&mic), "artifact-m0-microphone-turn-0");
    assert_eq!(turn_operation_id(&system), "artifact-s0-system-turn-0");
}

#[tokio::test]
async fn failed_segmented_lane_retries_full_source_audio() {
    let seen_paths = Arc::new(Mutex::new(Vec::new()));
    let transcriber = {
        let seen_paths = Arc::clone(&seen_paths);
        Arc::new(move |request: TranscriptionRequest| {
            let seen_paths = Arc::clone(&seen_paths);
            Box::pin(async move {
                let path = request.audio_path.to_string_lossy().to_string();
                seen_paths.lock().unwrap().push(path.clone());
                if path == "full-microphone" {
                    Ok(TranscriptionProviderResult {
                        text: "quiet but usable speech".to_string(),
                        language: None,
                        provider: "test".to_string(),
                    })
                } else {
                    Err(AppError::new("no_speech", "no_speech"))
                }
            }) as TranscriptionFuture
        }) as TurnTranscriber
    };

    let outcome = transcribe_turn_jobs_by_source_lane(
        vec![segmented_test_job(
            "microphone-segment",
            "full-microphone",
            "microphone",
            0,
        )],
        crate::providers::OPENAI_PROVIDER.to_string(),
        "Meeting".to_string(),
        None,
        transcriber,
    )
    .await
    .expect("source lane should retry full source audio");

    assert_eq!(outcome.failures.len(), 0);
    assert_eq!(outcome.candidates.len(), 1);
    assert_eq!(outcome.candidates[0].input.text, "quiet but usable speech");
    assert_eq!(
        seen_paths.lock().unwrap().as_slice(),
        ["microphone-segment", "full-microphone"]
    );
}

#[test]
fn transcription_failure_messages_hide_provider_codes() {
    assert_eq!(
        user_facing_transcription_failure_message("june_request_failed", "no_speech"),
        "No speech detected. Try speaking louder or moving closer to the microphone."
    );
    assert_eq!(
        user_facing_transcription_failure_message(
            "june_request_failed",
            "upstream_provider_failed"
        ),
        "The transcription provider could not process this audio."
    );
    assert_eq!(
        user_facing_transcription_failure_message(
            "june_request_failed",
            "metering_provider_failed"
        ),
        "Billing is temporarily unavailable. Please try again in a moment."
    );
}

#[test]
fn transcript_coverage_counts_normal_turn_spans() {
    let mic_path = PathBuf::from("microphone.wav");
    let coverage = compute_transcript_coverage(
        &[(
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        )],
        &[
            test_audio_turn("mic-artifact", "microphone", mic_path.clone(), 0, 0, 50_000),
            test_audio_turn("mic-artifact", "microphone", mic_path, 1, 60_000, 130_000),
        ],
        &[test_transcript("microphone", 0, 0, 50_000)],
        &[],
    );

    assert_eq!(coverage.total_detected_speech_ms, 120_000);
    assert_eq!(coverage.total_transcribed_ms, 50_000);
    assert_eq!(coverage.total_detected_turns, 2);
    assert_eq!(coverage.total_transcribed_turns, 1);
    assert!(coverage.warning);
}

#[test]
fn transcript_coverage_counts_full_source_sentinel_success_as_covered() {
    let dir =
        std::env::temp_dir().join(format!("os-june-coverage-success-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("microphone.wav");
    write_loud_wav(&mic_path, 16_000, 16_000 * 90);
    let coverage = compute_transcript_coverage(
        &[(
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        )],
        &[test_audio_turn(
            "mic-artifact",
            "microphone",
            mic_path,
            0,
            0,
            0,
        )],
        &[test_transcript("microphone", 0, 0, 0)],
        &[],
    );

    assert_eq!(coverage.total_detected_speech_ms, 0);
    assert_eq!(coverage.total_transcribed_ms, 0);
    assert!(!coverage.warning);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn transcript_coverage_counts_full_source_sentinel_failure_from_wav_duration() {
    let dir =
        std::env::temp_dir().join(format!("os-june-coverage-failure-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("microphone.wav");
    write_loud_wav(&mic_path, 16_000, 16_000 * 90);
    let coverage = compute_transcript_coverage(
        &[(
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        )],
        &[test_audio_turn(
            "mic-artifact",
            "microphone",
            mic_path,
            0,
            0,
            0,
        )],
        &[],
        &[failed_candidate(
            "microphone",
            "The transcription service was unavailable. Please try again.",
            0,
        )],
    );

    assert_eq!(coverage.total_detected_speech_ms, 90_000);
    assert_eq!(coverage.total_transcribed_ms, 0);
    assert_eq!(coverage.total_failed_turns, 1);
    assert!(coverage.warning);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn transcript_coverage_treats_visible_no_speech_sentinel_as_silent() {
    // Microphone no-speech failures stay visible (only system no-speech
    // is suppressed), but a no-speech sentinel is still silence: both
    // detectors agreed there was nothing to transcribe.
    let dir = std::env::temp_dir().join(format!(
        "os-june-coverage-nospeech-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("microphone.wav");
    write_loud_wav(&mic_path, 16_000, 16_000 * 90);
    let coverage = compute_transcript_coverage(
        &[(
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        )],
        &[test_audio_turn(
            "mic-artifact",
            "microphone",
            mic_path,
            0,
            0,
            0,
        )],
        &[],
        &[failed_candidate(
            "microphone",
            "No speech detected. Try speaking louder or moving closer to the microphone.",
            0,
        )],
    );

    assert_eq!(coverage.total_detected_speech_ms, 0);
    assert_eq!(coverage.total_transcribed_ms, 0);
    assert_eq!(coverage.total_failed_turns, 1);
    assert!(!coverage.warning);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn transcript_coverage_treats_suppressed_silent_sentinel_as_no_detected_speech() {
    // A muted microphone in a dual-source meeting: sentinel turn, no
    // persisted row, and the no-speech failure was suppressed (not
    // visible). The silent source must not warn.
    let dir =
        std::env::temp_dir().join(format!("os-june-coverage-silent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("microphone.wav");
    write_loud_wav(&mic_path, 16_000, 16_000 * 90);
    let coverage = compute_transcript_coverage(
        &[(
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        )],
        &[test_audio_turn(
            "mic-artifact",
            "microphone",
            mic_path,
            0,
            0,
            0,
        )],
        &[],
        &[],
    );

    assert_eq!(coverage.total_detected_speech_ms, 0);
    assert_eq!(coverage.total_transcribed_ms, 0);
    assert_eq!(coverage.total_failed_turns, 0);
    assert!(!coverage.warning);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn transcript_coverage_excludes_unknown_duration_sentinel_failure() {
    let missing_path = PathBuf::from("missing.wav");
    let coverage = compute_transcript_coverage(
        &[(
            "mic-artifact".to_string(),
            "microphone".to_string(),
            missing_path.clone(),
        )],
        &[test_audio_turn(
            "mic-artifact",
            "microphone",
            missing_path,
            0,
            0,
            0,
        )],
        &[],
        &[],
    );

    assert_eq!(coverage.total_detected_speech_ms, 0);
    assert_eq!(coverage.total_transcribed_ms, 0);
    assert!(!coverage.warning);
}

#[test]
fn transcript_coverage_clamps_invalid_spans() {
    let mic_path = PathBuf::from("microphone.wav");
    let coverage = compute_transcript_coverage(
        &[(
            "mic-artifact".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        )],
        &[test_audio_turn(
            "mic-artifact",
            "microphone",
            mic_path,
            0,
            40_000,
            10_000,
        )],
        &[test_transcript("microphone", 0, 50_000, 45_000)],
        &[],
    );

    assert_eq!(coverage.total_detected_speech_ms, 0);
    assert_eq!(coverage.total_transcribed_ms, 0);
    assert!(!coverage.warning);
}

#[test]
fn transcript_coverage_warning_requires_ratio_and_absolute_floor() {
    assert!(transcript_coverage_warning(300_000, 239_999));
    assert!(!transcript_coverage_warning(300_000, 240_000));
    assert!(!transcript_coverage_warning(100_000, 41_000));
    assert!(transcript_coverage_warning(100_000, 40_000));
}

#[test]
fn source_failure_summary_suppresses_silent_system_when_microphone_failed() {
    let summary = source_failure_summary(&[
        FailedTranscriptCandidate {
            artifact_id: "mic".to_string(),
            input: SourceTranscriptInput {
                source: "microphone".to_string(),
                text: String::new(),
                valid: false,
                warning: Some(
                    "The transcription provider could not process this audio.".to_string(),
                ),
                start_ms: Some(0),
                end_ms: Some(0),
                turn_index: Some(0),
            },
        },
        FailedTranscriptCandidate {
            artifact_id: "system".to_string(),
            input: SourceTranscriptInput {
                source: "system".to_string(),
                text: String::new(),
                valid: false,
                warning: Some(
                    "No speech detected. Try speaking louder or moving closer to the microphone."
                        .to_string(),
                ),
                start_ms: Some(0),
                end_ms: Some(0),
                turn_index: Some(1),
            },
        },
    ]);

    assert_eq!(
        summary.as_deref(),
        Some("Microphone: The transcription provider could not process this audio.")
    );
}

#[test]
fn drops_silent_system_failure_once_a_source_succeeded() {
    // Solo mic recording: the system track is silent. With a valid
    // transcript present, that no_speech must not be recorded as a
    // per-source error (it rendered as a spurious "System" card).
    assert!(!should_record_source_failure(
        "system",
        "No speech detected. Try speaking louder or moving closer to the microphone.",
        true,
    ));
}

#[test]
fn keeps_invalid_service_response_failure_once_a_source_succeeded() {
    assert!(should_record_source_failure(
        "microphone",
        "The processing service returned an invalid response.",
        true,
    ));
}

#[test]
fn keeps_invalid_service_response_failure_when_nothing_succeeded() {
    assert!(should_record_source_failure(
        "microphone",
        "The processing service returned an invalid response.",
        false,
    ));
}

#[test]
fn keeps_system_failure_when_nothing_else_succeeded() {
    // Everything failed (e.g. system-only capture of silence): keep it so
    // the user learns the recording produced nothing.
    assert!(should_record_source_failure("system", "no_speech", false));
}

#[test]
fn keeps_non_no_speech_system_failures() {
    // A real provider error on the system track is still worth surfacing.
    assert!(should_record_source_failure(
        "system",
        "The transcription provider could not process this audio.",
        true,
    ));
}

#[test]
fn no_speech_failures_do_not_block_partial_note_generation() {
    let visible = visible_transcription_failures(
        &[failed_candidate(
            "microphone",
            "No speech detected. Try speaking louder or moving closer to the microphone.",
            2,
        )],
        true,
    );

    assert_eq!(visible.len(), 1);
    assert!(blocking_transcription_failure_summary(&visible).is_none());
}

#[test]
fn invalid_turn_failures_block_partial_note_generation() {
    let visible = visible_transcription_failures(
        &[failed_candidate(
            "microphone",
            "The processing service returned an invalid response.",
            5,
        )],
        true,
    );

    assert_eq!(
        blocking_transcription_failure_summary(&visible).as_deref(),
        Some("Microphone: The processing service returned an invalid response.")
    );
}

#[test]
fn never_drops_microphone_failures() {
    assert!(should_record_source_failure(
        "microphone",
        "no_speech",
        true
    ));
}

fn write_test_wav(path: &std::path::Path, samples: &[i16]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for sample in samples {
        writer.write_sample(*sample).unwrap();
    }
    writer.finalize().unwrap();
}

/// Loud tone, above the silence floor, so every chunk survives the local
/// silence prefilter and reaches the (mock) transcriber.
fn write_loud_wav(path: &std::path::Path, sample_rate: u32, sample_count: usize) {
    write_segmented_wav(path, sample_rate, &[(sample_count, 20_000)]);
}

/// Writes consecutive `(frame_count, amplitude)` segments. Amplitude `0`
/// yields a silent span; a large amplitude yields an audible tone.
fn write_segmented_wav(path: &std::path::Path, sample_rate: u32, segments: &[(usize, i16)]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for (count, amplitude) in segments {
        for index in 0..*count {
            let sample = if index % 2 == 0 {
                *amplitude
            } else {
                -*amplitude
            };
            writer.write_sample(sample).unwrap();
        }
    }
    writer.finalize().unwrap();
}

#[test]
fn is_no_speech_error_detects_no_speech_conditions() {
    assert!(is_no_speech_error(&AppError::new("no_speech", "no_speech")));
    assert!(is_no_speech_error(&AppError::new(
        "june_request_failed",
        "no_speech"
    )));
    assert!(!is_no_speech_error(&AppError::new(
        "june_api_response_invalid",
        "The processing service returned an invalid response."
    )));
}

#[tokio::test]
async fn multi_chunk_turn_keeps_earlier_text_when_trailing_chunk_has_no_speech() {
    // A 31s turn splits into a 30s chunk-0 and a ~1s chunk-1. The trailing
    // chunk returns no-speech; the turn must still succeed with chunk-0's
    // text instead of aborting and discarding it.
    let dir = std::env::temp_dir().join(format!("os-june-chunk-nospeech-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let audio_path = dir.join("turn.wav");
    write_loud_wav(&audio_path, 16_000, 16_000 * 31);

    let transcriber = Arc::new(move |request: TranscriptionRequest| {
        Box::pin(async move {
            if request.operation_id().ends_with("-chunk-0") {
                Ok(TranscriptionProviderResult {
                    text: "first chunk speech".to_string(),
                    language: Some("en".to_string()),
                    provider: "test".to_string(),
                })
            } else {
                Err(AppError::new("no_speech", "no_speech"))
            }
        }) as TranscriptionFuture
    }) as TurnTranscriber;

    let result = transcribe_prepared_audio(
        transcriber,
        TranscribePreparedAudioRequest {
            provider: "test".to_string(),
            audio_path,
            temp_dir: dir.clone(),
            chunk_stem: "turn-0".to_string(),
            title: "Meeting".to_string(),
            base_context: None,
            operation_id: "turn-0".to_string(),
            source: "microphone".to_string(),
            start_ms: Some(0),
            end_ms: Some(31_000),
            turn_index: Some(0),
            max_chunk_ms: MAX_TRANSCRIPTION_CHUNK_MS,
            counts_toward_note_progress: false,
        },
    )
    .await
    .expect("a trailing no-speech chunk must not fail the whole turn");

    assert_eq!(result.text, "first chunk speech");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn multi_chunk_turn_reports_no_speech_when_every_chunk_is_silent() {
    // When no chunk has speech, the turn must fail as a no-speech condition
    // so it stays non-blocking — not a generic error that fails the note.
    let dir =
        std::env::temp_dir().join(format!("os-june-chunk-allsilent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let audio_path = dir.join("turn.wav");
    write_loud_wav(&audio_path, 16_000, 16_000 * 31);

    let transcriber = Arc::new(move |_request: TranscriptionRequest| {
        Box::pin(async move { Err(AppError::new("no_speech", "no_speech")) }) as TranscriptionFuture
    }) as TurnTranscriber;

    let error = transcribe_prepared_audio(
        transcriber,
        TranscribePreparedAudioRequest {
            provider: "test".to_string(),
            audio_path,
            temp_dir: dir.clone(),
            chunk_stem: "turn-0".to_string(),
            title: "Meeting".to_string(),
            base_context: None,
            operation_id: "turn-0".to_string(),
            source: "microphone".to_string(),
            start_ms: Some(0),
            end_ms: Some(31_000),
            turn_index: Some(0),
            max_chunk_ms: MAX_TRANSCRIPTION_CHUNK_MS,
            counts_toward_note_progress: false,
        },
    )
    .await
    .expect_err("an all-silent turn must fail");

    assert!(
        is_no_speech_error(&error),
        "all-silent turn must stay a non-blocking no-speech failure, got code={} message={}",
        error.code,
        error.message
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn silent_chunks_are_skipped_before_reaching_the_transcriber() {
    // 62s: loud 0-30s, silent 30-60s, loud 60-62s -> chunks 0 and 2 audible,
    // chunk 1 silent. The silent chunk must never reach the API (no credit
    // hold), while both audible chunks are transcribed.
    let dir =
        std::env::temp_dir().join(format!("os-june-chunk-silentskip-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let audio_path = dir.join("turn.wav");
    write_segmented_wav(
        &audio_path,
        16_000,
        &[
            (16_000 * 30, 20_000),
            (16_000 * 30, 0),
            (16_000 * 2, 20_000),
        ],
    );

    let calls = Arc::new(AtomicUsize::new(0));
    let transcriber = {
        let calls = Arc::clone(&calls);
        Arc::new(move |_request: TranscriptionRequest| {
            let calls = Arc::clone(&calls);
            Box::pin(async move {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                Ok(TranscriptionProviderResult {
                    text: format!("chunk text {n}"),
                    language: None,
                    provider: "test".to_string(),
                })
            }) as TranscriptionFuture
        }) as TurnTranscriber
    };

    let result = transcribe_prepared_audio(
        transcriber,
        TranscribePreparedAudioRequest {
            provider: "test".to_string(),
            audio_path,
            temp_dir: dir.clone(),
            chunk_stem: "turn-0".to_string(),
            title: "Meeting".to_string(),
            base_context: None,
            operation_id: "turn-0".to_string(),
            source: "microphone".to_string(),
            start_ms: Some(0),
            end_ms: Some(62_000),
            turn_index: Some(0),
            max_chunk_ms: MAX_TRANSCRIPTION_CHUNK_MS,
            counts_toward_note_progress: false,
        },
    )
    .await
    .expect("audible chunks should transcribe");

    // Only the two audible chunks reach the API; the silent middle is skipped.
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(result.text, "chunk text 0\nchunk text 1");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn drops_silent_system_source_but_keeps_microphone() {
    let dir = std::env::temp_dir().join(format!("os-june-drop-silent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("microphone.wav");
    let system_path = dir.join("system.wav");
    write_test_wav(&mic_path, &[20_000, -18_000, 19_000, -20_000]);
    write_test_wav(&system_path, &[0, 0, 0, 0, 1, -1]);

    let kept = drop_silent_system_sources(vec![
        (
            "mic".to_string(),
            "microphone".to_string(),
            mic_path.clone(),
        ),
        ("sys".to_string(), "system".to_string(), system_path),
    ]);

    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].1, "microphone");

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn keeps_silent_system_source_when_it_is_the_only_one() {
    let dir = std::env::temp_dir().join(format!("os-june-drop-silent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let system_path = dir.join("system.wav");
    write_test_wav(&system_path, &[0, 0, 0, 0]);

    let kept =
        drop_silent_system_sources(vec![("sys".to_string(), "system".to_string(), system_path)]);

    // System-only capture of silence must survive so its "no speech"
    // failure still reaches the user.
    assert_eq!(kept.len(), 1);

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn keeps_quiet_system_source_between_detection_and_silence_floors() {
    let dir = std::env::temp_dir().join(format!("os-june-drop-silent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("microphone.wav");
    let system_path = dir.join("system.wav");
    write_test_wav(&mic_path, &[20_000, -18_000]);
    // ~0.008 RMS: detectable by the system lane (min_rms 0.006) but under the
    // 0.012 normalized-chunk silence floor. Must survive the pre-filter so the
    // full-source fallback can still transcribe it.
    let amplitude = (0.008 * i16::MAX as f32).round() as i16;
    let quiet = vec![amplitude; 48_000];
    write_test_wav(&system_path, &quiet);

    let kept = drop_silent_system_sources(vec![
        ("mic".to_string(), "microphone".to_string(), mic_path),
        ("sys".to_string(), "system".to_string(), system_path.clone()),
    ]);

    assert_eq!(kept.len(), 2);
    // The old 0.012 floor still judges it silent — the chunk-skip guard is
    // intentionally left stricter than the pre-filter.
    assert!(crate::audio::turns::source_is_effectively_silent(
        &system_path
    ));

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn keeps_audible_system_source() {
    let dir = std::env::temp_dir().join(format!("os-june-drop-silent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mic_path = dir.join("microphone.wav");
    let system_path = dir.join("system.wav");
    write_test_wav(&mic_path, &[20_000, -18_000]);
    write_test_wav(&system_path, &[15_000, -16_000, 14_000]);

    let kept = drop_silent_system_sources(vec![
        ("mic".to_string(), "microphone".to_string(), mic_path),
        ("sys".to_string(), "system".to_string(), system_path),
    ]);

    assert_eq!(kept.len(), 2);

    let _ = std::fs::remove_dir_all(dir);
}

fn test_job(path: &str, source: &str, turn_index: i64) -> TurnTranscriptionJob {
    TurnTranscriptionJob {
        artifact_id: format!("artifact-{path}"),
        source: source.to_string(),
        audio_path: PathBuf::from(path),
        temp_dir: std::env::temp_dir(),
        source_path: PathBuf::from(path),
        covers_full_source: true,
        source_fallback: false,
        echo_trimmed: false,
        start_ms: turn_index * 1_000,
        end_ms: turn_index * 1_000 + 500,
        turn_index,
    }
}

#[test]
fn echo_trimmed_lane_never_falls_back_to_the_full_source() {
    // If every kept remainder of an echo-trimmed microphone lane fails to
    // transcribe, retrying with the raw full-source file would transcribe
    // the trimmed bleed verbatim — the misattribution the trim removed.
    let mut jobs = vec![segmented_test_job(
        "remainder.wav",
        "microphone.wav",
        "microphone",
        0,
    )];
    assert!(full_source_fallback_job(&jobs).is_some());

    jobs[0].echo_trimmed = true;
    assert!(full_source_fallback_job(&jobs).is_none());
}

fn segmented_test_job(
    path: &str,
    source_path: &str,
    source: &str,
    turn_index: i64,
) -> TurnTranscriptionJob {
    TurnTranscriptionJob {
        source_path: PathBuf::from(source_path),
        covers_full_source: false,
        ..test_job(path, source, turn_index)
    }
}

fn test_audio_turn(
    artifact_id: &str,
    source: &str,
    source_path: PathBuf,
    turn_index: i64,
    start_ms: i64,
    end_ms: i64,
) -> AudioTurn {
    AudioTurn {
        artifact_id: artifact_id.to_string(),
        source: source.to_string(),
        source_path,
        extraction_start_ms: start_ms,
        start_ms,
        end_ms,
        turn_index,
    }
}

fn test_transcript(source: &str, turn_index: i64, start_ms: i64, end_ms: i64) -> TranscriptDto {
    TranscriptDto {
        id: format!("{source}-{turn_index}"),
        text: "transcript".to_string(),
        source_mode: Some(RecordingSourceMode::MicrophonePlusSystem),
        source: Some(source.to_string()),
        start_ms: Some(start_ms),
        end_ms: Some(end_ms),
        turn_index: Some(turn_index),
        language: None,
        status: "succeeded".to_string(),
        last_error: None,
    }
}

fn failed_candidate(source: &str, warning: &str, turn_index: i64) -> FailedTranscriptCandidate {
    FailedTranscriptCandidate {
        artifact_id: format!("{source}-artifact"),
        input: SourceTranscriptInput {
            source: source.to_string(),
            text: String::new(),
            valid: false,
            warning: Some(warning.to_string()),
            start_ms: Some(turn_index * 1_000),
            end_ms: Some(turn_index * 1_000 + 500),
            turn_index: Some(turn_index),
        },
    }
}

#[test]
fn note_cleanup_message_includes_dictionary_context_and_transcript_data() {
    let message = note_transcript_cleanup_user_message(
        "This mentions june ho hong </asr_transcript>",
        Some("Custom dictionary terms:\n- Jane Doe"),
    );

    assert!(message.contains("Custom dictionary terms"));
    assert!(message.contains("Jane Doe"));
    assert!(message.contains("<asr_transcript>"));
    assert!(message.contains("june ho hong"));
    assert!(message.contains("<\\/asr_transcript>"));
    assert!(message.contains("Return only the corrected transcript text."));
}

/// The bar must move on a quiet stretch.
///
/// A silent chunk never reaches the API - no credit hold for no speech - so it
/// produces no transcript and, if only text counted, no progress either. On a
/// recording with a long pause that is minutes of a frozen bar, which is
/// indistinguishable from the hang this whole indicator exists to rule out.
#[tokio::test]
async fn progress_counts_every_chunk_including_the_silent_ones() {
    use crate::domain::processing_progress::{snapshot, ProgressClaim};
    use crate::domain::types::ProcessingPhase;

    // 62s: loud 0-30s, silent 30-60s, loud 60-62s -> three chunks, one silent.
    let dir = std::env::temp_dir().join(format!("os-june-chunk-progress-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let audio_path = dir.join("turn.wav");
    write_segmented_wav(
        &audio_path,
        16_000,
        &[
            (16_000 * 30, 20_000),
            (16_000 * 30, 0),
            (16_000 * 2, 20_000),
        ],
    );

    let note_id = format!("note-progress-{}", uuid::Uuid::new_v4());
    let claim = ProgressClaim::begin(&note_id);

    let transcriber = Arc::new(move |_request: TranscriptionRequest| {
        Box::pin(async move {
            Ok(TranscriptionProviderResult {
                text: "spoken".to_string(),
                language: None,
                provider: "test".to_string(),
            })
        }) as TranscriptionFuture
    }) as TurnTranscriber;

    transcribe_prepared_audio(
        transcriber,
        TranscribePreparedAudioRequest {
            provider: "test".to_string(),
            audio_path,
            temp_dir: dir.clone(),
            chunk_stem: "note".to_string(),
            title: "Meeting".to_string(),
            base_context: None,
            // On the microphone-only path the operation id is the note id,
            // which is how the chunk loop finds the cell to count into.
            operation_id: note_id.clone(),
            source: "microphone".to_string(),
            start_ms: None,
            end_ms: None,
            turn_index: None,
            max_chunk_ms: MAX_TRANSCRIPTION_CHUNK_MS,
            counts_toward_note_progress: true,
        },
    )
    .await
    .unwrap();

    let seen = snapshot(&note_id).expect("the run is still claimed");
    assert_eq!(seen.phase, ProcessingPhase::Transcribing);
    assert_eq!(
        (seen.done, seen.total),
        (3, Some(3)),
        "all three chunks are done, including the silent one nobody transcribed"
    );

    drop(claim);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A turn's chunks are not the note's progress: the multi-source path counts
/// turns, through the sink, and a turn that happened to be long enough to
/// split must not also advance the note's count from inside.
#[tokio::test]
async fn a_turns_own_chunks_do_not_touch_the_notes_count() {
    use crate::domain::processing_progress::{snapshot, ProgressClaim};

    let dir = std::env::temp_dir().join(format!("os-june-turn-progress-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let audio_path = dir.join("turn.wav");
    write_segmented_wav(&audio_path, 16_000, &[(16_000 * 40, 20_000)]);

    let note_id = format!("note-turnchunks-{}", uuid::Uuid::new_v4());
    let claim = ProgressClaim::begin(&note_id);
    claim.handle().total(7);

    let transcriber = Arc::new(move |_request: TranscriptionRequest| {
        Box::pin(async move {
            Ok(TranscriptionProviderResult {
                text: "spoken".to_string(),
                language: None,
                provider: "test".to_string(),
            })
        }) as TranscriptionFuture
    }) as TurnTranscriber;

    transcribe_prepared_audio(
        transcriber,
        TranscribePreparedAudioRequest {
            provider: "test".to_string(),
            audio_path,
            temp_dir: dir.clone(),
            chunk_stem: "turn-0".to_string(),
            title: "Meeting".to_string(),
            base_context: None,
            operation_id: note_id.clone(),
            source: "microphone".to_string(),
            start_ms: Some(0),
            end_ms: Some(40_000),
            turn_index: Some(0),
            max_chunk_ms: MAX_TRANSCRIPTION_CHUNK_MS,
            counts_toward_note_progress: false,
        },
    )
    .await
    .unwrap();

    let seen = snapshot(&note_id).expect("the run is still claimed");
    assert_eq!(
        (seen.done, seen.total),
        (0, Some(7)),
        "the turn's own chunks left the note's count alone"
    );

    drop(claim);
    let _ = std::fs::remove_dir_all(&dir);
}
