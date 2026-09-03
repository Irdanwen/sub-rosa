//! The search that reads the notes (migration 020).
//!
//! Until 2026-09-03 the only search was a substring filter in the webview over
//! the first hundred notes the list had loaded; the hundred-and-first was
//! invisible, and no transcript, memory or past conversation was searched at
//! all. These tests hold the two properties that matter: a word that exists in
//! exactly one row is found wherever that row sits, and it is found fast.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_june_lib::domain::types::{AgentMessageRole, AgentSafetyProfile, MemorySource};
use sqlx::query::query;
use sqlx::row::Row;
use sqlx_sqlite::SqlitePoolOptions;
use std::time::Instant;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    Repositories::new(pool)
}

#[tokio::test]
async fn the_bundled_sqlite_has_fts5() {
    // The whole feature rests on this. If the embedded SQLite ever loses the
    // FTS5 module, this is the test that says so, not a user with a search
    // box that returns nothing.
    let repos = repos().await;
    let rows = query("PRAGMA compile_options")
        .fetch_all(&repos.pool)
        .await
        .expect("compile options");
    let options: Vec<String> = rows.iter().map(|row| row.get::<String, _>(0)).collect();
    assert!(
        options.iter().any(|option| option == "ENABLE_FTS5"),
        "SQLite was built without FTS5: {options:?}"
    );
}

#[tokio::test]
async fn a_word_in_the_thousandth_note_is_found_and_found_fast() {
    let repos = repos().await;
    let mut last_id = String::new();
    for index in 0..1000 {
        let note = repos.create_note(None).await.expect("create note");
        let body = format!("Point d'avancement numéro {index}. Rien de spécial à signaler.");
        repos
            .update_note(&note.id, Some(format!("Réunion {index}")), Some(body), None)
            .await
            .expect("update note");
        last_id = note.id;
    }
    // Only the last note carries the word, and it is the oldest in the
    // list's newest-first order, so it is exactly the note the old
    // hundred-note filter could never reach.
    repos
        .update_note(
            &last_id,
            None,
            Some("Décision : on migre la trésorerie vers Xylophone Capital lundi.".into()),
            None,
        )
        .await
        .expect("update last note");

    let started = Instant::now();
    let hits = repos
        .search_everything("xylophone", 20)
        .await
        .expect("search");
    let elapsed = started.elapsed();

    assert_eq!(hits.len(), 1, "{hits:#?}");
    assert_eq!(hits[0].kind, "note");
    assert_eq!(hits[0].target_id, last_id);
    assert!(
        hits[0].excerpt.contains("\u{1}Xylophone\u{2}"),
        "the excerpt marks the hit: {}",
        hits[0].excerpt
    );
    assert!(
        elapsed.as_millis() < 50,
        "search over a thousand notes took {elapsed:?}"
    );
}

#[tokio::test]
async fn accents_are_folded_and_the_last_term_is_a_prefix() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("create");
    repos
        .update_note(
            &note.id,
            Some("Réunion trésorerie".into()),
            Some("La trésorerie est à l'équilibre.".into()),
            None,
        )
        .await
        .expect("update");

    let plain = repos
        .search_everything("reunion tresor", 5)
        .await
        .expect("search");
    assert_eq!(plain.len(), 1, "unaccented, prefixed terms reach the note");

    let none = repos
        .search_everything("reunion budget", 5)
        .await
        .expect("search");
    assert!(
        none.is_empty(),
        "terms are ANDed: an absent term drops the note"
    );

    let empty = repos.search_everything("   ", 5).await.expect("search");
    assert!(
        empty.is_empty(),
        "blank input returns nothing, not everything"
    );
}

#[tokio::test]
async fn memories_and_conversations_are_searched_too() {
    let repos = repos().await;
    repos
        .insert_memory("Prefers meetings before 10am", MemorySource::Manual, 3)
        .await
        .expect("memory");
    let task = repos
        .create_agent_task(
            "Plan the offsite",
            Some("Offsite planning"),
            AgentSafetyProfile::AutonomousPrivate,
            None,
        )
        .await
        .expect("task");
    repos
        .add_agent_message(
            &task.id,
            AgentMessageRole::Assistant,
            "The venue in Annecy is booked for the offsite.",
        )
        .await
        .expect("message");

    let memory_hits = repos
        .search_everything("meetings", 5)
        .await
        .expect("search");
    assert_eq!(memory_hits.len(), 1);
    assert_eq!(memory_hits[0].kind, "memory");

    let conversation_hits = repos.search_everything("annecy", 5).await.expect("search");
    assert_eq!(conversation_hits.len(), 1);
    assert_eq!(conversation_hits[0].kind, "conversation");
    assert_eq!(conversation_hits[0].target_id, task.id);
    assert_eq!(conversation_hits[0].title, "Offsite planning");
}

#[tokio::test]
async fn a_deleted_note_leaves_the_index() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("create");
    repos
        .update_note(
            &note.id,
            Some("Kumquat".into()),
            Some("kumquat".into()),
            None,
        )
        .await
        .expect("update");
    assert_eq!(
        repos
            .search_everything("kumquat", 5)
            .await
            .expect("search")
            .len(),
        1
    );
    repos.delete_note(&note.id).await.expect("delete");
    assert!(repos
        .search_everything("kumquat", 5)
        .await
        .expect("search")
        .is_empty());
}

#[tokio::test]
async fn a_query_in_fts_syntax_is_treated_as_words() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("create");
    repos
        .update_note(
            &note.id,
            Some("Notes".into()),
            Some("we said NOT this OR that".into()),
            None,
        )
        .await
        .expect("update");
    // Operators, quotes and colons are what a user might paste; none of them
    // may reach the engine as syntax.
    for input in ["NOT this", "\"this OR that\"", "this:that", "( this"] {
        let hits = repos.search_everything(input, 5).await.expect("search");
        assert_eq!(hits.len(), 1, "input {input:?} should match as plain words");
    }
}
