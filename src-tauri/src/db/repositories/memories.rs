//! The memory store (ADR-0009, ADR-0064, ADR-0085). A child of
//! `repositories` so it reads the pool the way the rest of the store does,
//! in its own file so the store's file stops growing.
//!
//! Every query that feeds a model reads one scope: the store's
//! `memory_scope`. `None` is the user's own memory; a folder id is a project
//! whose memory mode is "Project only", and whose chats remember and recall
//! only what they learned there. A store answers the user's own memory unless
//! [`Repositories::with_memory_scope`] says otherwise, so a caller that never
//! heard of projects can never read a project's facts into another chat.
//! The management list and edits by id ignore the scope: the person sees and
//! controls everything.

use sqlx::query::query;
use sqlx::row::Row;
use uuid::Uuid;

use super::{memory_from_row, timestamp, MemoryEmbeddingRow, Repositories, MEMORY_COLUMNS};
use crate::domain::types::{AppError, MemoryDto, MemorySource};

impl Repositories {
    /// The same store, reading and writing the memory of `scope`.
    pub fn with_memory_scope(&self, scope: Option<String>) -> Self {
        Self {
            pool: self.pool.clone(),
            memory_scope: scope,
        }
    }

    pub fn memory_scope(&self) -> Option<&str> {
        self.memory_scope.as_deref()
    }

    /// Every memory, newest first, for the management UI (disabled ones
    /// included so the user can re-enable them), whatever its scope.
    pub async fn list_memories(&self) -> Result<Vec<MemoryDto>, sqlx::error::Error> {
        let rows = query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memories ORDER BY created_at DESC, rowid DESC"
        ))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(memory_from_row).collect())
    }

    /// Stores a fact in this store's scope.
    pub async fn insert_memory(
        &self,
        text: &str,
        source: MemorySource,
        importance: i64,
    ) -> Result<MemoryDto, sqlx::error::Error> {
        let now = timestamp();
        let memory = MemoryDto {
            id: Uuid::new_v4().to_string(),
            text: text.trim().to_string(),
            source,
            importance: importance.clamp(1, 10),
            disabled: false,
            has_embedding: false,
            created_at: now.clone(),
            updated_at: now,
            scope: self.memory_scope.clone(),
        };
        query(
            "INSERT INTO memories (id, text, source, importance, disabled, created_at, updated_at, scope)
             VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(&memory.id)
        .bind(&memory.text)
        .bind(memory.source.as_db())
        .bind(memory.importance)
        .bind(&memory.created_at)
        .bind(&memory.updated_at)
        .bind(&memory.scope)
        .execute(&self.pool)
        .await?;
        Ok(memory)
    }

    /// Case-insensitive existence check within this scope, so the extractor
    /// never stores the same fact twice (the model also sees existing
    /// memories, but this guard is the deterministic backstop). A project
    /// may hold a fact the user's own memory also holds.
    pub async fn memory_with_text_exists(&self, text: &str) -> Result<bool, sqlx::error::Error> {
        let row = query(
            "SELECT 1 FROM memories WHERE lower(trim(text)) = lower(trim(?)) AND scope IS ? LIMIT 1",
        )
        .bind(text)
        .bind(&self.memory_scope)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    /// Edits a memory's text and/or disabled flag. A text change clears the
    /// stored embedding — the vector describes the old wording.
    pub async fn update_memory(
        &self,
        memory_id: &str,
        text: Option<&str>,
        disabled: Option<bool>,
    ) -> Result<MemoryDto, AppError> {
        let now = timestamp();
        if let Some(text) = text.map(str::trim).filter(|value| !value.is_empty()) {
            query("UPDATE memories SET text = ?, embedding = NULL, updated_at = ? WHERE id = ?")
                .bind(text)
                .bind(&now)
                .bind(memory_id)
                .execute(&self.pool)
                .await?;
        }
        if let Some(disabled) = disabled {
            query("UPDATE memories SET disabled = ?, updated_at = ? WHERE id = ?")
                .bind(disabled as i64)
                .bind(&now)
                .bind(memory_id)
                .execute(&self.pool)
                .await?;
        }
        let row = query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memories WHERE id = ?"
        ))
        .bind(memory_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::new("memory_not_found", "Memory was not found."))?;
        Ok(memory_from_row(row))
    }

    pub async fn delete_memory(&self, memory_id: &str) -> Result<(), AppError> {
        let result = query("DELETE FROM memories WHERE id = ?")
            .bind(memory_id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new("memory_not_found", "Memory was not found."));
        }
        Ok(())
    }

    pub async fn delete_all_memories(&self) -> Result<(), sqlx::error::Error> {
        query("DELETE FROM memories").execute(&self.pool).await?;
        Ok(())
    }

    /// The prompt-injection set: enabled memories of this scope, most
    /// important first (importance 1 beats 10), newest first within a tier.
    pub async fn top_memories(&self, limit: i64) -> Result<Vec<MemoryDto>, sqlx::error::Error> {
        let rows = query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memories
             WHERE disabled = 0 AND scope IS ?
             ORDER BY importance ASC, created_at DESC, rowid DESC
             LIMIT ?"
        ))
        .bind(&self.memory_scope)
        .bind(limit.clamp(1, 200))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(memory_from_row).collect())
    }

    /// Keyword recall over enabled memories of this scope (same LIKE pattern
    /// as [`Self::search_note_context`]); the semantic half of recall merges
    /// with this in `memory::recall`.
    pub async fn search_memories(
        &self,
        search: &str,
        limit: i64,
    ) -> Result<Vec<MemoryDto>, sqlx::error::Error> {
        let pattern = format!(
            "%{}%",
            search
                .trim()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let rows = query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memories
             WHERE disabled = 0 AND scope IS ? AND text LIKE ? ESCAPE '\\'
             ORDER BY importance ASC, created_at DESC
             LIMIT ?"
        ))
        .bind(&self.memory_scope)
        .bind(&pattern)
        .bind(limit.clamp(1, 50))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(memory_from_row).collect())
    }

    /// Memories still awaiting a vector, oldest first, for the best-effort
    /// embedding backfill. Every scope: a vector is a vector.
    pub async fn memories_missing_embedding(
        &self,
        limit: i64,
    ) -> Result<Vec<MemoryDto>, sqlx::error::Error> {
        let rows = query(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memories
             WHERE embedding IS NULL AND disabled = 0
             ORDER BY created_at ASC
             LIMIT ?"
        ))
        .bind(limit.clamp(1, 200))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(memory_from_row).collect())
    }

    pub async fn set_memory_embedding(
        &self,
        memory_id: &str,
        embedding: &[u8],
    ) -> Result<(), sqlx::error::Error> {
        query("UPDATE memories SET embedding = ? WHERE id = ?")
            .bind(embedding)
            .bind(memory_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Enabled memories of this scope with their raw embedding bytes
    /// (little-endian f32), for in-process cosine scoring during recall.
    pub async fn memories_with_embeddings(
        &self,
    ) -> Result<Vec<MemoryEmbeddingRow>, sqlx::error::Error> {
        let rows = query(&format!(
            "SELECT {MEMORY_COLUMNS}, embedding FROM memories WHERE disabled = 0 AND scope IS ?"
        ))
        .bind(&self.memory_scope)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let embedding: Option<Vec<u8>> = row.get("embedding");
                MemoryEmbeddingRow {
                    memory: memory_from_row(row),
                    embedding,
                }
            })
            .collect())
    }

    /// Enabled memories of this scope matching an FTS5 expression (any of
    /// the query's content words, see `ask::passages_match`), best bm25 first.
    pub async fn search_memories_fts(
        &self,
        fts: &str,
        limit: i64,
    ) -> Result<Vec<MemoryDto>, sqlx::error::Error> {
        // MEMORY_COLUMNS, qualified: the FTS table has a `text` column too.
        let rows = query(
            "SELECT m.id, m.text, m.source, m.importance, m.disabled,
                    m.embedding IS NOT NULL AS has_embedding, m.created_at, m.updated_at, m.scope
             FROM memories_fts f
             JOIN memories m ON m.id = f.memory_id
             WHERE memories_fts MATCH ?1 AND m.disabled = 0 AND m.scope IS ?3
             ORDER BY bm25(memories_fts)
             LIMIT ?2",
        )
        .bind(fts)
        .bind(limit.clamp(1, 50))
        .bind(&self.memory_scope)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(memory_from_row).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> Repositories {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        Repositories::new(pool)
    }

    #[tokio::test]
    async fn a_project_memory_never_reaches_the_users_own_and_back() {
        let own = store().await;
        let project = own.with_memory_scope(Some("folder-1".into()));
        own.insert_memory("Prefers French", MemorySource::Auto, 2)
            .await
            .unwrap();
        let kept = project
            .insert_memory("The launch is in March", MemorySource::Auto, 3)
            .await
            .unwrap();
        assert_eq!(kept.scope.as_deref(), Some("folder-1"));

        let texts = |memories: Vec<MemoryDto>| -> Vec<String> {
            memories.into_iter().map(|m| m.text).collect()
        };
        assert_eq!(
            texts(own.top_memories(20).await.unwrap()),
            ["Prefers French"]
        );
        assert_eq!(
            texts(project.top_memories(20).await.unwrap()),
            ["The launch is in March"]
        );
        assert!(own.search_memories("launch", 8).await.unwrap().is_empty());
        assert!(own
            .search_memories_fts("\"launch\"", 8)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            project
                .search_memories_fts("\"launch\"", 8)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(own
            .memories_with_embeddings()
            .await
            .unwrap()
            .iter()
            .all(|row| row.memory.scope.is_none()));
        // A fact the user's own memory holds is no duplicate in a project.
        assert!(!project
            .memory_with_text_exists("prefers french")
            .await
            .unwrap());
        assert!(own.memory_with_text_exists("prefers french").await.unwrap());
        // The person sees everything.
        assert_eq!(own.list_memories().await.unwrap().len(), 2);
        // Another project sees neither.
        let other = own.with_memory_scope(Some("folder-2".into()));
        assert!(other.top_memories(20).await.unwrap().is_empty());
    }
}
