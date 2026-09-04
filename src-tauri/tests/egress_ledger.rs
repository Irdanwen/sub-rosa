//! The egress ledger keeps rows, sums them, filters by note, and forgets on
//! schedule.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use os_june_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_june_lib::egress_ledger::EgressEntry;
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

fn entry(at: &str, purpose: &str, note_id: Option<&str>, sent: u64, received: u64) -> EgressEntry {
    EgressEntry {
        at: at.into(),
        host: "api.carpe-diem.xyz".into(),
        purpose: purpose.into(),
        method: "POST".into(),
        request_bytes: sent,
        response_bytes: received,
        status: Some(200),
        duration_ms: 12,
        model: None,
        note_id: note_id.map(str::to_string),
    }
}

#[tokio::test]
async fn rows_are_listed_newest_first_and_summed_over_a_window() {
    let repos = repos().await;
    repos
        .insert_egress_entries(&[
            entry(
                "2026-09-01T10:00:00Z",
                "transcription",
                Some("n1"),
                1_000_000,
                4_000,
            ),
            entry("2026-09-02T10:00:00Z", "chat", None, 2_000, 0),
            entry("2026-09-03T10:00:00Z", "chat", Some("n1"), 3_000, 500),
        ])
        .await
        .expect("insert");

    let all = repos.list_egress_ledger(10, None).await.expect("list");
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].entry.at, "2026-09-03T10:00:00Z");
    assert_eq!(all[2].entry.purpose, "transcription");

    let about_n1 = repos
        .list_egress_ledger(10, Some("n1"))
        .await
        .expect("list");
    assert_eq!(about_n1.len(), 2);

    let summary = repos
        .summarize_egress_ledger("2026-09-02T00:00:00Z")
        .await
        .expect("summary");
    assert_eq!(summary.requests, 2);
    assert_eq!(summary.request_bytes, 5_000);
    assert_eq!(summary.response_bytes, 500);
    assert_eq!(summary.hosts, vec!["api.carpe-diem.xyz".to_string()]);
    assert_eq!(summary.purposes, vec![("chat".to_string(), 2)]);
}

#[tokio::test]
async fn pruning_forgets_what_is_older_than_the_cutoff_and_nothing_else() {
    let repos = repos().await;
    repos
        .insert_egress_entries(&[
            entry("2026-05-01T10:00:00Z", "chat", None, 1, 1),
            entry("2026-09-03T10:00:00Z", "chat", None, 1, 1),
        ])
        .await
        .expect("insert");
    let pruned = repos
        .prune_egress_ledger("2026-06-05T00:00:00Z")
        .await
        .expect("prune");
    assert_eq!(pruned, 1);
    let left = repos.list_egress_ledger(10, None).await.expect("list");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].entry.at, "2026-09-03T10:00:00Z");
}
