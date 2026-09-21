//! Conversation branching preserves the portable assistant snapshot alongside
//! visible history, without copying execution state or replaying tools.
use super::{timestamp, Repositories};
use crate::domain::types::AgentTaskDto;
use sqlx::query::query;
use uuid::Uuid;

impl Repositories {
    /// Duplicate a chat onto another model: a new task carrying the source
    /// transcript verbatim, bound to `model` (falling back to the source's own
    /// model when none is given). Lets a conversation branch onto a different
    /// model while the original stays untouched. Only messages are copied — tool
    /// events are per-run and do not shape the model's view of the history.
    pub async fn fork_agent_task(
        &self,
        source_task_id: &str,
        model: Option<&str>,
    ) -> Result<AgentTaskDto, sqlx::error::Error> {
        let source = self.get_agent_task(source_task_id).await?;
        let now = timestamp();
        let new_task_id = Uuid::new_v4().to_string();
        let model = model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or(source.model.clone());

        let mut tx = self.pool.begin().await?;
        // A fork is an idle snapshot to continue from, never active work, so it
        // opens 'completed' rather than inheriting a transient running/queued
        // status from the source (which would read as a phantom running task).
        query(
            "INSERT INTO agent_tasks
             (id, title, prompt, status, safety_profile, progress_summary, model, created_at, updated_at)
             VALUES (?, ?, ?, 'completed', ?, 'Forked to another model.', ?, ?, ?)",
        )
        .bind(&new_task_id)
        .bind(&source.title)
        .bind(&source.prompt)
        .bind(source.safety_profile.as_db())
        .bind(&model)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        // Preserve order by carrying each message's original created_at (agent
        // messages sort by created_at ASC), so the fork reads as the same thread.
        for message in &source.messages {
            query(
                "INSERT INTO agent_messages (id, task_id, role, content, created_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&new_task_id)
            .bind(message.role.as_db())
            .bind(&message.content)
            .bind(&message.created_at)
            .execute(&mut *tx)
            .await?;
        }
        // A fork retains the source assistant's immutable permissions and
        // references. Copying only the transcript would grant default tools.
        // The explicitly selected fork model is the sole snapshot override.
        query("INSERT INTO assistant_conversations(task_id,assistant_id,snapshot_json,created_at) SELECT ?,assistant_id,json_set(snapshot_json,'$.definition.model',?),? FROM assistant_conversations WHERE task_id=?")
            .bind(&new_task_id).bind(model.as_deref().unwrap_or("")).bind(&now).bind(source_task_id).execute(&mut *tx).await?;
        tx.commit().await?;
        self.get_agent_task(&new_task_id).await
    }
}
