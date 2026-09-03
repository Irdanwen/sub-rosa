//! The shot list's durable half, and the one thing it exists for: resuming
//! without re-buying what already landed.
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

async fn note(repos: &Repositories) -> String {
    repos.create_note(None).await.expect("note").id
}

#[tokio::test]
async fn a_run_keeps_the_parts_already_paid_for() {
    // The whole point of the parts column: a run interrupted at part two of
    // three resumes at part three, rather than re-buying the two that landed.
    let repos = repos().await;
    let note_id = note(&repos).await;
    repos
        .begin_shot_list(&note_id, 4000, 3, "opus", "shotlist-v1")
        .await
        .expect("begin");
    repos
        .save_shot_list_parts(&note_id, &["one".to_string(), "two".to_string()])
        .await
        .expect("parts");

    let resumed = repos
        .begin_shot_list(&note_id, 4000, 3, "opus", "shotlist-v1")
        .await
        .expect("resume");
    assert_eq!(resumed.status, "running");
    assert_eq!(resumed.parts_json.as_deref(), Some("[\"one\",\"two\"]"));
}

#[tokio::test]
async fn an_edited_script_starts_over_rather_than_lining_up_against_the_wrong_text() {
    let repos = repos().await;
    let note_id = note(&repos).await;
    repos
        .begin_shot_list(&note_id, 4000, 3, "opus", "shotlist-v1")
        .await
        .expect("begin");
    repos
        .save_shot_list_parts(&note_id, &["one".to_string()])
        .await
        .expect("parts");

    // A different chunk count means the indices would point at different text.
    let rechunked = repos
        .begin_shot_list(&note_id, 9000, 5, "opus", "shotlist-v1")
        .await
        .expect("rechunk");
    assert_eq!(rechunked.parts_json, None);
}

#[tokio::test]
async fn a_new_prompt_version_starts_over_too() {
    // Parts written by an older prompt are not parts of this reading.
    let repos = repos().await;
    let note_id = note(&repos).await;
    repos
        .begin_shot_list(&note_id, 4000, 3, "opus", "shotlist-v1")
        .await
        .expect("begin");
    repos
        .save_shot_list_parts(&note_id, &["one".to_string()])
        .await
        .expect("parts");
    let bumped = repos
        .begin_shot_list(&note_id, 4000, 3, "opus", "shotlist-v2")
        .await
        .expect("bumped");
    assert_eq!(bumped.parts_json, None);
}

#[tokio::test]
async fn finishing_clears_the_error_and_stores_the_shots() {
    let repos = repos().await;
    let note_id = note(&repos).await;
    repos
        .begin_shot_list(&note_id, 4000, 1, "opus", "shotlist-v1")
        .await
        .expect("begin");
    repos
        .set_shot_list_failed(&note_id, "the rail flapped")
        .await
        .expect("fail");
    let failed = repos.shot_list(&note_id).await.expect("read").expect("row");
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.last_error.as_deref(), Some("the rail flapped"));

    let done = repos
        .finish_shot_list(&note_id, &[serde_json::json!({ "action": "Nera turns" })])
        .await
        .expect("finish")
        .expect("row");
    assert_eq!(done.status, "ready");
    assert_eq!(done.last_error, None);
    assert!(done.shots_json.unwrap().contains("Nera turns"));
}

#[tokio::test]
async fn only_unfinished_rows_come_back_for_the_sweep() {
    let repos = repos().await;
    let running = note(&repos).await;
    let ready = note(&repos).await;
    repos
        .begin_shot_list(&running, 4000, 1, "opus", "shotlist-v1")
        .await
        .expect("running");
    repos
        .begin_shot_list(&ready, 4000, 1, "opus", "shotlist-v1")
        .await
        .expect("ready");
    repos
        .finish_shot_list(&ready, &[serde_json::json!({ "action": "a" })])
        .await
        .expect("finish");

    let unfinished = repos.unfinished_shot_lists().await.expect("list");
    assert_eq!(unfinished.len(), 1);
    assert_eq!(unfinished[0].note_id, running);
}

#[tokio::test]
async fn deleting_the_row_is_the_cancel() {
    let repos = repos().await;
    let note_id = note(&repos).await;
    repos
        .begin_shot_list(&note_id, 4000, 1, "opus", "shotlist-v1")
        .await
        .expect("begin");
    repos.delete_shot_list(&note_id).await.expect("delete");
    assert!(repos.shot_list(&note_id).await.expect("read").is_none());
}

#[tokio::test]
async fn a_film_is_a_note_that_has_been_read() {
    // No new row and no new noun: listing films is listing the notes with a
    // reading on them, joined to their current title.
    let repos = repos().await;
    let read = note(&repos).await;
    let unread = note(&repos).await;
    repos
        .update_note(&read, Some("Neon alley".to_string()), None, None)
        .await
        .expect("title");
    repos
        .begin_shot_list(&read, 4000, 1, "opus", "shotlist-v2")
        .await
        .expect("begin");
    repos
        .finish_shot_list(
            &read,
            &serde_json::json!({
                "cast": [{ "name": "Nera" }],
                "shots": [{ "action": "a" }, { "action": "b" }],
            }),
        )
        .await
        .expect("finish");

    let films = repos.list_films().await.expect("list");
    assert_eq!(films.len(), 1);
    assert_eq!(films[0].note_id, read);
    // The title is joined, not copied: a note renamed after its reading is
    // still the same film.
    assert_eq!(films[0].title, "Neon alley");
    assert_eq!(films[0].status, "ready");
    assert_eq!(films[0].shot_count, 2);
    assert!(films.iter().all(|film| film.note_id != unread));
}

#[tokio::test]
async fn a_reading_stored_before_the_cast_existed_still_counts_its_shots() {
    let repos = repos().await;
    let note_id = note(&repos).await;
    repos
        .begin_shot_list(&note_id, 4000, 1, "opus", "shotlist-v1")
        .await
        .expect("begin");
    repos
        .finish_shot_list(&note_id, &[serde_json::json!({ "action": "a" })])
        .await
        .expect("finish");
    assert_eq!(repos.list_films().await.expect("list")[0].shot_count, 1);
}

#[tokio::test]
async fn a_film_still_being_read_is_listed_with_nothing_in_it_yet() {
    let repos = repos().await;
    let note_id = note(&repos).await;
    repos
        .begin_shot_list(&note_id, 4000, 3, "opus", "shotlist-v2")
        .await
        .expect("begin");
    let films = repos.list_films().await.expect("list");
    assert_eq!(films[0].status, "running");
    assert_eq!(films[0].shot_count, 0);
}
