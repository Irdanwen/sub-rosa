//! Study mode (ADR-0089): a chat that teaches rather than answers, quizzes and
//! flashcards in its replies, and the cards a person keeps, brought back by
//! spaced repetition.
//!
//! - **A chat is in study mode when it has a row** in `study_chats`
//!   (migration 058). The composer's toggle writes it on both shells, so a
//!   regenerated reply, an edited question and a turn the background sweep
//!   finishes all read the mode the person chose, not whatever the screen
//!   holds when they happen.
//! - **One prompt for both shells.** The phone puts [`STUDY_PROMPT`] at the
//!   end of its system prompt every turn ([`prompted`]); the desktop cannot
//!   change Hermes' SOUL per chat, so it sends the same text after the
//!   attached-context marker of every message while the mode is on, the seam
//!   a project uses (ADR-0085).
//! - **Quizzes and flashcards are chat blocks** (`subrosa:quiz`,
//!   `subrosa:flashcards`, ADR-0024): the reply carries them, the shared
//!   parser renders them, and nothing is stored until the person taps "Add to
//!   review". A card is then a row of its own, scheduled by [`schedule`].

pub mod schedule;
#[cfg(test)]
mod tests;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;
use schedule::{CardState, Grade};

pub const STUDY_PROMPT_VERSION: u32 = 1;

/// The tutoring behaviour, and the two blocks it may answer with.
pub const STUDY_PROMPT: &str = "Study mode is on. The person wants to learn, not to be handed answers. Act as a patient tutor:

- Start by finding out what they already know and what they are working towards, in one short question, unless the conversation already says so.
- Teach in small steps. Explain one idea, then check understanding with a question before moving on. Prefer guiding questions and hints to finished answers (the Socratic way), and let them do the reasoning.
- Never just give the answer to an exercise, a homework problem or a quiz question. Give a hint, then a bigger one, and only show a full worked solution when they ask for it explicitly or have tried twice. Then walk through it step by step.
- Adapt the level: simpler words and concrete examples when they struggle, more depth and harder questions when they answer well. Correct mistakes kindly and say precisely what was wrong.
- Keep replies short and focused, and end most of them with one question for the person.

Quizzes: to check understanding, you may add one fenced code block whose info string is subrosa:quiz and whose body is one JSON object {\"v\":1,\"title\":\"…\",\"questions\":[{\"kind\":\"choice\",\"prompt\":\"…\",\"options\":[\"…\",\"…\",\"…\"],\"answer\":<0-based index of the right option>,\"explanation\":\"…\"},{\"kind\":\"short\",\"prompt\":\"…\",\"answer\":\"…\",\"accept\":[\"other accepted answers\"],\"explanation\":\"…\"}]}. The app asks the questions one by one, gives the feedback and the explanation, and keeps the score, so do not repeat the answers in your prose. Ten questions at most, two to six options each.

Flashcards: to help them memorise, you may add one fenced code block whose info string is subrosa:flashcards and whose body is {\"v\":1,\"title\":\"…\",\"cards\":[{\"front\":\"…\",\"back\":\"…\"}]}. The app shows cards that flip and lets the person add them to their review, which brings them back by spaced repetition. Thirty cards at most, one fact per card, a short front and a short back.

Write in the person's language.";

/// Every time this module writes has one width and one zone, so the due
/// comparisons in SQL are text comparisons that cannot be wrong.
pub fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Cards a flashcards block may add at once, and how long a side may be.
const MAX_CARDS_PER_ADD: usize = 50;
const MAX_SIDE_CHARS: usize = 2_000;
const MAX_DECK_CHARS: usize = 160;

/// The system prompt a phone turn runs with: the study section appended when
/// the chat is in study mode, the prompt untouched otherwise (and when the
/// table cannot be read, since a chat must not fail for its mode).
pub async fn prompted(pool: &SqlitePool, chat_id: &str, prompt: String) -> String {
    match is_on(pool, chat_id).await {
        Ok(true) => format!("{prompt}\n\n{STUDY_PROMPT}"),
        _ => prompt,
    }
}

pub async fn is_on(pool: &SqlitePool, chat_id: &str) -> Result<bool, AppError> {
    Ok(query("SELECT 1 FROM study_chats WHERE chat_id = ?1")
        .bind(chat_id.trim())
        .fetch_optional(pool)
        .await?
        .is_some())
}

pub async fn set_mode(pool: &SqlitePool, chat_id: &str, on: bool) -> Result<bool, AppError> {
    let chat_id = chat_id.trim();
    if chat_id.is_empty() {
        return Err(AppError::new("study_chat_missing", "Open a chat first."));
    }
    if on {
        query(
            "INSERT INTO study_chats (chat_id, updated_at) VALUES (?1, ?2)
             ON CONFLICT(chat_id) DO UPDATE SET updated_at = excluded.updated_at",
        )
        .bind(chat_id)
        .bind(stamp(Utc::now()))
        .execute(pool)
        .await?;
    } else {
        query("DELETE FROM study_chats WHERE chat_id = ?1")
            .bind(chat_id)
            .execute(pool)
            .await?;
    }
    Ok(on)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudyCardDto {
    pub id: String,
    pub front: String,
    pub back: String,
    pub deck: Option<String>,
    pub ease: f64,
    pub interval_days: i64,
    pub repetitions: i64,
    pub lapses: i64,
    pub due_at: String,
    pub last_reviewed_at: Option<String>,
    pub created_at: String,
}

fn row_to_card(row: &sqlx_sqlite::SqliteRow) -> StudyCardDto {
    StudyCardDto {
        id: row.get("id"),
        front: row.get("front"),
        back: row.get("back"),
        deck: row.get("deck"),
        ease: row.get("ease"),
        interval_days: row.get("interval_days"),
        repetitions: row.get("repetitions"),
        lapses: row.get("lapses"),
        due_at: row.get("due_at"),
        last_reviewed_at: row.get("last_reviewed_at"),
        created_at: row.get("created_at"),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewCard {
    pub front: String,
    pub back: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCardsRequest {
    pub cards: Vec<NewCard>,
    #[serde(default)]
    pub deck: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddCardsResult {
    /// Cards that were new. A card already in review is not added twice.
    pub added: usize,
    pub already: usize,
}

fn side(text: &str) -> String {
    text.trim().chars().take(MAX_SIDE_CHARS).collect()
}

/// The key a card is known by: the same front and back, however spaced or
/// cased, is the same card.
pub fn card_key(front: &str, back: &str) -> String {
    let normal = |text: &str| {
        text.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    let digest = Sha256::digest(format!("{}\u{1f}{}", normal(front), normal(back)).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Adds the cards to review, due now, so the first review is the next one.
pub async fn add_cards(
    pool: &SqlitePool,
    request: &AddCardsRequest,
    now: DateTime<Utc>,
) -> Result<AddCardsResult, AppError> {
    let cards: Vec<(String, String)> = request
        .cards
        .iter()
        .map(|card| (side(&card.front), side(&card.back)))
        .filter(|(front, back)| !front.is_empty() && !back.is_empty())
        .collect();
    if cards.is_empty() || cards.len() > MAX_CARDS_PER_ADD {
        return Err(AppError::new(
            "study_cards_invalid",
            "These cards cannot be added to your review.",
        ));
    }
    let deck = request
        .deck
        .as_deref()
        .map(|deck| deck.trim().chars().take(MAX_DECK_CHARS).collect::<String>())
        .filter(|deck| !deck.is_empty());
    let chat_id = request
        .chat_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let stamp = stamp(now);
    let mut added = 0;
    for (front, back) in &cards {
        let result = query(
            "INSERT INTO study_cards (id, front, back, deck, source_key, chat_id, due_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(source_key) DO NOTHING",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(front)
        .bind(back)
        .bind(deck.as_deref())
        .bind(card_key(front, back))
        .bind(chat_id)
        .bind(&stamp)
        .execute(pool)
        .await?;
        added += result.rows_affected() as usize;
    }
    Ok(AddCardsResult {
        added,
        already: cards.len() - added,
    })
}

/// The cards due at `now`, the most overdue first.
pub async fn due_cards(
    pool: &SqlitePool,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<StudyCardDto>, AppError> {
    let rows =
        query("SELECT * FROM study_cards WHERE due_at <= ?1 ORDER BY due_at, created_at LIMIT ?2")
            .bind(stamp(now))
            .bind(limit.clamp(1, 500))
            .fetch_all(pool)
            .await?;
    Ok(rows.iter().map(row_to_card).collect())
}

/// Records an answer and schedules the card's next review.
pub async fn review_card(
    pool: &SqlitePool,
    id: &str,
    grade: Grade,
    now: DateTime<Utc>,
) -> Result<StudyCardDto, AppError> {
    let row = query("SELECT * FROM study_cards WHERE id = ?1")
        .bind(id.trim())
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "study_card_missing",
                "This card is no longer in your review.",
            )
        })?;
    let card = row_to_card(&row);
    let (next, due) = schedule::review(
        CardState {
            ease: card.ease,
            interval_days: card.interval_days,
            repetitions: card.repetitions,
            lapses: card.lapses,
        },
        grade,
        now,
    );
    query(
        "UPDATE study_cards SET ease = ?1, interval_days = ?2, repetitions = ?3, lapses = ?4,
         due_at = ?5, last_reviewed_at = ?6 WHERE id = ?7",
    )
    .bind(next.ease)
    .bind(next.interval_days)
    .bind(next.repetitions)
    .bind(next.lapses)
    .bind(stamp(due))
    .bind(stamp(now))
    .bind(&card.id)
    .execute(pool)
    .await?;
    let row = query("SELECT * FROM study_cards WHERE id = ?1")
        .bind(&card.id)
        .fetch_one(pool)
        .await?;
    Ok(row_to_card(&row))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StudyStats {
    pub total: i64,
    pub due: i64,
    /// When the next card not yet due comes back, for "Nothing due until…".
    pub next_due_at: Option<String>,
}

pub async fn stats(pool: &SqlitePool, now: DateTime<Utc>) -> Result<StudyStats, AppError> {
    let stamp = stamp(now);
    let row = query(
        "SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN due_at <= ?1 THEN 1 ELSE 0 END), 0) AS due,
                MIN(CASE WHEN due_at > ?1 THEN due_at END) AS next_due_at
         FROM study_cards",
    )
    .bind(&stamp)
    .fetch_one(pool)
    .await?;
    Ok(StudyStats {
        total: row.get("total"),
        due: row.get("due"),
        next_due_at: row.get("next_due_at"),
    })
}

// --- Commands --------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyModeRequest {
    pub chat_id: String,
    /// Absent to read the mode, present to set it.
    #[serde(default)]
    pub on: Option<bool>,
}

/// Reads or sets a chat's study mode; answers the mode it is in afterwards.
#[tauri::command]
pub async fn study_mode(app: AppHandle, request: StudyModeRequest) -> Result<bool, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    match request.on {
        Some(on) => set_mode(&repos.pool, &request.chat_id, on).await,
        None => is_on(&repos.pool, &request.chat_id).await,
    }
}

/// The tutoring text, for the desktop's per-message context.
#[tauri::command]
pub async fn study_prompt() -> Result<String, AppError> {
    Ok(STUDY_PROMPT.to_string())
}

#[tauri::command]
pub async fn study_cards_add(
    app: AppHandle,
    request: AddCardsRequest,
) -> Result<AddCardsResult, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    add_cards(&repos.pool, &request, Utc::now()).await
}

#[tauri::command]
pub async fn study_cards_due(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<StudyCardDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    due_cards(&repos.pool, Utc::now(), limit.unwrap_or(100)).await
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewRequest {
    pub id: String,
    pub grade: Grade,
}

#[tauri::command]
pub async fn study_card_review(
    app: AppHandle,
    request: ReviewRequest,
) -> Result<StudyCardDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    review_card(&repos.pool, &request.id, request.grade, Utc::now()).await
}

#[tauri::command]
pub async fn study_cards_stats(app: AppHandle) -> Result<StudyStats, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    stats(&repos.pool, Utc::now()).await
}

/// Takes a card out of review. A no-op for one that is not there.
#[tauri::command]
pub async fn study_card_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    query("DELETE FROM study_cards WHERE id = ?1")
        .bind(id.trim())
        .execute(&repos.pool)
        .await?;
    Ok(())
}
