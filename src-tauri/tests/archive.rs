//! The archive round-trips, and a passphrase means what it says.
//!
//! Export into bytes, restore into an empty database, compare: the same rows
//! and the same note bodies. Then the two properties a person actually
//! relies on: importing twice changes nothing, and a sealed archive refuses
//! the wrong passphrase rather than yielding garbage.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::archive::{apply, is_sealed, read_tar, seal, unseal, write_tar, ExportOptions};
use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_june_lib::domain::types::MemorySource;
use sqlx_sqlite::SqlitePoolOptions;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    Repositories::new(pool)
}

async fn seed(repos: &Repositories) -> (String, String) {
    let folder = repos.create_folder("Projets", None).await.expect("folder");
    let note = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note");
    repos
        .update_note(
            &note.id,
            Some("Réunion trésorerie".into()),
            Some("## Décisions\n\nOn migre vers **Xylophone** lundi.\n".into()),
            None,
        )
        .await
        .expect("update");
    repos
        .insert_memory("Prefers meetings before 10am", MemorySource::Manual, 3)
        .await
        .expect("memory");
    (note.id, folder.id)
}

fn options() -> ExportOptions {
    ExportOptions {
        app_version: "1.59.0-test".into(),
        include_recordings: false,
        recordings_dir: None,
    }
}

#[tokio::test]
async fn an_archive_restores_the_same_notes_folders_and_memories() {
    let source = repos().await;
    let (note_id, folder_id) = seed(&source).await;
    let mut bytes = Vec::new();
    let manifest = write_tar(&source.pool, &options(), &mut bytes)
        .await
        .expect("write");
    assert_eq!(manifest.format, 1);
    assert!(!manifest.includes_recordings);

    let archive = read_tar(bytes.as_slice()).expect("read");
    assert_eq!(archive.tables["notes"].len(), 1);
    assert_eq!(archive.tables["memories"].len(), 1);

    let target = repos().await;
    let summary = apply(&target.pool, &archive, None).await.expect("apply");
    assert_eq!(summary.notes, 1);
    assert!(summary.rows >= 4, "{summary:?}");

    let restored = target.get_note(&note_id).await.expect("note back");
    assert_eq!(restored.title, "Réunion trésorerie");
    assert!(restored
        .edited_content
        .as_deref()
        .unwrap_or_default()
        .contains("Xylophone"));
    assert_eq!(restored.folder_ids, vec![folder_id]);
    let memories = target.list_memories().await.expect("memories");
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].text, "Prefers meetings before 10am");

    // The Markdown copy is in the archive for a reader without this app.
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("title: Réunion trésorerie"));
}

#[tokio::test]
async fn importing_twice_changes_nothing() {
    let source = repos().await;
    seed(&source).await;
    let mut bytes = Vec::new();
    write_tar(&source.pool, &options(), &mut bytes)
        .await
        .expect("write");
    let archive = read_tar(bytes.as_slice()).expect("read");
    let target = repos().await;
    apply(&target.pool, &archive, None).await.expect("first");
    apply(&target.pool, &archive, None).await.expect("second");
    let notes = target.list_notes(None, 100, None).await.expect("list");
    assert_eq!(notes.items.len(), 1);
    assert_eq!(target.list_memories().await.expect("memories").len(), 1);
}

#[tokio::test]
async fn a_sealed_archive_opens_with_its_passphrase_and_nothing_else() {
    let source = repos().await;
    seed(&source).await;
    let mut bytes = Vec::new();
    write_tar(&source.pool, &options(), &mut bytes)
        .await
        .expect("write");
    let sealed = seal(&bytes, "correct horse battery staple").expect("seal");
    assert!(is_sealed(&sealed));
    assert!(!is_sealed(&bytes));
    assert!(
        !String::from_utf8_lossy(&sealed).contains("Xylophone"),
        "the sealed bytes must not carry the note in the clear"
    );

    let wrong = unseal(&sealed, "wrong");
    assert!(wrong.is_err());
    assert_eq!(
        wrong.err().map(|e| e.code),
        Some("archive_wrong_passphrase".into())
    );

    let plain = unseal(&sealed, "correct horse battery staple").expect("unseal");
    assert_eq!(plain, bytes);
}

#[tokio::test]
async fn a_file_that_is_not_an_archive_is_refused_by_name() {
    let error = read_tar(b"hello".as_slice()).err().expect("error");
    assert!(
        error.code == "archive_read_failed" || error.code == "archive_invalid",
        "{error:?}"
    );
}
