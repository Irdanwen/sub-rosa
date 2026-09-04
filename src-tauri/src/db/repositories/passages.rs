//! Passage retrieval for "Ask your notes" (ADR-0044): the rows an
//! any-of-terms FTS5 expression matches, best first, cut around the first
//! content word found. A child of `repositories` so it reads the pool the
//! way the rest of the store does, in its own file so the store's file
//! stops growing.

use sqlx::query::query;
use sqlx::row::Row as _;

use super::{snippet_around_match, NoteContextSnippet, Repositories};

impl Repositories {
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
    ) -> Result<Vec<NoteContextSnippet>, sqlx::error::Error> {
        let limit = limit.clamp(1, 20);
        let rows = query(
            "SELECT n.id AS id, n.title AS title,
                    COALESCE(n.edited_content, n.generated_content, '') AS content,
                    n.updated_at AS updated_at
             FROM notes_fts f
             JOIN notes n ON n.id = f.note_id
             WHERE notes_fts MATCH ?1
             ORDER BY bm25(notes_fts, 0.0, 2.0, 1.0)
             LIMIT ?2",
        )
        .bind(fts)
        .bind(limit)
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
             WHERE transcripts_fts MATCH ?1
             ORDER BY bm25(transcripts_fts)
             LIMIT ?2",
        )
        .bind(fts)
        .bind(remaining * 4)
        .fetch_all(&self.pool)
        .await?;
        let mut seen: std::collections::HashSet<String> =
            passages.iter().map(|p| p.note_id.clone()).collect();
        for row in rows {
            if passages.len() as i64 >= limit {
                break;
            }
            let note_id: String = row.get("note_id");
            if !seen.insert(note_id.clone()) {
                continue;
            }
            let turn_index: Option<i64> = row.get("turn_index");
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
