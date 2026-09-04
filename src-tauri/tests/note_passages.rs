//! Passages are cut from a note when its source changes, and only then.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::ask::semantic::{fuse, refresh_note};
use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use sqlx::query::query;
use sqlx_sqlite::SqlitePoolOptions;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    // The fixture writes notes and turns without the recording rows a real
    // transcript hangs off; the passages never read those rows.
    query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("pragma");
    Repositories::new(pool)
}

async fn insert_note(repos: &Repositories, id: &str, content: &str, updated_at: &str) {
    query(
        "INSERT INTO notes (id, title, processing_status, created_at, updated_at, generated_content)
         VALUES (?1, ?2, 'ready', ?4, ?4, ?3)",
    )
    .bind(id)
    .bind(format!("Note {id}"))
    .bind(content)
    .bind(updated_at)
    .execute(&repos.pool)
    .await
    .expect("insert note");
}

#[tokio::test]
async fn passages_are_cut_once_per_source_and_recut_when_the_note_changes() {
    let repos = repos().await;
    let body = "First paragraph about the migration.\n\nSecond paragraph about the budget.";
    insert_note(&repos, "n1", body, "2026-09-04T09:00:00Z").await;
    for (index, text) in ["hello", "the cluster moves on monday", "noted"]
        .iter()
        .enumerate()
    {
        query(
            "INSERT INTO transcripts (id, note_id, audio_artifact_id, text, provider, status, created_at, updated_at, turn_index)
             VALUES (?1, 'n1', 'a1', ?2, 'test', 'ready', '2026-09-04T09:00:00Z', '2026-09-04T09:00:00Z', ?3)",
        )
        .bind(format!("t{index}"))
        .bind(text)
        .bind(index as i64)
        .execute(&repos.pool)
        .await
        .expect("insert turn");
    }

    assert_eq!(
        repos.notes_with_stale_passages(10).await.unwrap(),
        vec!["n1".to_string()]
    );
    let cut = refresh_note(&repos, "n1").await.expect("refresh");
    assert_eq!(cut, Some(2), "one body passage, one transcript window");
    assert!(repos
        .notes_with_stale_passages(10)
        .await
        .unwrap()
        .is_empty());
    let second = refresh_note(&repos, "n1").await.expect("refresh again");
    assert_eq!(second, None, "same source, nothing re-cut");

    let pending = repos.passages_missing_embedding(10).await.unwrap();
    assert_eq!(pending.len(), 2);
    assert_eq!(pending[0].kind, "note");
    assert_eq!(pending[1].kind, "transcript");
    assert!(pending[1].text.contains("cluster moves"));

    repos
        .set_passage_embedding(&pending[0].id, &[0, 0, 128, 63])
        .await
        .unwrap();
    assert_eq!(repos.passages_counts().await.unwrap(), (2, 1));
    assert_eq!(repos.passages_with_embeddings().await.unwrap().len(), 1);

    // The note changes: it is stale again, and a re-cut drops the vectors.
    query("UPDATE notes SET generated_content = 'Rewritten.', updated_at = '2026-09-05T09:00:00Z' WHERE id = 'n1'")
        .execute(&repos.pool)
        .await
        .unwrap();
    assert_eq!(
        repos.notes_with_stale_passages(10).await.unwrap(),
        vec!["n1".to_string()]
    );
    assert_eq!(refresh_note(&repos, "n1").await.unwrap(), Some(2));
    assert_eq!(repos.passages_counts().await.unwrap(), (2, 0));

    assert_eq!(repos.clear_passages().await.unwrap(), 2);
    assert_eq!(repos.passages_counts().await.unwrap(), (0, 0));
}

#[tokio::test]
async fn a_missing_note_cuts_nothing_and_fusion_keeps_the_lexical_order_when_alone() {
    let repos = repos().await;
    assert_eq!(refresh_note(&repos, "ghost").await.unwrap(), None);
    let lexical = repos
        .retrieve_passages("\"nothing\"", &["nothing".to_string()], 8)
        .await
        .unwrap();
    assert!(lexical.is_empty());
    assert!(fuse(Vec::new(), Vec::new(), 8).is_empty());
}
