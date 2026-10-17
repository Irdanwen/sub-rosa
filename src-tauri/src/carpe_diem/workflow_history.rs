//! A workflow's run history, as the canvas shows it: one line per run, newest
//! first, without the frozen graph each row carries (that is what made
//! listing every run expensive), and a retention rule for the canvas's own
//! finished runs.
//!
//! Only the canvas calls these, with the id of a workflow it shows. A film
//! production's runs carry their production's own workflow id and are never
//! pruned here: `productionCut` reads them back.

use serde::Serialize;
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;

/// How many runs one history shows at most.
const MAX_HISTORY: i64 = 100;
/// Finished runs a workflow keeps by default; older ones are let go.
const DEFAULT_KEEP: i64 = 30;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunEntry {
    pub id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_costs: Option<String>,
    /// Steps that finished in this run.
    pub done: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn status_for_webview(stored: &str) -> String {
    // The webview speaks camelCase, the table snake_case (see `as_db`).
    if stored == "awaiting_gate" {
        "awaitingGate".into()
    } else {
        stored.into()
    }
}

pub async fn history(
    pool: &SqlitePool,
    workflow_id: &str,
    limit: i64,
) -> Result<Vec<WorkflowRunEntry>, AppError> {
    let rows = query(
        "SELECT r.id, r.status, r.error, r.node_costs, r.created_at, r.updated_at,
                (SELECT COUNT(*) FROM workflow_run_nodes n
                  WHERE n.run_id = r.id AND n.status = 'done') AS done
         FROM workflow_runs r
         WHERE r.workflow_id = ?
         ORDER BY r.created_at DESC
         LIMIT ?",
    )
    .bind(workflow_id)
    .bind(limit.clamp(1, MAX_HISTORY))
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let status: String = row.try_get("status")?;
            Ok(WorkflowRunEntry {
                id: row.try_get("id")?,
                status: status_for_webview(&status),
                error: row.try_get("error")?,
                node_costs: row.try_get("node_costs")?,
                done: row.try_get("done")?,
                created_at: row.try_get("created_at")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<_, sqlx::error::Error>>()
        .map_err(AppError::from)
}

/// Let go of a workflow's finished runs beyond the newest `keep`. A run that
/// is still running or held at a gate is never touched.
pub async fn prune(pool: &SqlitePool, workflow_id: &str, keep: i64) -> Result<u64, AppError> {
    let doomed = query(
        "SELECT id FROM workflow_runs
         WHERE workflow_id = ? AND status IN ('completed', 'failed', 'cancelled')
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?",
    )
    .bind(workflow_id)
    .bind(keep.max(1))
    .fetch_all(pool)
    .await?;
    let mut removed = 0;
    for row in doomed {
        let id: String = row.try_get("id")?;
        query("DELETE FROM workflow_run_nodes WHERE run_id = ?")
            .bind(&id)
            .execute(pool)
            .await?;
        removed += query("DELETE FROM workflow_runs WHERE id = ?")
            .bind(&id)
            .execute(pool)
            .await?
            .rows_affected();
    }
    Ok(removed)
}

#[tauri::command]
pub async fn workflow_run_history(
    app: AppHandle,
    workflow_id: String,
    limit: Option<i64>,
) -> Result<Vec<WorkflowRunEntry>, AppError> {
    if workflow_id.trim().is_empty() {
        return Err(AppError::new(
            "workflow_run_invalid",
            "A history needs a workflow.",
        ));
    }
    let repos = crate::commands::repositories(&app).await?;
    history(&repos.pool, &workflow_id, limit.unwrap_or(MAX_HISTORY)).await
}

#[tauri::command]
pub async fn workflow_run_prune(
    app: AppHandle,
    workflow_id: String,
    keep: Option<i64>,
) -> Result<u64, AppError> {
    if workflow_id.trim().is_empty() {
        return Err(AppError::new(
            "workflow_run_invalid",
            "Pruning needs a workflow.",
        ));
    }
    let repos = crate::commands::repositories(&app).await?;
    prune(&repos.pool, &workflow_id, keep.unwrap_or(DEFAULT_KEEP)).await
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

    async fn run(pool: &SqlitePool, id: &str, workflow: &str, status: &str, at: &str) {
        query(
            "INSERT INTO workflow_runs (id, workflow_id, name, definition, status, created_at, updated_at)
             VALUES (?, ?, 'w', '{\"nodes\":[],\"edges\":[]}', ?, ?, ?)",
        )
        .bind(id)
        .bind(workflow)
        .bind(status)
        .bind(at)
        .bind(at)
        .execute(pool)
        .await
        .unwrap();
        query(
            "INSERT INTO workflow_run_nodes (run_id, node_id, status, updated_at) VALUES (?, 'n', 'done', ?)",
        )
        .bind(id)
        .bind(at)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn lists_one_workflow_newest_first_without_its_graph() {
        let pool = pool().await;
        run(&pool, "a", "w1", "completed", "2026-10-01").await;
        run(&pool, "b", "w1", "awaiting_gate", "2026-10-02").await;
        run(&pool, "c", "w2", "completed", "2026-10-03").await;
        let listed = history(&pool, "w1", 10).await.unwrap();
        assert_eq!(
            listed.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(listed[0].status, "awaitingGate");
        assert_eq!(listed[0].done, 1);
    }

    #[tokio::test]
    async fn prunes_finished_runs_beyond_the_newest_and_never_a_live_one() {
        let pool = pool().await;
        run(&pool, "old", "w1", "completed", "2026-10-01").await;
        run(&pool, "held", "w1", "awaiting_gate", "2026-10-02").await;
        run(&pool, "mid", "w1", "failed", "2026-10-03").await;
        run(&pool, "new", "w1", "completed", "2026-10-04").await;
        run(&pool, "other", "w2", "completed", "2026-09-01").await;
        assert_eq!(prune(&pool, "w1", 2).await.unwrap(), 1);
        let left = history(&pool, "w1", 10).await.unwrap();
        assert_eq!(
            left.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["new", "mid", "held"]
        );
        assert_eq!(history(&pool, "w2", 10).await.unwrap().len(), 1);
        let orphans = query("SELECT COUNT(*) AS n FROM workflow_run_nodes WHERE run_id = 'old'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i64, _>("n");
        assert_eq!(orphans, 0);
    }
}
