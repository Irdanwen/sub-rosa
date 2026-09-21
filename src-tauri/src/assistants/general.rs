//! General chat must never hydrate or mutate portable assistant conversations.
use crate::{
    db::repositories::Repositories,
    domain::types::{AgentTaskListResponse, AppError},
};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

pub(crate) fn private_chat_error() -> AppError {
    AppError::new(
        "assistant_use_private_chat",
        "Open this conversation from My assistants to preserve its instructions and permissions.",
    )
}
pub(crate) async fn ensure_general_continuation(
    pool: &SqlitePool,
    task_id: &str,
) -> Result<(), AppError> {
    let row=query("SELECT safety_profile,EXISTS(SELECT 1 FROM assistant_conversations WHERE task_id=agent_tasks.id) AS custom_snapshot FROM agent_tasks WHERE id=?").bind(task_id).fetch_one(pool).await?;
    if matches!(
        row.get::<String, _>("safety_profile").as_str(),
        "custom_assistant" | "customAssistant"
    ) || row.get::<bool, _>("custom_snapshot")
    {
        return Err(private_chat_error());
    }
    Ok(())
}
async fn visible_tasks(repos: &Repositories) -> Result<AgentTaskListResponse, AppError> {
    let rows=query("SELECT id,title,prompt,status,safety_profile,progress_summary,last_error,hermes_session_id,model,created_at,updated_at,completed_at FROM agent_tasks WHERE safety_profile NOT IN ('custom_assistant','customAssistant') AND NOT EXISTS(SELECT 1 FROM assistant_conversations WHERE task_id=agent_tasks.id) ORDER BY updated_at DESC,rowid DESC LIMIT 200").fetch_all(&repos.pool).await?;
    Ok(AgentTaskListResponse {
        items: rows
            .into_iter()
            .map(crate::db::repositories::agent_task_from_row)
            .collect(),
    })
}
pub(crate) async fn list(app: &AppHandle) -> Result<AgentTaskListResponse, AppError> {
    let repos = crate::commands::repositories(app).await?;
    repos.complete_agent_tasks_with_assistant_messages().await?;
    let response = visible_tasks(&repos).await?;
    for task in &response.items {
        if let Err(error) =
            crate::commands::hydrate_agent_task_from_hermes(app, &repos, &task.id).await
        {
            tracing::debug!(task_id=%task.id,code=%error.code,"General chat hydration deferred");
        }
    }
    visible_tasks(&repos).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn marker_or_snapshot_excludes_custom_chats_from_general_commands() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        for (id, profile) in [
            ("general", "balanced"),
            ("marked", "custom_assistant"),
            ("snapshot", "balanced"),
        ] {
            query("INSERT INTO agent_tasks(id,title,prompt,status,safety_profile,created_at,updated_at) VALUES(?,'Chat','Hello','completed',?,'now','now')").bind(id).bind(profile).execute(&pool).await.unwrap();
        }
        query("INSERT INTO assistant_conversations(task_id,assistant_id,snapshot_json,created_at) VALUES('snapshot','a','{}','now')").execute(&pool).await.unwrap();
        let tasks = visible_tasks(&Repositories::new(pool.clone()))
            .await
            .unwrap();
        assert_eq!(tasks.items.len(), 1);
        assert_eq!(tasks.items[0].id, "general");
        assert!(ensure_general_continuation(&pool, "general").await.is_ok());
        for id in ["marked", "snapshot"] {
            assert_eq!(
                ensure_general_continuation(&pool, id)
                    .await
                    .unwrap_err()
                    .code,
                "assistant_use_private_chat"
            );
        }
    }
}
