//! Passage retrieval for "Ask your notes" (ADR-0044): the rows an
//! any-of-terms FTS5 expression matches, best first, cut around the first
//! content word found. A child of `repositories` so it reads the pool the
//! way the rest of the store does, in its own file so the store's file
//! stops growing.

use sqlx::query::query;
use sqlx::row::Row as _;

use super::{snippet_around_match, NoteContextSnippet, Repositories};

/// What a note's passages are cut from (ADR-0046).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PassageSource {
    pub title: String,
    pub content: String,
    /// `(turn_index, text)` in order.
    pub turns: Vec<(i64, String)>,
    pub updated_at: String,
}

/// A stored passage, with its vector when the backfill has reached it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPassage {
    pub id: String,
    pub note_id: String,
    pub kind: String,
    pub ordinal: i64,
    pub text: String,
    pub embedding: Option<Vec<u8>>,
}

impl Repositories {
    /// The text a note's passages are cut from: title, body, transcript turns.
    pub async fn passage_source(
        &self,
        note_id: &str,
    ) -> Result<Option<PassageSource>, sqlx::error::Error> {
        let Some(row) = query(
            "SELECT title, COALESCE(edited_content, generated_content, '') AS content, updated_at
             FROM notes WHERE id = ?1",
        )
        .bind(note_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let turns = query(
            "SELECT COALESCE(turn_index, rowid) AS turn_index, text FROM transcripts
             WHERE note_id = ?1 AND trim(COALESCE(text, '')) != ''
             ORDER BY turn_index, rowid",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|turn| {
            (
                turn.get::<i64, _>("turn_index"),
                turn.get::<String, _>("text"),
            )
        })
        .collect();
        Ok(Some(PassageSource {
            title: row.get("title"),
            content: row.get("content"),
            turns,
            updated_at: row.get("updated_at"),
        }))
    }

    /// The hash the stored passages of a note were cut from, if any.
    pub async fn passages_hash(&self, note_id: &str) -> Result<Option<String>, sqlx::error::Error> {
        let row = query("SELECT content_hash FROM note_passages WHERE note_id = ?1 LIMIT 1")
            .bind(note_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| row.get("content_hash")))
    }

    /// Replace a note's passages with a freshly cut set (vectors start empty).
    pub async fn replace_passages(
        &self,
        note_id: &str,
        content_hash: &str,
        passages: &[(String, String)],
    ) -> Result<(), sqlx::error::Error> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut tx = self.pool.begin().await?;
        query("DELETE FROM note_passages WHERE note_id = ?1")
            .bind(note_id)
            .execute(&mut *tx)
            .await?;
        for (ordinal, (kind, text)) in passages.iter().enumerate() {
            query(
                "INSERT INTO note_passages (id, note_id, kind, ordinal, text, content_hash, embedding, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            )
            .bind(format!("{note_id}:{kind}:{ordinal}"))
            .bind(note_id)
            .bind(kind)
            .bind(ordinal as i64)
            .bind(text)
            .bind(content_hash)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }

    /// Notes whose passages are missing or older than the note itself.
    pub async fn notes_with_stale_passages(
        &self,
        limit: i64,
    ) -> Result<Vec<String>, sqlx::error::Error> {
        let rows = query(
            "SELECT n.id AS id FROM notes n
             LEFT JOIN (SELECT note_id, max(updated_at) AS cut_at FROM note_passages GROUP BY note_id) p
               ON p.note_id = n.id
             WHERE p.note_id IS NULL OR p.cut_at < n.updated_at
             ORDER BY n.updated_at DESC
             LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| row.get("id")).collect())
    }

    /// Passages the backfill has not embedded yet, oldest first.
    pub async fn passages_missing_embedding(
        &self,
        limit: i64,
    ) -> Result<Vec<StoredPassage>, sqlx::error::Error> {
        let rows = query(
            "SELECT id, note_id, kind, ordinal, text FROM note_passages
             WHERE embedding IS NULL ORDER BY updated_at, ordinal LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| StoredPassage {
                id: row.get("id"),
                note_id: row.get("note_id"),
                kind: row.get("kind"),
                ordinal: row.get("ordinal"),
                text: row.get("text"),
                embedding: None,
            })
            .collect())
    }

    pub async fn set_passage_embedding(
        &self,
        id: &str,
        embedding: &[u8],
    ) -> Result<(), sqlx::error::Error> {
        query("UPDATE note_passages SET embedding = ?2 WHERE id = ?1")
            .bind(id)
            .bind(embedding)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Every embedded passage, for a cosine scan.
    pub async fn passages_with_embeddings(&self) -> Result<Vec<StoredPassage>, sqlx::error::Error> {
        let rows = query(
            "SELECT id, note_id, kind, ordinal, text, embedding FROM note_passages
             WHERE embedding IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| StoredPassage {
                id: row.get("id"),
                note_id: row.get("note_id"),
                kind: row.get("kind"),
                ordinal: row.get("ordinal"),
                text: row.get("text"),
                embedding: row.get("embedding"),
            })
            .collect())
    }

    /// Titles for a set of note ids (a note that is gone is simply absent).
    pub async fn note_titles(
        &self,
        ids: &[String],
    ) -> Result<std::collections::HashMap<String, String>, sqlx::error::Error> {
        let mut titles = std::collections::HashMap::new();
        for id in ids {
            if let Some(row) = query("SELECT title FROM notes WHERE id = ?1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
            {
                titles.insert(id.clone(), row.get::<String, _>("title"));
            }
        }
        Ok(titles)
    }

    /// How many passages exist, and how many carry a vector.
    pub async fn passages_counts(&self) -> Result<(i64, i64), sqlx::error::Error> {
        let row =
            query("SELECT count(*) AS total, count(embedding) AS embedded FROM note_passages")
                .fetch_one(&self.pool)
                .await?;
        Ok((row.get("total"), row.get("embedded")))
    }

    /// Forget every passage and vector (the setting turned off, or a reset).
    pub async fn clear_passages(&self) -> Result<u64, sqlx::error::Error> {
        Ok(query("DELETE FROM note_passages")
            .execute(&self.pool)
            .await?
            .rows_affected())
    }

    /// Passages for "Ask your notes": rows matching `fts` (an any-of-terms
    /// expression built by `ask::passages_match`), best first. Notes come
    /// first, cut around the first content word found; then transcripts,
    /// one passage per note not already present, made of the matching turn
    /// and its neighbours so a sentence keeps its context.
    pub async fn retrieve_passages(
        &self,
        fts: &str,
        terms: &[String],
        limit: i64,
        note_id: Option<&str>,
    ) -> Result<Vec<NoteContextSnippet>, sqlx::error::Error> {
        let limit = limit.clamp(1, 20);
        // A scope of one note ("Ask this note"): the same ranking, kept to
        // that note's rows. An empty scope string matches nothing, so the
        // filter is an equality with a bound value or no filter at all.
        let scope = note_id.unwrap_or("");
        let rows = query(
            "SELECT n.id AS id, n.title AS title,
                    COALESCE(n.edited_content, n.generated_content, '') AS content,
                    n.updated_at AS updated_at
             FROM notes_fts f
             JOIN notes n ON n.id = f.note_id
             WHERE notes_fts MATCH ?1 AND (?3 = '' OR f.note_id = ?3)
             ORDER BY bm25(notes_fts, 0.0, 2.0, 1.0)
             LIMIT ?2",
        )
        .bind(fts)
        .bind(limit)
        .bind(scope)
        .fetch_all(&self.pool)
        .await?;
        let mut passages: Vec<NoteContextSnippet> = rows
            .into_iter()
            .map(|row| {
                let content: String = row.get("content");
                NoteContextSnippet {
                    note_id: row.get("id"),
                    title: row.get("title"),
                    kind: "note".to_string(),
                    snippet: snippet_around_any_term(&content, terms, 700),
                    updated_at: row.get("updated_at"),
                }
            })
            .collect();

        let remaining = limit - passages.len() as i64;
        if remaining <= 0 {
            return Ok(passages);
        }
        let rows = query(
            "SELECT f.note_id AS note_id, n.title AS title, t.turn_index AS turn_index,
                    t.created_at AS updated_at
             FROM transcripts_fts f
             JOIN transcripts t ON t.rowid = f.rowid
             JOIN notes n ON n.id = f.note_id
             WHERE transcripts_fts MATCH ?1 AND (?3 = '' OR f.note_id = ?3)
             ORDER BY bm25(transcripts_fts)
             LIMIT ?2",
        )
        .bind(fts)
        .bind(remaining * 4)
        .bind(scope)
        .fetch_all(&self.pool)
        .await?;
        // Within one note, several transcript passages may answer; across
        // notes, one per note keeps the other notes in the answer.
        let mut seen: std::collections::HashSet<String> = if note_id.is_some() {
            std::collections::HashSet::new()
        } else {
            passages.iter().map(|p| p.note_id.clone()).collect()
        };
        for row in rows {
            if passages.len() as i64 >= limit {
                break;
            }
            let note_id: String = row.get("note_id");
            let turn_index: Option<i64> = row.get("turn_index");
            let key = match scope.is_empty() {
                true => note_id.clone(),
                false => format!("{note_id}:{}", turn_index.unwrap_or(-1) / 5),
            };
            if !seen.insert(key) {
                continue;
            }
            let text = match turn_index {
                Some(index) => {
                    let turns = query(
                        "SELECT text FROM transcripts
                         WHERE note_id = ?1 AND turn_index BETWEEN ?2 AND ?3
                         ORDER BY turn_index",
                    )
                    .bind(&note_id)
                    .bind(index - 2)
                    .bind(index + 2)
                    .fetch_all(&self.pool)
                    .await?;
                    turns
                        .into_iter()
                        .map(|turn| turn.get::<String, _>("text"))
                        .collect::<Vec<_>>()
                        .join(" ")
                }
                None => String::new(),
            };
            passages.push(NoteContextSnippet {
                note_id,
                title: row.get("title"),
                kind: "transcript".to_string(),
                snippet: snippet_around_any_term(&text, terms, 700),
                updated_at: row.get("updated_at"),
            });
        }
        Ok(passages)
    }
}

/// `snippet_around_match` around whichever of `terms` occurs first in the
/// content; the head of the content when none does.
fn snippet_around_any_term(content: &str, terms: &[String], max_chars: usize) -> String {
    let lower = content.to_lowercase();
    let first = terms
        .iter()
        .filter_map(|term| lower.find(term.as_str()).map(|at| (at, term)))
        .min_by_key(|(at, _)| *at)
        .map(|(_, term)| term.as_str())
        .unwrap_or("");
    snippet_around_match(content, first, max_chars)
}
