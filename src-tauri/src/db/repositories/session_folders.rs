//! A chat's folders. A child of `repositories` in its own file so the store's
//! file stops growing.
//!
//! `session_folders` keys a desktop chat by its Hermes session id and a phone
//! chat (or a chat filed on another device and synchronised here) by its task
//! id. The portable conversation links the two (`agent_tasks.hermes_session_id`),
//! so a membership is answered under both ids and removed under both: the
//! desktop finds a chat the phone archived, and restoring it on the desktop
//! clears the row the phone wrote (ADR-0080).

use sqlx::query::query;
use sqlx::row::Row;

use super::{timestamp, Repositories};
use crate::domain::types::SessionFolderDto;

impl Repositories {
    pub async fn list_session_folders(&self) -> Result<Vec<SessionFolderDto>, sqlx::error::Error> {
        let rows = query(
            "WITH live AS (
                 SELECT sf.session_id, sf.folder_id, sf.assigned_at
                 FROM session_folders sf
                 INNER JOIN folders f ON f.id = sf.folder_id
                 WHERE f.deleted_at IS NULL
             ),
             aliased AS (
                 SELECT session_id, folder_id, assigned_at FROM live
                 UNION ALL
                 SELECT t.hermes_session_id, l.folder_id, l.assigned_at
                 FROM live l INNER JOIN agent_tasks t ON t.id = l.session_id
                 WHERE t.hermes_session_id IS NOT NULL
                 UNION ALL
                 SELECT t.id, l.folder_id, l.assigned_at
                 FROM live l INNER JOIN agent_tasks t ON t.hermes_session_id = l.session_id
             )
             SELECT session_id, folder_id, MIN(assigned_at) AS assigned_at
             FROM aliased
             GROUP BY session_id, folder_id
             ORDER BY assigned_at ASC, session_id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SessionFolderDto {
                session_id: row.get("session_id"),
                folder_id: row.get("folder_id"),
            })
            .collect())
    }

    pub async fn assign_session_to_folder(
        &self,
        session_id: &str,
        folder_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "INSERT OR IGNORE INTO session_folders (session_id, folder_id, assigned_at) VALUES (?, ?, ?)",
        )
        .bind(session_id)
        .bind(folder_id)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Removes the membership under the id given and under the other id the
    /// same chat is known by, so a restore clears what any device wrote.
    pub async fn remove_session_from_folder(
        &self,
        session_id: &str,
        folder_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "DELETE FROM session_folders
             WHERE folder_id = ?2
               AND (session_id = ?1
                    OR session_id IN (SELECT id FROM agent_tasks WHERE hermes_session_id = ?1)
                    OR session_id IN (SELECT hermes_session_id FROM agent_tasks
                                      WHERE id = ?1 AND hermes_session_id IS NOT NULL))",
        )
        .bind(session_id)
        .bind(folder_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_sqlite::SqlitePoolOptions;

    async fn store() -> Repositories {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        query("INSERT INTO folders (id, name, created_at, updated_at) VALUES ('archive', 'Archive', 'now', 'now')")
            .execute(&pool)
            .await
            .unwrap();
        // A desktop chat (Hermes session `h1`) mirrored into a conversation.
        query("INSERT INTO agent_tasks (id, title, prompt, status, safety_profile, created_at, updated_at, hermes_session_id) VALUES ('task-1', 'T', 'P', 'completed', 'autonomous_private', 'now', 'now', 'h1')")
            .execute(&pool)
            .await
            .unwrap();
        Repositories { pool }
    }

    fn pairs(rows: Vec<SessionFolderDto>) -> Vec<(String, String)> {
        let mut pairs: Vec<_> = rows
            .into_iter()
            .map(|row| (row.session_id, row.folder_id))
            .collect();
        pairs.sort();
        pairs
    }

    #[tokio::test]
    async fn a_chat_archived_on_the_phone_shows_under_its_desktop_session_id() {
        let store = store().await;
        // The phone files the conversation by its task id.
        store
            .assign_session_to_folder("task-1", "archive")
            .await
            .unwrap();

        let listed = pairs(store.list_session_folders().await.unwrap());

        assert_eq!(
            listed,
            vec![
                ("h1".to_string(), "archive".to_string()),
                ("task-1".to_string(), "archive".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn a_chat_archived_on_the_desktop_shows_under_its_task_id() {
        let store = store().await;
        store
            .assign_session_to_folder("h1", "archive")
            .await
            .unwrap();

        let listed = pairs(store.list_session_folders().await.unwrap());

        assert!(listed.contains(&("task-1".to_string(), "archive".to_string())));
        assert!(listed.contains(&("h1".to_string(), "archive".to_string())));
        assert_eq!(listed.len(), 2, "one membership, two names, no duplicates");
    }

    #[tokio::test]
    async fn restoring_by_either_id_clears_what_any_device_wrote() {
        let store = store().await;
        store
            .assign_session_to_folder("task-1", "archive")
            .await
            .unwrap();
        store
            .assign_session_to_folder("h1", "archive")
            .await
            .unwrap();

        store
            .remove_session_from_folder("h1", "archive")
            .await
            .unwrap();

        assert!(store.list_session_folders().await.unwrap().is_empty());

        store
            .assign_session_to_folder("h1", "archive")
            .await
            .unwrap();
        store
            .remove_session_from_folder("task-1", "archive")
            .await
            .unwrap();
        assert!(store.list_session_folders().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unlinked_chat_keeps_its_own_id_only() {
        let store = store().await;
        store
            .assign_session_to_folder("h2", "archive")
            .await
            .unwrap();

        let listed = pairs(store.list_session_folders().await.unwrap());

        assert_eq!(listed, vec![("h2".to_string(), "archive".to_string())]);
    }
}
