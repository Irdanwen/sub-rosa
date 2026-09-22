//! General chat must never hydrate or mutate portable assistant conversations.
use crate::{
    db::repositories::Repositories,
    domain::types::{AgentTaskDto, AppError},
};
use serde::Serialize;
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
/// A chat in the history list: the task, plus the line under its title. The
/// list used to read that line from `messages`, which the list query never
/// fills, so every row had an empty second line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralTaskListItem {
    #[serde(flatten)]
    pub task: AgentTaskDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_role: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GeneralTaskList {
    pub items: Vec<GeneralTaskListItem>,
}

const PREVIEW_CHARS: usize = 140;

/// A message as one quiet line: no chat blocks, no attachment markers, no
/// markdown syntax.
pub(crate) fn preview_of(content: &str) -> Option<String> {
    let mut words = Vec::new();
    let mut in_fence = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence
            || ((trimmed.starts_with("[Image: ") || trimmed.starts_with("[File: "))
                && trimmed.ends_with(']'))
        {
            continue;
        }
        let bare = trimmed.trim_start_matches(['#', '>', '-', '*', ' ']);
        words.extend(
            bare.split_whitespace()
                .map(|word| word.trim_matches(|c| matches!(c, '*' | '_' | '`'))),
        );
    }
    let line = words
        .into_iter()
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if line.is_empty() {
        return None;
    }
    Some(line.chars().take(PREVIEW_CHARS).collect())
}

async fn visible_tasks(repos: &Repositories) -> Result<GeneralTaskList, AppError> {
    let rows=query("SELECT id,title,prompt,status,safety_profile,progress_summary,last_error,hermes_session_id,model,created_at,updated_at,completed_at,(SELECT content FROM agent_messages m WHERE m.task_id=agent_tasks.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message,(SELECT role FROM agent_messages m WHERE m.task_id=agent_tasks.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_role FROM agent_tasks WHERE safety_profile NOT IN ('custom_assistant','customAssistant') AND NOT EXISTS(SELECT 1 FROM assistant_conversations WHERE task_id=agent_tasks.id) ORDER BY updated_at DESC,rowid DESC LIMIT 200").fetch_all(&repos.pool).await?;
    Ok(GeneralTaskList {
        items: rows
            .into_iter()
            .map(|row| {
                let last_message: Option<String> = row.get("last_message");
                let last_message_role: Option<String> = row.get("last_role");
                GeneralTaskListItem {
                    last_message_preview: last_message.as_deref().and_then(preview_of),
                    last_message_role,
                    task: crate::db::repositories::agent_task_from_row(row),
                }
            })
            .collect(),
    })
}
pub(crate) async fn list(app: &AppHandle) -> Result<GeneralTaskList, AppError> {
    let repos = crate::commands::repositories(app).await?;
    repos.complete_agent_tasks_with_assistant_messages().await?;
    let response = visible_tasks(&repos).await?;
    for item in &response.items {
        if let Err(error) =
            crate::commands::hydrate_agent_task_from_hermes(app, &repos, &item.task.id).await
        {
            tracing::debug!(task_id=%item.task.id,code=%error.code,"General chat hydration deferred");
        }
    }
    visible_tasks(&repos).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_is_one_quiet_line() {
        assert_eq!(
            preview_of("## Budget\n\n- **Keep** the `reserve`\n[Image: a.jpg]").as_deref(),
            Some("Budget Keep the reserve")
        );
        assert_eq!(preview_of("```subrosa:place\n{}\n```"), None);
        assert_eq!(
            preview_of(&"word ".repeat(100)).unwrap().chars().count(),
            140
        );
    }
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
        assert_eq!(tasks.items[0].task.id, "general");
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
