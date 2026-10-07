//! Conversation branching preserves the portable assistant snapshot alongside
//! visible history, without copying execution state or replaying tools.
//!
//! The same module holds the two ways a conversation's tail is rewritten in
//! place (asking the last question again, and editing it). Anything earlier
//! than the last question is never rewritten: it is branched instead, so
//! nothing the user already read disappears (ADR-0079).
use super::{timestamp, Repositories};
use crate::domain::types::{AgentMessageDto, AgentMessageRole, AgentTaskDto};
use sqlx::query::query;
use uuid::Uuid;

/// Where a branch ends in the source transcript.
#[derive(Debug, Clone, Copy)]
pub enum ForkCut<'a> {
    /// Up to and including this message ("Branch from here").
    Through(&'a str),
    /// Everything before this message (editing an earlier question).
    Before(&'a str),
}

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
        self.fork_agent_task_until(source_task_id, model, None, None)
            .await
    }

    /// [`Self::fork_agent_task`], cut at a message. With `ask`, the branch
    /// ends on that new question and opens queued, in the same transaction,
    /// so a crash can never leave a branch holding an unanswered question
    /// under a status the resume sweep ignores. A cut naming a message the
    /// source does not hold is `RowNotFound`.
    pub async fn fork_agent_task_until(
        &self,
        source_task_id: &str,
        model: Option<&str>,
        cut: Option<ForkCut<'_>>,
        ask: Option<&str>,
    ) -> Result<AgentTaskDto, sqlx::error::Error> {
        let source = self.get_agent_task(source_task_id).await?;
        let messages: &[AgentMessageDto] = match cut {
            None => &source.messages,
            Some(cut) => {
                let (id, through) = match cut {
                    ForkCut::Through(id) => (id, true),
                    ForkCut::Before(id) => (id, false),
                };
                let index = source
                    .messages
                    .iter()
                    .position(|message| message.id == id)
                    .ok_or(sqlx::error::Error::RowNotFound)?;
                &source.messages[..index + usize::from(through)]
            }
        };
        let now = timestamp();
        let new_task_id = Uuid::new_v4().to_string();
        let model = model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or(source.model.clone());
        let summary = match (cut, ask) {
            (_, Some(_)) => "Queued for the agent runtime.",
            (Some(_), None) => "Branched from an earlier message.",
            (None, None) => "Forked to another model.",
        };

        let mut tx = self.pool.begin().await?;
        // A fork is an idle snapshot to continue from, never active work, so it
        // opens 'completed' rather than inheriting a transient running/queued
        // status from the source (which would read as a phantom running task).
        // A branch that asks a new question is the one exception: it is work.
        query(
            "INSERT INTO agent_tasks
             (id, title, prompt, status, safety_profile, progress_summary, model, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&new_task_id)
        .bind(&source.title)
        .bind(&source.prompt)
        .bind(if ask.is_some() { "queued" } else { "completed" })
        .bind(source.safety_profile.as_db())
        .bind(summary)
        .bind(&model)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        // Preserve order by carrying each message's original created_at (agent
        // messages sort by created_at ASC), so the fork reads as the same thread.
        for message in messages {
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
        if let Some(content) = ask {
            query(
                "INSERT INTO agent_messages (id, task_id, role, content, created_at)
                 VALUES (?, ?, 'user', ?, ?)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&new_task_id)
            .bind(content)
            .bind(&now)
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

    /// Drop every reply after the conversation's last question and queue the
    /// task, so the question can be answered again ("Regenerate"). Returns how
    /// many messages went; `RowNotFound` when there is no question to answer.
    ///
    /// Each message is deleted as a row, which is what the sync outbox
    /// triggers turn into a tombstone: the reply disappears on the user's
    /// other devices too, instead of coming back with the next pull.
    pub async fn rewind_to_last_user_message(
        &self,
        task_id: &str,
    ) -> Result<usize, sqlx::error::Error> {
        let task = self.get_agent_task(task_id).await?;
        let last = task
            .messages
            .iter()
            .rposition(|message| message.role == AgentMessageRole::User)
            .ok_or(sqlx::error::Error::RowNotFound)?;
        let mut tx = self.pool.begin().await?;
        let dropped = drop_after(&mut tx, task_id, &task.messages[last + 1..]).await?;
        queue(&mut tx, task_id).await?;
        tx.commit().await?;
        Ok(dropped)
    }

    /// Rewrite the conversation's last question in place and drop what
    /// followed it, queued to be answered again. `false`, with nothing
    /// written, when `message_id` is not the last question: an earlier one is
    /// branched rather than rewritten.
    pub async fn rewrite_last_user_message(
        &self,
        task_id: &str,
        message_id: &str,
        content: &str,
    ) -> Result<bool, sqlx::error::Error> {
        let task = self.get_agent_task(task_id).await?;
        let Some(last) = task
            .messages
            .iter()
            .rposition(|message| message.role == AgentMessageRole::User)
            .filter(|index| task.messages[*index].id == message_id)
        else {
            return Ok(false);
        };
        let mut tx = self.pool.begin().await?;
        query("UPDATE agent_messages SET content = ? WHERE id = ? AND task_id = ?")
            .bind(content)
            .bind(message_id)
            .bind(task_id)
            .execute(&mut *tx)
            .await?;
        drop_after(&mut tx, task_id, &task.messages[last + 1..]).await?;
        queue(&mut tx, task_id).await?;
        tx.commit().await?;
        Ok(true)
    }
}

async fn drop_after(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    task_id: &str,
    messages: &[AgentMessageDto],
) -> Result<usize, sqlx::error::Error> {
    for message in messages {
        query("DELETE FROM agent_messages WHERE id = ? AND task_id = ?")
            .bind(&message.id)
            .bind(task_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(messages.len())
}

async fn queue(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    task_id: &str,
) -> Result<(), sqlx::error::Error> {
    query(
        "UPDATE agent_tasks
         SET status = 'queued', progress_summary = 'Queued for the agent runtime.',
             last_error = NULL, updated_at = ?
         WHERE id = ?",
    )
    .bind(timestamp())
    .bind(task_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
