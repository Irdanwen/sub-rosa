//! Memory retrieval by word (ADR-0009, ADR-0064): the enabled memories an
//! any-of-terms FTS5 expression matches, best first. A child of
//! `repositories` so it reads the pool the way the rest of the store does,
//! in its own file so the store's file stops growing.

use sqlx::query::query;

use super::{memory_from_row, Repositories};
use crate::domain::types::MemoryDto;

impl Repositories {
    /// Enabled memories matching an FTS5 expression (any of the query's
    /// content words, see `ask::passages_match`), best bm25 first.
    pub async fn search_memories_fts(
        &self,
        fts: &str,
        limit: i64,
    ) -> Result<Vec<MemoryDto>, sqlx::error::Error> {
        // MEMORY_COLUMNS, qualified: the FTS table has a `text` column too.
        let rows = query(
            "SELECT m.id, m.text, m.source, m.importance, m.disabled,
                    m.embedding IS NOT NULL AS has_embedding, m.created_at, m.updated_at
             FROM memories_fts f
             JOIN memories m ON m.id = f.memory_id
             WHERE memories_fts MATCH ?1 AND m.disabled = 0
             ORDER BY bm25(memories_fts)
             LIMIT ?2",
        )
        .bind(fts)
        .bind(limit.clamp(1, 50))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(memory_from_row).collect())
    }
}
