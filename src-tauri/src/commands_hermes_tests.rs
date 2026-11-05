//! A task is bound to a conversation of its own mode's home only
//! (ADR-0140): the jail cannot forge, in its home, a conversation that an
//! unrestricted task would take for its own.

// Test code throughout (the module is `#[cfg(all(test, desktop))]`, which
// the `allow-unwrap-in-tests` setting does not recognize).
#![allow(clippy::unwrap_used)]

use crate::db::repositories::Repositories;
use crate::hermes_bridge::session_owner::{record_task_home, Owner};

async fn repositories() -> Repositories {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    Repositories::new(pool)
}

/// A runtime's database holding one conversation titled `title`, started
/// now.
async fn home_with_a_conversation(home: &std::path::Path, id: &str, title: &str) {
    std::fs::create_dir_all(home).unwrap();
    let url = format!("sqlite://{}?mode=rwc", home.join("state.db").display());
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    sqlx::query::query("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL)")
        .execute(&pool)
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp_millis() as f64 / 1000.0;
    sqlx::query::query("INSERT INTO sessions (id, title, started_at) VALUES (?, ?, ?)")
        .bind(id)
        .bind(title)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

/// A data folder with both homes, a task created now, and in each named
/// home a conversation titled like the task, started with it.
async fn homes_with(
    repos: &Repositories,
    conversations: &[(Owner, &str)],
) -> (tempfile::TempDir, crate::domain::types::AgentTaskDto) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(Owner::Shared.dir_name())).unwrap();
    std::fs::create_dir_all(dir.path().join(Owner::Sandboxed.dir_name())).unwrap();
    let task = repos
        .create_agent_task(
            "Deploy the site to production",
            None,
            Default::default(),
            None,
        )
        .await
        .unwrap();
    for (owner, id) in conversations {
        home_with_a_conversation(&dir.path().join(owner.dir_name()), id, &task.title).await;
    }
    (dir, task)
}

/// Audit A1, the exact case: an unrestricted task's conversation is in the
/// shared home, not bound yet; the jail reads its title and start in the
/// shared `state.db` and forges, in its own home, a conversation with the
/// same title and time. The search used to look in the jail's home first
/// and took the forgery. Now a task whose mode the app does not know is
/// matched in the shared home only: it gets its real conversation.
#[tokio::test]
async fn a_forged_copy_in_the_jails_home_never_wins_over_the_real_conversation() {
    let repos = repositories().await;
    let (dir, task) = homes_with(
        &repos,
        &[
            (Owner::Shared, "real-session"),
            (Owner::Sandboxed, "forged-session"),
        ],
    )
    .await;
    let found = super::find_hermes_session(&repos, &task, dir.path())
        .await
        .unwrap();
    assert_eq!(found.map(|(_, id)| id).as_deref(), Some("real-session"));
}

/// With only the forgery there, a task of unknown mode, or an unrestricted
/// one, is bound to nothing.
#[tokio::test]
async fn a_conversation_forged_in_the_jails_home_is_not_bound_to_another_task() {
    let repos = repositories().await;
    let (dir, task) = homes_with(&repos, &[(Owner::Sandboxed, "forged-session")]).await;
    let shared_home = dir.path().join(Owner::Shared.dir_name());
    let found = super::find_hermes_session(&repos, &task, dir.path())
        .await
        .unwrap();
    assert!(found.is_none(), "bound to a conversation the jail wrote");
    record_task_home(&shared_home, &task.id, Owner::Shared).unwrap();
    let found = super::find_hermes_session(&repos, &task, dir.path())
        .await
        .unwrap();
    assert!(
        found.is_none(),
        "an unrestricted task bound in the jail's home"
    );
}

/// The control: a task created in the jail is matched in the jail's home.
#[tokio::test]
async fn a_task_created_in_the_jail_is_matched_in_its_home() {
    let repos = repositories().await;
    let (dir, task) = homes_with(&repos, &[(Owner::Sandboxed, "its-session")]).await;
    let shared_home = dir.path().join(Owner::Shared.dir_name());
    record_task_home(&shared_home, &task.id, Owner::Sandboxed).unwrap();
    let found = super::find_hermes_session(&repos, &task, dir.path())
        .await
        .unwrap();
    assert_eq!(found.map(|(_, id)| id).as_deref(), Some("its-session"));
}
