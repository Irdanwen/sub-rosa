//! Passages of the notes, embedded, so a question finds a note that says
//! the same thing in other words (ADR-0046).
//!
//! The lexical index (migration 020) finds the words of the question. This
//! finds its meaning: every note body and transcript is cut into passages
//! of a few hundred characters, each passage gets a BGE-M3 vector through
//! the same direct `/embeddings` call the memory module makes (ADR-0009),
//! and "Ask your notes" merges the two rankings with reciprocal rank fusion.
//!
//! - **Passages, not notes.** A note is too long for one vector to mean
//!   anything; a passage of a paragraph or a handful of turns is the unit a
//!   citation points at anyway (ADR-0044).
//! - **Rows first, then work** (ADR-0018). A note that changed gets its
//!   passages re-cut with an empty vector; the backfill fills vectors in
//!   batches from the sweep and after notes change. Nothing here blocks a
//!   note, a search or a launch, and every failure leaves the lexical half
//!   doing the whole job.
//! - **It is a setting, and the ledger shows it.** Embedding sends the text
//!   of every note to the configured endpoint, in the background, which is
//!   more than the person asked for in any one moment. Settings › Privacy
//!   names it and turns it off, and turning it off forgets the vectors.
//!   Every call is a ledger row with the purpose `embeddings` (ADR-0043).

use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::repositories::{passages::StoredPassage, NoteContextSnippet, Repositories};
use crate::domain::types::AppError;
use crate::memory::recall::{cosine_similarity, decode_embedding, embed, encode_embedding};

const SETTINGS_FILE: &str = "ask.json";
/// A passage of a note body: a paragraph or two.
const PASSAGE_CHARS: usize = 700;
/// Transcript turns per passage, and how far each window slides.
const TURNS_PER_PASSAGE: usize = 6;
/// Passages embedded per backfill call; a two-hour transcript is a few
/// hundred passages, so a sweep clears it in a handful of calls.
const BACKFILL_BATCH: i64 = 32;
/// Notes re-cut per sweep. Bounded so a first launch on a big corpus does
/// not spend its first minute cutting; the next sweep continues.
const REFRESH_BATCH: i64 = 50;
const RRF_K: f64 = 60.0;

static SETTINGS: OnceLock<Mutex<AskSettings>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AskSettings {
    /// Cut and embed passages so questions match by meaning. On by default:
    /// the notes already go to this endpoint to be written; what is new is
    /// that they go once more, in the background, and the setting says so.
    pub semantic: bool,
}

impl Default for AskSettings {
    fn default() -> Self {
        Self { semantic: true }
    }
}

pub struct AskState {
    config_path: PathBuf,
}

fn mirror() -> &'static Mutex<AskSettings> {
    SETTINGS.get_or_init(|| Mutex::new(AskSettings::default()))
}

pub fn settings() -> AskSettings {
    mirror()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

fn replace_mirror(next: AskSettings) {
    *mirror().lock().unwrap_or_else(|poison| poison.into_inner()) = next;
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&PathBuf>) -> AskSettings {
    path.and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn persist(path: &PathBuf, settings: &AskSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("ask_settings_save", error.to_string()))?;
    }
    let text = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("ask_settings_save", error.to_string()))?;
    fs::write(path, text).map_err(|error| AppError::new("ask_settings_save", error.to_string()))
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    replace_mirror(load_from_disk(path.as_ref()));
    app.manage(AskState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
}

// --- Cutting -----------------------------------------------------------------

/// A note body cut into passages of about `PASSAGE_CHARS`, on paragraph
/// boundaries when there are any, on sentence boundaries otherwise.
pub fn chunk_body(content: &str) -> Vec<String> {
    let mut passages: Vec<String> = Vec::new();
    let mut current = String::new();
    for paragraph in content.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        if paragraph.chars().count() > PASSAGE_CHARS {
            // A paragraph longer than a passage: flush, then split it on
            // sentences so nothing is dropped.
            if !current.is_empty() {
                passages.push(std::mem::take(&mut current));
            }
            for sentence in split_sentences(paragraph) {
                if current.chars().count() + sentence.chars().count() > PASSAGE_CHARS
                    && !current.is_empty()
                {
                    passages.push(std::mem::take(&mut current));
                }
                if !current.is_empty() {
                    current.push(' ');
                }
                current.push_str(sentence);
            }
            continue;
        }
        if current.chars().count() + paragraph.chars().count() > PASSAGE_CHARS
            && !current.is_empty()
        {
            passages.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(paragraph);
    }
    if !current.trim().is_empty() {
        passages.push(current);
    }
    passages
}

fn split_sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (index, c) in text.char_indices() {
        if matches!(c, '.' | '!' | '?') {
            let end = index + c.len_utf8();
            let piece = text[start..end].trim();
            if !piece.is_empty() {
                out.push(piece);
            }
            start = end;
        }
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// Transcript turns cut into windows of `TURNS_PER_PASSAGE`.
pub fn chunk_turns(turns: &[(i64, String)]) -> Vec<String> {
    turns
        .chunks(TURNS_PER_PASSAGE)
        .map(|window| {
            window
                .iter()
                .map(|(_, text)| text.trim())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|passage| !passage.is_empty())
        .collect()
}

fn source_hash(title: &str, content: &str, turns: &[(i64, String)]) -> String {
    use sha2::Digest as _;
    let mut hasher = sha2::Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0]);
    hasher.update(content.as_bytes());
    for (index, text) in turns {
        hasher.update([0]);
        hasher.update(index.to_le_bytes());
        hasher.update(text.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Re-cut one note's passages when its source changed. Returns how many
/// passages the note has now, or `None` when nothing needed cutting.
pub async fn refresh_note(repos: &Repositories, note_id: &str) -> Result<Option<usize>, AppError> {
    let Some(source) = repos.passage_source(note_id).await? else {
        return Ok(None);
    };
    let hash = source_hash(&source.title, &source.content, &source.turns);
    if repos.passages_hash(note_id).await?.as_deref() == Some(hash.as_str()) {
        return Ok(None);
    }
    let mut passages: Vec<(String, String)> = chunk_body(&source.content)
        .into_iter()
        .map(|text| ("note".to_string(), text))
        .collect();
    passages.extend(
        chunk_turns(&source.turns)
            .into_iter()
            .map(|text| ("transcript".to_string(), text)),
    );
    let count = passages.len();
    repos.replace_passages(note_id, &hash, &passages).await?;
    Ok(Some(count))
}

/// Re-cut the notes whose passages are missing or stale, a batch at a time.
pub async fn refresh_stale(repos: &Repositories) -> Result<usize, AppError> {
    if !settings().semantic {
        return Ok(0);
    }
    let mut cut = 0;
    for note_id in repos.notes_with_stale_passages(REFRESH_BATCH).await? {
        if refresh_note(repos, &note_id).await?.is_some() {
            cut += 1;
        }
    }
    Ok(cut)
}

/// Give a vector to passages that have none, a batch per call. Best-effort:
/// offline or without a key it returns 0 and the passages wait.
pub async fn backfill(repos: &Repositories) -> Result<usize, AppError> {
    if !settings().semantic || crate::carpe_diem::settings::api_key().is_none() {
        return Ok(0);
    }
    let pending = repos.passages_missing_embedding(BACKFILL_BATCH).await?;
    if pending.is_empty() {
        return Ok(0);
    }
    let texts: Vec<String> = pending.iter().map(|p| p.text.clone()).collect();
    let vectors = embed(&texts).await?;
    let mut stored = 0;
    for (passage, vector) in pending.iter().zip(vectors.iter()) {
        repos
            .set_passage_embedding(&passage.id, &encode_embedding(vector))
            .await?;
        stored += 1;
    }
    Ok(stored)
}

/// Cut what is stale and embed what is pending, until the pending set is
/// empty or a call fails. Called from the sweep and after notes change.
pub async fn catch_up(app: &AppHandle) {
    if !settings().semantic {
        return;
    }
    let result: Result<(), AppError> = async {
        let repos = crate::commands::repositories(app).await?;
        refresh_stale(&repos).await?;
        // A bounded number of batches per pass: a launch is not the time
        // to embed a decade of notes, and the next sweep continues.
        for _ in 0..8 {
            if backfill(&repos).await? == 0 {
                break;
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::debug!("semantic passages: {error:?}");
    }
}

pub fn catch_up_detached(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { catch_up(&app).await });
}

// --- Retrieval ---------------------------------------------------------------

/// Passages closest to the question by meaning, best first. Empty when the
/// setting is off, the question cannot be embedded, or nothing is embedded.
pub async fn semantic_passages(
    repos: &Repositories,
    question: &str,
    limit: usize,
) -> Result<Vec<NoteContextSnippet>, AppError> {
    if !settings().semantic {
        return Ok(Vec::new());
    }
    let Ok(mut vectors) = embed(&[question.to_string()]).await else {
        return Ok(Vec::new());
    };
    if vectors.is_empty() {
        return Ok(Vec::new());
    }
    let query_vector = vectors.remove(0);
    let stored = repos.passages_with_embeddings().await?;
    let mut scored: Vec<(f32, StoredPassage)> = stored
        .into_iter()
        .filter_map(|passage| {
            let bytes = passage.embedding.as_deref()?;
            let score = cosine_similarity(&query_vector, &decode_embedding(bytes))?;
            Some((score, passage))
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    // One passage per note: the best one carries the note into the answer,
    // the answer cites the note, and a second passage of the same note
    // would only crowd out another note.
    let mut seen = std::collections::HashSet::new();
    let best: Vec<StoredPassage> = scored
        .into_iter()
        .filter(|(_, passage)| seen.insert(passage.note_id.clone()))
        .take(limit)
        .map(|(_, passage)| passage)
        .collect();
    let ids: Vec<String> = best.iter().map(|p| p.note_id.clone()).collect();
    let titles = repos.note_titles(&ids).await?;
    Ok(best
        .into_iter()
        .map(|passage| NoteContextSnippet {
            title: titles.get(&passage.note_id).cloned().unwrap_or_default(),
            note_id: passage.note_id,
            kind: passage.kind,
            snippet: passage.text,
            updated_at: String::new(),
        })
        .collect())
}

/// Reciprocal rank fusion of the lexical and the semantic lists, one entry
/// per note (the first passage a note appears with is the one kept).
pub fn fuse(
    lexical: Vec<NoteContextSnippet>,
    semantic: Vec<NoteContextSnippet>,
    limit: usize,
) -> Vec<NoteContextSnippet> {
    let mut scores: Vec<(f64, NoteContextSnippet)> = Vec::new();
    for list in [lexical, semantic] {
        for (rank, snippet) in list.into_iter().enumerate() {
            let score = 1.0 / (RRF_K + rank as f64 + 1.0);
            if let Some(existing) = scores
                .iter_mut()
                .find(|(_, s)| s.note_id == snippet.note_id)
            {
                existing.0 += score;
            } else {
                scores.push((score, snippet));
            }
        }
    }
    scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scores
        .into_iter()
        .take(limit)
        .map(|(_, snippet)| snippet)
        .collect()
}

// --- Commands ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskIndexStatus {
    pub settings: AskSettings,
    pub passages: i64,
    pub embedded: i64,
}

#[tauri::command]
pub async fn ask_index_status(app: AppHandle) -> Result<AskIndexStatus, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let (passages, embedded) = repos.passages_counts().await?;
    Ok(AskIndexStatus {
        settings: settings(),
        passages,
        embedded,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAskSettingsRequest {
    pub semantic: bool,
}

/// Turning it off forgets every passage and vector; turning it on starts
/// cutting and embedding again from the sweep.
#[tauri::command]
pub async fn set_ask_settings(
    app: AppHandle,
    request: SetAskSettingsRequest,
) -> Result<AskIndexStatus, AppError> {
    let next = AskSettings {
        semantic: request.semantic,
    };
    let state = app.state::<AskState>();
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    let repos = crate::commands::repositories(&app).await?;
    if next.semantic {
        catch_up_detached(&app);
    } else {
        repos.clear_passages().await?;
    }
    let (passages, embedded) = repos.passages_counts().await?;
    Ok(AskIndexStatus {
        settings: next,
        passages,
        embedded,
    })
}

#[cfg(test)]
mod tests {
    use super::{chunk_body, chunk_turns, fuse, source_hash};
    use crate::db::repositories::NoteContextSnippet;

    fn snippet(note_id: &str) -> NoteContextSnippet {
        NoteContextSnippet {
            note_id: note_id.into(),
            title: note_id.into(),
            kind: "note".into(),
            snippet: "…".into(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn a_body_is_cut_on_paragraphs_and_a_long_paragraph_on_sentences() {
        let short = "One.\n\nTwo.\n\nThree.";
        assert_eq!(chunk_body(short), vec!["One.\n\nTwo.\n\nThree."]);
        let long_paragraph = "A sentence. ".repeat(120);
        let passages = chunk_body(&long_paragraph);
        assert!(passages.len() > 1);
        assert!(passages.iter().all(|p| p.chars().count() <= 720));
        let rejoined: String = passages.join(" ");
        assert_eq!(rejoined.matches("A sentence.").count(), 120);
        assert!(chunk_body("   \n\n  ").is_empty());
    }

    #[test]
    fn turns_are_cut_in_windows_and_empty_turns_are_skipped() {
        let turns: Vec<(i64, String)> = (0..13)
            .map(|i| {
                (
                    i,
                    if i == 4 {
                        String::new()
                    } else {
                        format!("turn {i}")
                    },
                )
            })
            .collect();
        let passages = chunk_turns(&turns);
        assert_eq!(passages.len(), 3);
        assert_eq!(passages[0], "turn 0 turn 1 turn 2 turn 3 turn 5");
        assert_eq!(passages[2], "turn 12");
    }

    #[test]
    fn the_hash_changes_with_any_part_of_the_source() {
        let a = source_hash("t", "c", &[(0, "x".into())]);
        assert_eq!(a, source_hash("t", "c", &[(0, "x".into())]));
        assert_ne!(a, source_hash("t2", "c", &[(0, "x".into())]));
        assert_ne!(a, source_hash("t", "c2", &[(0, "x".into())]));
        assert_ne!(a, source_hash("t", "c", &[(1, "x".into())]));
    }

    #[test]
    fn fusion_prefers_a_note_both_lists_rank_and_keeps_one_entry_per_note() {
        let lexical = vec![snippet("a"), snippet("b"), snippet("c")];
        let semantic = vec![snippet("c"), snippet("d")];
        let fused = fuse(lexical, semantic, 3);
        let ids: Vec<&str> = fused.iter().map(|s| s.note_id.as_str()).collect();
        assert_eq!(ids[0], "c");
        assert_eq!(ids.len(), 3);
        assert_eq!(ids.iter().filter(|id| **id == "c").count(), 1);
    }
}
