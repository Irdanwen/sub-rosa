// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_june_lib::domain::types::MemorySource;
use os_june_lib::reflex::journal::{self, MemoryState};
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

fn state(text: &str) -> MemoryState {
    MemoryState {
        text: text.into(),
        disabled: false,
    }
}

#[tokio::test]
async fn a_replacement_is_undone_back_to_the_old_fact() {
    let repos = repos().await;
    let memory = repos
        .insert_memory("Habite à Paris.", MemorySource::Auto, 2)
        .await
        .unwrap();
    repos
        .update_memory(&memory.id, Some("Habite à Lyon."), None)
        .await
        .unwrap();
    journal::record(
        &repos.pool,
        journal::MEMORY_UPDATE,
        &memory.id,
        &state("Habite à Paris."),
        &state("Habite à Lyon."),
        0.97,
    )
    .await
    .unwrap();

    let changes = journal::list(&repos.pool, 10).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].after.text, "Habite à Lyon.");

    let undone = journal::undo(&repos.pool, &changes[0].id).await.unwrap();
    assert!(undone.undone_at.is_some());
    let texts: Vec<String> = repos
        .list_memories()
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.text)
        .collect();
    assert_eq!(texts, vec!["Habite à Paris."]);
    // Undoing twice is a no-op, not an error.
    assert!(journal::undo(&repos.pool, &changes[0].id).await.is_ok());
}

#[tokio::test]
async fn an_undo_never_overwrites_what_changed_since() {
    let repos = repos().await;
    let memory = repos
        .insert_memory("Habite à Lyon.", MemorySource::Auto, 2)
        .await
        .unwrap();
    journal::record(
        &repos.pool,
        journal::MEMORY_UPDATE,
        &memory.id,
        &state("Habite à Paris."),
        &state("Habite à Lyon."),
        0.9,
    )
    .await
    .unwrap();
    // The person edits it by hand afterwards.
    repos
        .update_memory(&memory.id, Some("Habite à Annecy."), None)
        .await
        .unwrap();
    let change = &journal::list(&repos.pool, 10).await.unwrap()[0];
    let refused = journal::undo(&repos.pool, &change.id).await.unwrap_err();
    assert_eq!(refused.code, "reflex_change_moved");
    assert_eq!(
        repos.list_memories().await.unwrap()[0].text,
        "Habite à Annecy."
    );
}

#[tokio::test]
async fn a_repeat_left_out_is_stored_on_undo() {
    let repos = repos().await;
    let kept = repos
        .insert_memory("Veut des réponses brèves.", MemorySource::Auto, 3)
        .await
        .unwrap();
    journal::record(
        &repos.pool,
        journal::MEMORY_SAME,
        &kept.id,
        &state("Préfère les réponses courtes."),
        &state("Veut des réponses brèves."),
        0.9,
    )
    .await
    .unwrap();
    let change = &journal::list(&repos.pool, 10).await.unwrap()[0];
    journal::undo(&repos.pool, &change.id).await.unwrap();
    let mut texts: Vec<String> = repos
        .list_memories()
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.text)
        .collect();
    texts.sort();
    assert_eq!(
        texts,
        vec!["Préfère les réponses courtes.", "Veut des réponses brèves."]
    );
}
