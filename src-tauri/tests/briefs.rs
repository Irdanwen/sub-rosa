//! The brief's durable half: one row per meeting, ever, and a cap that counts
//! only what actually reached the user.
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
async fn one_brief_per_meeting_ever_even_when_two_sweeps_race() {
    let repos = repos().await;
    for _ in 0..3 {
        repos
            .insert_pending_brief("event-1", "Point produit", "2026-08-22T09:50:00Z")
            .await
            .expect("insert");
    }
    let due = repos.due_briefs("2026-08-22T10:00:00Z").await.expect("due");
    assert_eq!(due.len(), 1, "the unique index is what makes this true");
    assert_eq!(due[0].event_title, "Point produit");
}

#[tokio::test]
async fn a_brief_is_due_only_once_its_moment_has_come() {
    let repos = repos().await;
    repos
        .insert_pending_brief("event-1", "Later", "2026-08-22T15:00:00Z")
        .await
        .expect("insert");
    assert!(repos
        .due_briefs("2026-08-22T09:00:00Z")
        .await
        .expect("due")
        .is_empty());
    assert_eq!(
        repos
            .due_briefs("2026-08-22T15:00:01Z")
            .await
            .expect("due")
            .len(),
        1
    );
}

#[tokio::test]
async fn settling_closes_a_brief_for_good_and_only_deliveries_count() {
    let repos = repos().await;
    repos
        .insert_pending_brief("event-1", "Delivered", "2026-08-22T09:00:00Z")
        .await
        .expect("insert");
    repos
        .insert_pending_brief("event-2", "Skipped", "2026-08-22T09:00:00Z")
        .await
        .expect("insert");
    let due = repos.due_briefs("2026-08-22T10:00:00Z").await.expect("due");
    assert_eq!(due.len(), 2);

    for brief in &due {
        let status = if brief.event_title == "Delivered" {
            "delivered"
        } else {
            "skipped"
        };
        repos
            .settle_brief(&brief.id, status, Some("You agreed the rollout slips."))
            .await
            .expect("settle");
    }

    // Neither comes back.
    assert!(repos
        .due_briefs("2026-08-22T23:00:00Z")
        .await
        .expect("due")
        .is_empty());
    // The cap counts what reached the user, never the silences.
    assert_eq!(
        repos
            .briefs_delivered_since("2000-01-01T00:00:00Z")
            .await
            .expect("count"),
        1
    );
}
