//! The bible's durable half: entries, their references, and the order the
//! references are offered in - which is load bearing, because the first image
//! is the identity anchor for the reference-to-video families.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
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

#[tokio::test]
async fn an_entry_survives_with_no_references_at_all() {
    // A character you have named but not yet cast is still a character. A join
    // would have dropped it, which is why the listing is two queries.
    let repos = repos().await;
    repos
        .upsert_bible_entry(None, "character", "Nera", "green coat", "")
        .await
        .expect("insert");
    let entries = repos.list_bible_entries().await.expect("list");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "Nera");
    assert_eq!(entries[0].traits, "green coat");
    assert!(entries[0].refs.is_empty());
}

#[tokio::test]
async fn references_come_back_in_the_order_they_will_be_offered() {
    let repos = repos().await;
    let entry = repos
        .upsert_bible_entry(None, "character", "Nera", "", "")
        .await
        .expect("insert");
    let portrait = repos
        .add_bible_ref(&entry, "a.png", "portrait", "front")
        .await
        .expect("portrait");
    let profile = repos
        .add_bible_ref(&entry, "b.png", "profile", "side")
        .await
        .expect("profile");

    let listed = repos.list_bible_entries().await.expect("list");
    assert_eq!(
        listed[0]
            .refs
            .iter()
            .map(|reference| reference.artifact_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a.png", "b.png"]
    );

    // The anchor has to be movable: which angle reads as the identity is a
    // judgement, and the model takes the first one.
    repos
        .reorder_bible_refs(&entry, &[profile.clone(), portrait.clone()])
        .await
        .expect("reorder");
    let reordered = repos.list_bible_entries().await.expect("list again");
    assert_eq!(
        reordered[0]
            .refs
            .iter()
            .map(|reference| reference.artifact_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b.png", "a.png"]
    );
}

#[tokio::test]
async fn the_same_file_in_the_same_role_replaces_rather_than_stacking() {
    // Two copies of one angle is not a second angle: it would be sent to the
    // model twice and would push a real angle out of the stack.
    let repos = repos().await;
    let entry = repos
        .upsert_bible_entry(None, "location", "The alley", "", "")
        .await
        .expect("insert");
    repos
        .add_bible_ref(&entry, "w.png", "wide", "")
        .await
        .expect("first");
    repos
        .add_bible_ref(&entry, "w.png", "wide", "at night")
        .await
        .expect("again");
    repos
        .add_bible_ref(&entry, "w.png", "detail", "")
        .await
        .expect("other role");

    let listed = repos.list_bible_entries().await.expect("list");
    assert_eq!(listed[0].refs.len(), 2);
    let wide = listed[0]
        .refs
        .iter()
        .find(|reference| reference.role == "wide")
        .expect("wide");
    assert_eq!(wide.label, "at night");
}

#[tokio::test]
async fn updating_an_entry_keeps_its_references() {
    let repos = repos().await;
    let entry = repos
        .upsert_bible_entry(None, "character", "Nera", "green coat", "")
        .await
        .expect("insert");
    repos
        .add_bible_ref(&entry, "a.png", "portrait", "")
        .await
        .expect("ref");
    let same = repos
        .upsert_bible_entry(Some(entry.clone()), "character", "Nera", "red coat", "note")
        .await
        .expect("update");
    assert_eq!(same, entry);

    let listed = repos.list_bible_entries().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].traits, "red coat");
    assert_eq!(listed[0].refs.len(), 1);
}

#[tokio::test]
async fn deleting_an_entry_takes_its_references_and_nothing_else() {
    let repos = repos().await;
    let doomed = repos
        .upsert_bible_entry(None, "prop", "The umbrella", "", "")
        .await
        .expect("insert");
    let kept = repos
        .upsert_bible_entry(None, "character", "Nera", "", "")
        .await
        .expect("insert");
    repos
        .add_bible_ref(&doomed, "a.png", "portrait", "")
        .await
        .expect("ref");
    repos
        .add_bible_ref(&kept, "b.png", "portrait", "")
        .await
        .expect("ref");

    repos.delete_bible_entry(&doomed).await.expect("delete");
    let listed = repos.list_bible_entries().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, kept);
    assert_eq!(listed[0].refs.len(), 1);
}

#[tokio::test]
async fn a_reference_whose_artifact_is_gone_is_still_listed() {
    // The gallery index lives in the webview and its entries come and go
    // legitimately. A reference pointing at a file the gallery no longer knows
    // must be reported, not silently deleted on the user's behalf.
    let repos = repos().await;
    let entry = repos
        .upsert_bible_entry(None, "character", "Nera", "", "")
        .await
        .expect("insert");
    repos
        .add_bible_ref(&entry, "vanished.png", "portrait", "")
        .await
        .expect("ref");
    let listed = repos.list_bible_entries().await.expect("list");
    assert_eq!(listed[0].refs[0].artifact_id, "vanished.png");
}
