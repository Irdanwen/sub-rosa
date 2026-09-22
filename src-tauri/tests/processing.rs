// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::domain::{
    processing::manual_notes_for_generation,
    types::{NoteDto, ProcessingPhase, ProcessingProgressDto, ProcessingStatus},
};

const NOW: &str = "2026-05-21T10:00:00Z";

fn note(overrides: impl FnOnce(&mut NoteDto)) -> NoteDto {
    let mut note = NoteDto {
        id: "note-1".to_string(),
        title: "Note".to_string(),
        preview: String::new(),
        processing_status: ProcessingStatus::Ready,
        folder_ids: Vec::new(),
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
        duration_ms: None,
        generated_content: None,
        edited_content: None,
        transcript: None,
        transcript_coverage: None,
        source_transcripts: Vec::new(),
        recording: None,
        audio: None,
        audio_sources: Vec::new(),
        active_tab: Some("notes".to_string()),
        last_error: None,
        queued_recordings: 0,
        live: Default::default(),
        calendar_event_id: None,
        scheduled_start: None,
        attendees: Vec::new(),
    };
    overrides(&mut note);
    note
}

#[test]
fn manual_notes_for_generation_uses_only_new_text_after_generated_note() {
    let note = note(|note| {
        note.generated_content = Some("First generated note".to_string());
        note.edited_content =
            Some("First generated note\n\nManual note for the next recording".to_string());
    });

    assert_eq!(
        manual_notes_for_generation(&note).as_deref(),
        Some("Manual note for the next recording")
    );
}

#[test]
fn manual_notes_for_generation_ignores_existing_edited_note_body() {
    let note = note(|note| {
        note.generated_content = Some("First generated note".to_string());
        note.edited_content = Some("Edited version of the first generated note".to_string());
    });

    assert_eq!(manual_notes_for_generation(&note), None);
}

#[test]
fn manual_notes_for_generation_uses_new_tail_after_manual_preface() {
    let note = note(|note| {
        note.generated_content = Some("- Generated transcript note".to_string());
        note.edited_content = Some("Test 1:\n\n- Generated transcript note\n\nTest 2".to_string());
    });

    assert_eq!(
        manual_notes_for_generation(&note).as_deref(),
        Some("Test 2")
    );
}

#[test]
fn manual_notes_for_generation_uses_preface_when_generated_note_was_appended_below_it() {
    let note = note(|note| {
        note.generated_content = Some("Generated note body".to_string());
        note.edited_content =
            Some("Manual notes from recording\n\nGenerated note body".to_string());
    });

    assert_eq!(
        manual_notes_for_generation(&note).as_deref(),
        Some("Manual notes from recording")
    );
}

#[tokio::test]
async fn generation_rejects_empty_transcript() {
    let err = os_june_lib::june_api::generate_note_from_transcript(
        os_june_lib::june_api::GenerationRequest {
            provider: "venice".to_string(),
            operation_id: None,
            title: "Empty".to_string(),
            existing_generated_note: None,
            transcript: "   ".to_string(),
            transcript_source_labels: false,
            manual_notes: None,
            language: None,
        },
    )
    .await
    .expect_err("empty transcript should fail");

    assert_eq!(err.code, "transcription_empty");
}

/// The live fields are grouped in Rust (`NoteDto::live`) but the screen reads
/// them as two plain fields on the note. `#[serde(flatten)]` is the only thing
/// holding that shape, and nothing else would notice if it went: the frontend
/// would silently see no progress and no stalled flag, ever.
#[test]
fn live_note_fields_travel_as_plain_fields_on_the_note() {
    let note = note(|note| {
        note.processing_status = ProcessingStatus::Transcribing;
        note.live.processing_stalled = true;
        note.live.processing_progress = Some(ProcessingProgressDto {
            phase: ProcessingPhase::Transcribing,
            done: 12,
            total: Some(31),
            started_at: NOW.to_string(),
            phase_started_at: NOW.to_string(),
        });
    });

    let json = serde_json::to_value(&note).unwrap();
    assert!(
        json.get("live").is_none(),
        "the grouping must not leak onto the wire"
    );
    assert_eq!(json["processingStalled"], serde_json::json!(true));
    assert_eq!(
        json["processingProgress"]["phase"],
        serde_json::json!("transcribing")
    );
    assert_eq!(json["processingProgress"]["done"], serde_json::json!(12));
    assert_eq!(json["processingProgress"]["total"], serde_json::json!(31));
    assert_eq!(
        json["processingProgress"]["startedAt"],
        serde_json::json!(NOW)
    );

    // And a note with nothing running says so by omission, not with a null.
    let idle = serde_json::to_value(note_idle()).unwrap();
    assert!(idle.get("processingProgress").is_none());
    assert_eq!(idle["processingStalled"], serde_json::json!(false));
}

fn note_idle() -> NoteDto {
    note(|_| {})
}
