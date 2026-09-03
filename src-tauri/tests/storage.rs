// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;
use tempfile::tempdir;

async fn test_repositories() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite should open");
    run_migrations(&pool).await.expect("migrations should run");
    Repositories::new(pool)
}

#[tokio::test]
async fn migrations_create_empty_store() {
    let repos = test_repositories().await;

    let folders = repos
        .list_folders()
        .await
        .expect("folders list should load");
    let notes = repos
        .list_notes(None, 50, None)
        .await
        .expect("notes list should load");

    assert!(folders.is_empty());
    assert!(notes.items.is_empty());
}

#[tokio::test]
async fn migrations_tolerate_concurrent_startup() {
    let dir = tempdir().expect("tempdir");
    let database_path = dir.path().join("notes.sqlite3");
    let url = format!("sqlite://{}", database_path.display());
    let mut handles = Vec::new();

    for _ in 0..8 {
        let url = url.clone();
        handles.push(tokio::spawn(async move {
            let options = SqliteConnectOptions::from_str(&url)
                .expect("sqlite options")
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(2)
                .connect_with(options)
                .await
                .expect("sqlite file should open");
            run_migrations(&pool).await
        }));
    }

    for handle in handles {
        handle
            .await
            .expect("migration task should finish")
            .expect("concurrent migrations should be idempotent");
    }
}

#[tokio::test]
async fn creates_notes_in_reverse_chronological_order() {
    let repos = test_repositories().await;

    let first = repos.create_note(None).await.expect("first note");
    let second = repos.create_note(None).await.expect("second note");

    let notes = repos
        .list_notes(None, 50, None)
        .await
        .expect("notes list should load");

    assert_eq!(notes.items.len(), 2);
    assert_eq!(notes.items[0].id, second.id);
    assert_eq!(notes.items[1].id, first.id);
}

#[tokio::test]
async fn creates_folders_and_assigns_notes_without_removing_all_notes_visibility() {
    let repos = test_repositories().await;
    let folder = repos
        .create_folder("Field Notes", None)
        .await
        .expect("folder should be created");
    let note = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note should be created");

    let all_notes = repos
        .list_notes(None, 50, None)
        .await
        .expect("all notes should load");
    let folder_notes = repos
        .list_notes(Some(folder.id.clone()), 50, None)
        .await
        .expect("folder notes should load");

    assert_eq!(
        all_notes
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        vec![&note.id]
    );
    assert_eq!(
        folder_notes
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<Vec<_>>(),
        vec![&note.id]
    );
    assert_eq!(folder_notes.items[0].folder_ids, vec![folder.id]);
}

#[tokio::test]
async fn deletes_note_and_removes_folder_assignment() {
    let repos = test_repositories().await;
    let folder = repos.create_folder("Calls", None).await.expect("folder");
    let note = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note");

    repos.delete_note(&note.id).await.expect("delete note");

    let all_notes = repos
        .list_notes(None, 50, None)
        .await
        .expect("all notes should load");
    let folder_notes = repos
        .list_notes(Some(folder.id), 50, None)
        .await
        .expect("folder notes should load");

    assert!(all_notes.items.is_empty());
    assert!(folder_notes.items.is_empty());
}

/// Settings › Storage may delete the audio of a note that is done with it:
/// the note reached `ready`, the artifact is older than the cutoff, it has a
/// transcript of its own, and it was not purged before. Each of those is a
/// condition a person's recordings depend on, so each has a case.
#[tokio::test]
async fn only_transcribed_ready_recordings_older_than_the_cutoff_are_purgeable() {
    use os_june_lib::domain::types::{ProcessingStatus, RecordingSourceMode};

    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    os_june_lib::db::migrations::run_migrations(&pool)
        .await
        .expect("migrations");
    let repos = os_june_lib::db::repositories::Repositories::new(pool);

    async fn note_with_recording(
        repos: &os_june_lib::db::repositories::Repositories,
        transcribed: bool,
        status: ProcessingStatus,
    ) -> (String, String) {
        let note = repos.create_note(None).await.expect("note");
        let session_id = format!("session-{}", note.id);
        repos
            .create_recording_session(
                &note.id,
                &session_id,
                RecordingSourceMode::MicrophoneOnly,
                "/tmp/partial.wav",
                "/tmp/session.wav",
                None,
            )
            .await
            .expect("session");
        let artifact = repos
            .create_audio_artifact(&note.id, &session_id, "/tmp/mic.wav", 1_000, 4_096, "sum")
            .await
            .expect("artifact");
        if transcribed {
            repos
                .create_source_transcript(
                    &note.id,
                    &session_id,
                    &artifact.id,
                    RecordingSourceMode::MicrophoneOnly,
                    "microphone",
                    "hello",
                    None,
                    "test",
                    Some(0),
                    Some(1_000),
                    Some(0),
                )
                .await
                .expect("transcript");
        }
        repos
            .set_note_status(&note.id, status, None)
            .await
            .expect("status");
        (note.id, artifact.id)
    }

    let (_ready_note, ready_artifact) =
        note_with_recording(&repos, true, ProcessingStatus::Ready).await;
    let (_untranscribed, _) = note_with_recording(&repos, false, ProcessingStatus::Ready).await;
    let (_still_working, _) =
        note_with_recording(&repos, true, ProcessingStatus::Transcribing).await;

    // A cutoff in the future makes every artifact "old enough"; the other
    // conditions decide.
    let future = "2999-01-01T00:00:00Z";
    let purgeable = repos.purgeable_recordings(future).await.expect("query");
    assert_eq!(
        purgeable
            .iter()
            .map(|p| p.artifact_id.as_str())
            .collect::<Vec<_>>(),
        vec![ready_artifact.as_str()],
        "{purgeable:#?}"
    );
    assert_eq!(purgeable[0].size_bytes, 4_096);

    // A cutoff in the past leaves everything alone.
    let past = "2000-01-01T00:00:00Z";
    assert!(repos
        .purgeable_recordings(past)
        .await
        .expect("query")
        .is_empty());

    // Once purged, an artifact is never offered again.
    repos
        .mark_audio_artifact_purged(&ready_artifact)
        .await
        .expect("mark");
    assert!(repos
        .purgeable_recordings(future)
        .await
        .expect("query")
        .is_empty());
}
