//! Which remembered facts a reply was given (ADR-0081).
//!
//! The two shells inject memory differently, so they record it differently:
//!
//! - **Phone (agent-lite)** rebuilds the block every turn, so every turn is a
//!   record. Its owner is the user message that opened the turn: the reply is
//!   written later, under a fresh id, by a path this module stays out of, and
//!   the reply under that message is the one the memories went to. A turn run
//!   again (a retry, a regeneration) replaces its record.
//! - **Desktop (Hermes)** writes the block into `SOUL.md` when the runtime
//!   starts, and every session that runtime starts reads that one file. So the
//!   runtime's injection is held here in process, and a session is bound to it
//!   the first time the chat asks, provided the session began after it.
//!   A session that began earlier was built from a soul this process never
//!   saw, and it stays unrecorded rather than credited with the wrong facts.
//!
//! The tables hold ids only. Listing joins them to the memories that still
//! exist, so a memory forgotten since simply drops out of the list.

use crate::{
    db::repositories::Repositories,
    domain::types::{AgentMessageRole, AgentTaskDto, AppError, MemoryDto},
};
use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row, transaction::Transaction};
use sqlx_sqlite::{Sqlite, SqlitePool};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

const TURN: &str = "turn";
const SESSION: &str = "session";
/// A session's start and the runtime's spawn come from the same clock, but
/// one is a float in seconds: a second of slack covers the rounding.
const SESSION_START_SLACK_MS: i64 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoulInjection {
    pub memory_ids: Vec<String>,
    pub at_ms: i64,
}

static SOUL_INJECTION: OnceLock<Mutex<Option<SoulInjection>>> = OnceLock::new();

fn soul_injection() -> std::sync::MutexGuard<'static, Option<SoulInjection>> {
    SOUL_INJECTION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// Called when the desktop SOUL is written: these memories are what sessions
/// started from now on will carry.
pub fn note_soul_injection(memory_ids: Vec<String>) {
    *soul_injection() = Some(SoulInjection {
        memory_ids,
        at_ms: chrono::Utc::now().timestamp_millis(),
    });
}

/// The memory block for an agent-lite turn, recorded against the user
/// message that opened it. Recording is best-effort: a failure logs and the
/// turn goes on with its block.
pub async fn block_for_turn(repos: &Repositories, task: &AgentTaskDto) -> Option<String> {
    let latest = task.messages.last();
    let message = latest.map_or("", |message| message.content.as_str());
    let memories = super::memories_for_turn(repos, message).await;
    if let Some(turn) = latest.filter(|message| message.role == AgentMessageRole::User) {
        let ids: Vec<String> = memories
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|memory| memory.id.clone())
            .collect();
        if let Err(error) = record_turn(&repos.pool, &task.id, &turn.id, &ids).await {
            tracing::warn!("Could not record the memories of a turn: {error}");
        }
    }
    super::format_memory_block(memories.as_deref()?)
}

/// Replaces the record of one turn. An empty set leaves no record: there is
/// nothing to show under that reply. Records of deleted chats go with it.
pub async fn record_turn(
    pool: &SqlitePool,
    task_id: &str,
    turn_id: &str,
    memory_ids: &[String],
) -> Result<(), sqlx::error::Error> {
    let mut tx = pool.begin().await?;
    clear_owner(&mut tx, TURN, turn_id).await?;
    if !memory_ids.is_empty() {
        insert_owner(&mut tx, TURN, turn_id, Some(task_id), memory_ids).await?;
    }
    query(
        "DELETE FROM memory_source_records
         WHERE owner_kind = 'turn' AND task_id NOT IN (SELECT id FROM agent_tasks)",
    )
    .execute(&mut *tx)
    .await?;
    query(
        "DELETE FROM memory_sources
         WHERE NOT EXISTS (
           SELECT 1 FROM memory_source_records r
           WHERE r.owner_kind = memory_sources.owner_kind AND r.owner_id = memory_sources.owner_id
         )",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

async fn clear_owner(
    tx: &mut Transaction<'_, Sqlite>,
    kind: &str,
    owner_id: &str,
) -> Result<(), sqlx::error::Error> {
    query("DELETE FROM memory_sources WHERE owner_kind = ? AND owner_id = ?")
        .bind(kind)
        .bind(owner_id)
        .execute(&mut **tx)
        .await?;
    query("DELETE FROM memory_source_records WHERE owner_kind = ? AND owner_id = ?")
        .bind(kind)
        .bind(owner_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn insert_owner(
    tx: &mut Transaction<'_, Sqlite>,
    kind: &str,
    owner_id: &str,
    task_id: Option<&str>,
    memory_ids: &[String],
) -> Result<(), sqlx::error::Error> {
    query(
        "INSERT INTO memory_source_records (owner_kind, owner_id, task_id, recorded_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(kind)
    .bind(owner_id)
    .bind(task_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    for (position, memory_id) in memory_ids.iter().enumerate() {
        query(
            "INSERT OR IGNORE INTO memory_sources (owner_kind, owner_id, memory_id, position)
             VALUES (?, ?, ?, ?)",
        )
        .bind(kind)
        .bind(owner_id)
        .bind(memory_id)
        .bind(position as i64)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Every recorded turn of a chat: (turn id, memory ids in injection order).
pub async fn turns_of_task(
    pool: &SqlitePool,
    task_id: &str,
) -> Result<Vec<(String, Vec<String>)>, sqlx::error::Error> {
    let rows = query(
        "SELECT s.owner_id AS owner_id, s.memory_id AS memory_id
         FROM memory_source_records r
         JOIN memory_sources s ON s.owner_kind = r.owner_kind AND s.owner_id = r.owner_id
         WHERE r.owner_kind = 'turn' AND r.task_id = ?
         ORDER BY r.recorded_at, s.owner_id, s.position",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;
    let mut turns: Vec<(String, Vec<String>)> = Vec::new();
    for row in rows {
        let owner: String = row.get("owner_id");
        let memory: String = row.get("memory_id");
        match turns.iter_mut().find(|(turn, _)| *turn == owner) {
            Some((_, ids)) => ids.push(memory),
            None => turns.push((owner, vec![memory])),
        }
    }
    Ok(turns)
}

/// A desktop session's memory ids: its record if it has one; otherwise bound
/// now to `injection` when the session began after it; otherwise `None`.
pub async fn session_memory_ids(
    pool: &SqlitePool,
    session_id: &str,
    started_at_ms: Option<i64>,
    injection: Option<&SoulInjection>,
) -> Result<Option<Vec<String>>, sqlx::error::Error> {
    let recorded =
        query("SELECT 1 FROM memory_source_records WHERE owner_kind = 'session' AND owner_id = ?")
            .bind(session_id)
            .fetch_optional(pool)
            .await?;
    if recorded.is_some() {
        let rows = query(
            "SELECT memory_id FROM memory_sources
             WHERE owner_kind = 'session' AND owner_id = ?
             ORDER BY position",
        )
        .bind(session_id)
        .fetch_all(pool)
        .await?;
        return Ok(Some(rows.iter().map(|row| row.get("memory_id")).collect()));
    }
    let Some(injection) = injection else {
        return Ok(None);
    };
    if started_at_ms.is_some_and(|started| started + SESSION_START_SLACK_MS < injection.at_ms) {
        return Ok(None);
    }
    let mut tx = pool.begin().await?;
    insert_owner(&mut tx, SESSION, session_id, None, &injection.memory_ids).await?;
    tx.commit().await?;
    Ok(Some(injection.memory_ids.clone()))
}

/// The memories behind `ids`, in that order, skipping any forgotten since.
fn resolve(ids: &[String], all: &[MemoryDto]) -> Vec<MemoryDto> {
    ids.iter()
        .filter_map(|id| all.iter().find(|memory| &memory.id == id).cloned())
        .collect()
}

// --- IPC commands ----------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSourcesRequest {
    pub task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnMemorySources {
    /// The user message that opened the turn; the reply under it is the one
    /// these memories went to.
    pub turn_id: String,
    pub memories: Vec<MemoryDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSourcesRequest {
    /// The stored Hermes session id.
    pub session_id: String,
    #[serde(default)]
    pub started_at_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemorySources {
    /// False when the session's injection is not known (it began before the
    /// running runtime, or no runtime has started yet).
    pub recorded: bool,
    pub memories: Vec<MemoryDto>,
}

#[tauri::command]
pub async fn memory_sources_for_task(
    app: AppHandle,
    request: TaskSourcesRequest,
) -> Result<Vec<TurnMemorySources>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let turns = turns_of_task(&repos.pool, &request.task_id).await?;
    if turns.is_empty() {
        return Ok(Vec::new());
    }
    let all = repos.list_memories().await?;
    Ok(turns
        .into_iter()
        .map(|(turn_id, ids)| TurnMemorySources {
            turn_id,
            memories: resolve(&ids, &all),
        })
        .filter(|turn| !turn.memories.is_empty())
        .collect())
}

/// A desktop chat in a "Project only" project is never given the SOUL's
/// memory: the provider proxy swaps in its project's top memories on every
/// request (ADR-0085 addendum), so those are what it was given. `None` for
/// any other chat.
async fn project_session_memories(
    repos: &crate::db::repositories::Repositories,
    session_id: &str,
) -> Result<Option<Vec<MemoryDto>>, AppError> {
    let Some(scope) = crate::projects::context::for_session(&repos.pool, session_id)
        .await
        .and_then(|project| project.memory_scope())
    else {
        return Ok(None);
    };
    if !super::settings().enabled {
        return Ok(Some(Vec::new()));
    }
    Ok(Some(
        repos
            .with_memory_scope(Some(scope))
            .top_memories(super::INJECTED_MEMORY_LIMIT)
            .await?,
    ))
}

#[tauri::command]
pub async fn memory_sources_for_session(
    app: AppHandle,
    request: SessionSourcesRequest,
) -> Result<SessionMemorySources, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    if let Some(memories) = project_session_memories(&repos, &request.session_id).await? {
        return Ok(SessionMemorySources {
            recorded: true,
            memories,
        });
    }
    let injection = soul_injection().clone();
    let ids = session_memory_ids(
        &repos.pool,
        &request.session_id,
        request.started_at_ms,
        injection.as_ref(),
    )
    .await?;
    let Some(ids) = ids else {
        return Ok(SessionMemorySources {
            recorded: false,
            memories: Vec::new(),
        });
    };
    let all = if ids.is_empty() {
        Vec::new()
    } else {
        repos.list_memories().await?
    };
    Ok(SessionMemorySources {
        recorded: true,
        memories: resolve(&ids, &all),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn chat(pool: &SqlitePool, id: &str) {
        query("INSERT INTO agent_tasks(id,title,prompt,status,safety_profile,created_at,updated_at) VALUES(?,'t','p','completed','general','t0','t0')")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[tokio::test]
    async fn a_turn_records_its_memories_and_a_rerun_replaces_them() {
        let pool = pool().await;
        chat(&pool, "task").await;
        record_turn(&pool, "task", "u1", &ids(&["m2", "m1"]))
            .await
            .unwrap();
        record_turn(&pool, "task", "u2", &ids(&["m3"]))
            .await
            .unwrap();
        assert_eq!(
            turns_of_task(&pool, "task").await.unwrap(),
            vec![
                ("u1".to_string(), ids(&["m2", "m1"])),
                ("u2".to_string(), ids(&["m3"]))
            ]
        );
        // A regenerated turn carried something else, or nothing at all.
        record_turn(&pool, "task", "u1", &ids(&["m4"]))
            .await
            .unwrap();
        record_turn(&pool, "task", "u2", &[]).await.unwrap();
        assert_eq!(
            turns_of_task(&pool, "task").await.unwrap(),
            vec![("u1".to_string(), ids(&["m4"]))]
        );
    }

    #[tokio::test]
    async fn records_of_a_deleted_chat_are_pruned() {
        let pool = pool().await;
        chat(&pool, "gone").await;
        chat(&pool, "kept").await;
        record_turn(&pool, "gone", "u1", &ids(&["m1"]))
            .await
            .unwrap();
        query("DELETE FROM agent_tasks WHERE id = 'gone'")
            .execute(&pool)
            .await
            .unwrap();
        record_turn(&pool, "kept", "u2", &ids(&["m2"]))
            .await
            .unwrap();
        let left: i64 = query("SELECT count(*) AS n FROM memory_sources")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(left, 1);
        assert!(turns_of_task(&pool, "gone").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_session_binds_to_the_injection_it_began_under_and_keeps_it() {
        let pool = pool().await;
        let first = SoulInjection {
            memory_ids: ids(&["m1", "m2"]),
            at_ms: 10_000,
        };
        // Nothing has started yet: unknown, and nothing is written.
        assert_eq!(
            session_memory_ids(&pool, "s1", Some(12_000), None)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            session_memory_ids(&pool, "s1", Some(12_000), Some(&first))
                .await
                .unwrap(),
            Some(ids(&["m1", "m2"]))
        );
        // A later runtime does not rewrite what the session was given.
        let second = SoulInjection {
            memory_ids: ids(&["m9"]),
            at_ms: 50_000,
        };
        assert_eq!(
            session_memory_ids(&pool, "s1", Some(12_000), Some(&second))
                .await
                .unwrap(),
            Some(ids(&["m1", "m2"]))
        );
        // A session older than the runtime stays unknown.
        assert_eq!(
            session_memory_ids(&pool, "s0", Some(1_000), Some(&second))
                .await
                .unwrap(),
            None
        );
        // An empty injection is still a record.
        let empty = SoulInjection {
            memory_ids: Vec::new(),
            at_ms: 60_000,
        };
        assert_eq!(
            session_memory_ids(&pool, "s2", None, Some(&empty))
                .await
                .unwrap(),
            Some(Vec::new())
        );
        assert_eq!(
            session_memory_ids(&pool, "s2", None, Some(&second))
                .await
                .unwrap(),
            Some(Vec::new())
        );
    }

    #[tokio::test]
    async fn a_project_only_session_was_given_its_projects_memory() {
        let repos = crate::db::repositories::Repositories::new(pool().await);
        for (id, mode) in [("p-only", "project"), ("p-default", "default")] {
            query("INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, 'P', 'now', 'now')")
                .bind(id)
                .execute(&repos.pool)
                .await
                .unwrap();
            crate::projects::save_settings(&repos.pool, id, "", mode)
                .await
                .unwrap();
        }
        for (session, folder) in [("in-project", "p-only"), ("in-default", "p-default")] {
            query("INSERT INTO session_folders (session_id, folder_id, assigned_at) VALUES (?, ?, 'now')")
                .bind(session)
                .bind(folder)
                .execute(&repos.pool)
                .await
                .unwrap();
        }
        repos
            .insert_memory(
                "Lives in Lausanne",
                crate::domain::types::MemorySource::Manual,
                2,
            )
            .await
            .unwrap();
        repos
            .with_memory_scope(Some("p-only".into()))
            .insert_memory(
                "Launch in March",
                crate::domain::types::MemorySource::Manual,
                2,
            )
            .await
            .unwrap();

        assert!(project_session_memories(&repos, "in-default")
            .await
            .unwrap()
            .is_none());
        assert!(project_session_memories(&repos, "elsewhere")
            .await
            .unwrap()
            .is_none());
        let given = project_session_memories(&repos, "in-project")
            .await
            .unwrap()
            .unwrap();
        if super::super::settings().enabled {
            let texts: Vec<_> = given.iter().map(|memory| memory.text.as_str()).collect();
            assert_eq!(texts, ["Launch in March"]);
        } else {
            assert!(given.is_empty());
        }
    }

    #[test]
    fn resolve_keeps_the_order_and_drops_forgotten_memories() {
        let memory = |id: &str| MemoryDto {
            id: id.to_string(),
            text: id.to_string(),
            source: crate::domain::types::MemorySource::Auto,
            importance: 3,
            disabled: false,
            has_embedding: false,
            created_at: String::new(),
            updated_at: String::new(),
            scope: None,
        };
        let all = vec![memory("a"), memory("b")];
        let resolved = resolve(&ids(&["b", "gone", "a"]), &all);
        assert_eq!(
            resolved
                .iter()
                .map(|memory| memory.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
    }
}
