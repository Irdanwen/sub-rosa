//! Turning a note into the shots a film is made of.
//!
//! A script is a note - the import doctrine (ADR-0026) applied to writing
//! rather than to a file. A shot list is a *reading* of that note, kept on its
//! own durable row so it can be regenerated in place without touching a word
//! the user wrote, and resumed part by part when a long script outlives a
//! foreground session (ADR-0018). Same shape as the long-form summary
//! (ADR-0027), for the same reasons.
//!
//! **The app owns the clock and the routing.** The model returns a motion
//! class, who is in the shot, and whether it carries on from the last one. It
//! is never asked for a duration, a model id or an aspect ratio - those come
//! from a catalogue it has never seen, and a guess there costs money. The
//! compile step in the webview resolves them (`src/lib/studio/workflow/
//! compile.ts`), which is also where the cost envelope lives.
//!
//! Nothing here touches `june-api/`: the passes go to `/v1/chat/completions`
//! through the sidecar, the seam `longform`, `agent_lite` and memory already
//! use.

pub mod chunk;
pub mod prompts;

use crate::db::repositories::Repositories;
use crate::domain::types::{AppError, ShotListDto};
use crate::june_api;
use prompts::SHOTLIST_PROMPT_VERSION;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

/// Emitted whenever a shot list row changes, so both shells follow a run
/// without polling. Polling is what ADR-0018 exists to prevent.
pub const SHOT_LIST_EVENT: &str = "june://shot-list";

/// One shot, as the model returns it and as the compiler reads it.
///
/// Note what is absent: no model, no duration, no aspect ratio, no timestamp.
/// Those belong to the app.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    #[serde(default)]
    pub scene: String,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub camera: String,
    #[serde(default)]
    pub characters: Vec<String>,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub dialogue: String,
    #[serde(default)]
    pub speaker: String,
    /// low | medium | high. Anything else is read as medium.
    #[serde(default)]
    pub motion: String,
    /// Whether this shot carries straight on from the one before it.
    #[serde(default)]
    pub continues: bool,
}

/// Somebody or somewhere the script names, described.
///
/// The description is the point. A bible entry with a face and no traits is
/// half an entry: the traits are what every shot restates, and restating them
/// is the whole difference between a character and a resemblance. Asking for
/// them here means a one-click cast produces a whole entry rather than a
/// hollow one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CastMember {
    #[serde(default)]
    pub name: String,
    /// character | location | prop. Anything else is read as a character.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub traits: String,
}

/// What one reading returns: who is in the film, and the shots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    #[serde(default)]
    pub cast: Vec<CastMember>,
    #[serde(default)]
    pub shots: Vec<Shot>,
}

/// The kinds a cast member can be. A model inventing a fourth gets the one
/// that costs least to be wrong about.
pub const CAST_KINDS: [&str; 3] = ["character", "location", "prop"];

fn normalized_kind(raw: &str) -> String {
    let value = raw.trim().to_ascii_lowercase();
    if CAST_KINDS.contains(&value.as_str()) {
        value
    } else {
        "character".to_string()
    }
}

/// The motion classes the compiler routes on. A model that invents a fourth
/// gets the middle one rather than an error: a wrong-but-sane render beats a
/// refused script.
pub const MOTION_CLASSES: [&str; 3] = ["low", "medium", "high"];

fn normalized_motion(raw: &str) -> String {
    let value = raw.trim().to_ascii_lowercase();
    if MOTION_CLASSES.contains(&value.as_str()) {
        value
    } else {
        "medium".to_string()
    }
}

/// Notes with a run live in this process right now.
///
/// A row parked in `running` means either a run is working on it or the
/// process died mid-run, and the row alone cannot tell them apart. Same
/// problem, same answer, as `longform::ACTIVE`.
static ACTIVE: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn active() -> MutexGuard<'static, HashSet<String>> {
    ACTIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

struct RunClaim(String);

impl RunClaim {
    fn take(note_id: &str) -> Option<Self> {
        let mut active = active();
        if !active.insert(note_id.to_string()) {
            return None;
        }
        Some(Self(note_id.to_string()))
    }
}

impl Drop for RunClaim {
    fn drop(&mut self) {
        active().remove(&self.0);
    }
}

pub fn is_running(note_id: &str) -> bool {
    active().contains(note_id)
}

fn emit(app: &AppHandle, row: &ShotListDto) {
    let _ = app.emit(SHOT_LIST_EVENT, row);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotListPlan {
    pub note_id: String,
    pub script_chars: i64,
    pub chunk_count: i64,
    pub model_calls: i64,
    pub breakable: bool,
    /// Why not, when `breakable` is false.
    pub reason: Option<String>,
}

/// The note's own words: what the user wrote wins over what was generated.
async fn script_of(repos: &Repositories, note_id: &str) -> Result<String, AppError> {
    let note = repos.get_note(note_id).await?;
    Ok(note
        .edited_content
        .filter(|text| !text.trim().is_empty())
        .or(note.generated_content)
        .unwrap_or_default())
}

pub async fn plan(repos: &Repositories, note_id: &str) -> Result<ShotListPlan, AppError> {
    let script = script_of(repos, note_id).await?;
    let script_chars = script.chars().count();
    let chunks = chunk::chunk_script(&script, chunk::CHUNK_BUDGET_CHARS);
    let chunk_count = chunks.len();
    let (breakable, reason) = if script_chars < chunk::MIN_SCRIPT_CHARS {
        (
            false,
            Some("There is not enough here to break into shots yet.".to_string()),
        )
    } else if chunk_count > chunk::MAX_CHUNKS {
        (
            false,
            Some(format!(
                "This script would take {chunk_count} passes to read, past the {} this app will run at once.",
                chunk::MAX_CHUNKS
            )),
        )
    } else {
        (true, None)
    };
    Ok(ShotListPlan {
        note_id: note_id.to_string(),
        script_chars: script_chars as i64,
        chunk_count: chunk_count as i64,
        // One pass per part. No merge pass: the parts are already an ordered
        // list of shots, and concatenating them is arithmetic, not judgement.
        model_calls: chunk_count as i64,
        breakable,
        reason,
    })
}

/// Start (or restart) the breakdown of a note.
pub async fn start(app: &AppHandle, note_id: &str) -> Result<ShotListDto, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let plan = plan(&repos, note_id).await?;
    if !plan.breakable {
        return Err(AppError::new(
            "shotlist_not_breakable",
            plan.reason
                .unwrap_or_else(|| "This note cannot be broken into shots.".to_string()),
        ));
    }
    if is_running(note_id) {
        return repos.shot_list(note_id).await?.ok_or_else(|| {
            AppError::new(
                "shotlist_stopping",
                "That breakdown is still stopping. Try again in a moment.",
            )
        });
    }
    let row = repos
        .begin_shot_list(
            note_id,
            plan.script_chars,
            plan.chunk_count,
            &crate::providers::generation_model(),
            SHOTLIST_PROMPT_VERSION,
        )
        .await?;
    emit(app, &row);
    spawn_run(app.clone(), note_id.to_string());
    Ok(row)
}

fn spawn_run(app: AppHandle, note_id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(claim) = RunClaim::take(&note_id) else {
            return;
        };
        let background = crate::ios_background::BackgroundTask::begin("shot-list");
        let result = run(&app, &note_id).await;
        drop(background);
        drop(claim);
        if let Err(error) = result {
            tracing::warn!(note_id = %note_id, code = %error.code, "shot list failed");
            if let Ok(repos) = crate::commands::repositories(&app).await {
                if let Ok(Some(row)) = repos.set_shot_list_failed(&note_id, &error.message).await {
                    emit(&app, &row);
                }
            }
        }
    });
}

async fn run(app: &AppHandle, note_id: &str) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    // The run's identity. Deleting the row is the cancel, and a new row may
    // exist by the time this notices - the user stopping and starting again.
    // Comparing `created_at` means the old run stands down instead of adopting
    // the new row and doubling the bill.
    let started_at = repos
        .shot_list(note_id)
        .await?
        .map(|row| row.created_at)
        .ok_or_else(|| AppError::new("shotlist_cancelled", "That breakdown was stopped."))?;
    let still_ours =
        |row: Option<&ShotListDto>| row.is_some_and(|row| row.created_at == started_at);

    let script = script_of(&repos, note_id).await?;
    let chunks = chunk::chunk_script(&script, chunk::CHUNK_BUDGET_CHARS);
    let chunk_count = chunks.len();

    // Parts already paid for. Only reused when the script still chunks the
    // same way: an edited script would line the indices up against the wrong
    // text.
    let existing = repos.shot_list(note_id).await?;
    let mut parts: Vec<String> = existing
        .as_ref()
        .filter(|row| row.chunk_count as usize == chunk_count)
        .and_then(|row| row.parts_json.as_deref())
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .unwrap_or_default();
    parts.truncate(chunk_count);

    for (index, chunk) in chunks.iter().enumerate() {
        if index < parts.len() {
            continue;
        }
        let text = completion(
            prompts::MAP_SYSTEM,
            &prompts::map_user_message(index, chunk_count, chunk),
            "shotlist_map_failed",
        )
        .await?;
        parts.push(text);
        let saved = repos.save_shot_list_parts(note_id, &parts).await?;
        if !still_ours(saved.as_ref()) {
            return Ok(());
        }
        if let Some(row) = saved {
            emit(app, &row);
        }
    }

    let mut shots: Vec<Shot> = Vec::new();
    let mut cast: Vec<CastMember> = Vec::new();
    for part in &parts {
        let reading = parse_reading(part);
        shots.extend(reading.shots);
        // A later part naming somebody an earlier one already described does
        // not get to redescribe them: the first description is the one every
        // shot before it was written against.
        for member in reading.cast {
            let key = member.name.to_lowercase();
            if !cast.iter().any(|seen| seen.name.to_lowercase() == key) {
                cast.push(member);
            }
        }
    }
    if shots.is_empty() {
        return Err(AppError::new(
            "shotlist_empty",
            "Nothing in this note reads as something to film.",
        ));
    }
    let row = repos
        .finish_shot_list(note_id, &Reading { cast, shots })
        .await?;
    if !still_ours(row.as_ref()) {
        return Ok(());
    }
    if let Some(row) = row {
        emit(app, &row);
    }
    Ok(())
}

/// Read shots out of whatever the model wrapped its JSON in.
///
/// Models wrap arrays in prose, in fences, in an apology. Anything unreadable
/// yields no shots for that part rather than failing the whole breakdown: four
/// parts that landed are worth more than a run that refused because the fifth
/// was chatty.
pub fn parse_shots(raw: &str) -> Vec<Shot> {
    parse_reading(raw).shots
}

/// Read a whole reading out of whatever the model wrapped its JSON in.
///
/// Two shapes are accepted, and both are the normal case rather than an
/// exception: the object this asks for, and a bare array of shots - which is
/// what a model returns when it ignores half the instruction, and what every
/// reading stored before the cast existed looks like. A reading with no cast
/// is a reading, not a failure.
pub fn parse_reading(raw: &str) -> Reading {
    let object = slice_between(raw, '{', '}')
        .and_then(|slice| serde_json::from_str::<Reading>(slice).ok())
        .filter(|reading| !reading.shots.is_empty());
    let mut reading = match object {
        Some(reading) => reading,
        None => Reading {
            cast: Vec::new(),
            shots: slice_between(raw, '[', ']')
                .and_then(|slice| serde_json::from_str::<Vec<Shot>>(slice).ok())
                .unwrap_or_default(),
        },
    };

    reading.shots.retain(|shot| !shot.action.trim().is_empty());
    for shot in &mut reading.shots {
        shot.motion = normalized_motion(&shot.motion);
        shot.characters.retain(|name| !name.trim().is_empty());
    }
    reading.cast.retain(|member| !member.name.trim().is_empty());
    for member in &mut reading.cast {
        member.kind = normalized_kind(&member.kind);
        member.name = member.name.trim().to_string();
        // Bounded for the same reason the bible bounds its own: traits are
        // restated on every shot of every film.
        member.traits = member.traits.trim().chars().take(300).collect();
    }
    reading
}

/// The outermost balanced-looking slice between two delimiters, or nothing.
fn slice_between(raw: &str, open: char, close: char) -> Option<&str> {
    let start = raw.find(open)?;
    let end = raw.rfind(close)?;
    if end <= start {
        return None;
    }
    Some(&raw[start..=end])
}

async fn completion(system: &str, user: &str, error_code: &str) -> Result<String, AppError> {
    let response = june_api::proxy_agent_chat_completions(serde_json::json!({
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        // Near zero: this is extraction, not writing. Invention here is a
        // scene that is not in the script and a render that is paid for.
        "temperature": 0.1,
        "max_tokens": 8000
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            error_code,
            format!("The model returned status {}.", response.status),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new(error_code, error.to_string()))?;
    june_api::extract_chat_completion_text(&value)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AppError::new(error_code, "The model returned no text."))
}

/// Re-drive any breakdown left unfinished by a crash or a suspension.
pub async fn resume_unfinished(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(rows) = repos.unfinished_shot_lists().await else {
        return;
    };
    for row in rows {
        if !is_running(&row.note_id) {
            spawn_run(app.clone(), row.note_id);
        }
    }
}

// --- Commands ---------------------------------------------------------------

#[tauri::command]
pub async fn shot_list(app: AppHandle, note_id: String) -> Result<Option<ShotListDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.shot_list(&note_id).await?)
}

#[tauri::command]
pub async fn shot_list_plan(app: AppHandle, note_id: String) -> Result<ShotListPlan, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    plan(&repos, &note_id).await
}

#[tauri::command]
pub async fn build_shot_list(app: AppHandle, note_id: String) -> Result<ShotListDto, AppError> {
    start(&app, &note_id).await
}

#[tauri::command]
pub async fn forget_shot_list(app: AppHandle, note_id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.delete_shot_list(&note_id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_carries_who_is_in_it_and_how_they_look() {
        // A bible entry with a face and no traits is half an entry: the traits
        // are what every shot restates, and restating them is the whole
        // difference between a character and a resemblance.
        let raw = r#"Here you go:
```json
{"cast": [{"name": " Nera ", "kind": "CHARACTER", "traits": "green wool coat, scar over the left brow"},
          {"name": "The alley", "kind": "location", "traits": "wet asphalt, sodium light"},
          {"name": "  ", "kind": "character", "traits": "nobody"}],
 "shots": [{"scene": "Alley", "action": "Nera turns", "motion": "low"}]}
```"#;
        let reading = parse_reading(raw);
        assert_eq!(reading.shots.len(), 1);
        assert_eq!(reading.cast.len(), 2);
        assert_eq!(reading.cast[0].name, "Nera");
        assert_eq!(reading.cast[0].kind, "character");
        assert_eq!(
            reading.cast[0].traits,
            "green wool coat, scar over the left brow"
        );
    }

    #[test]
    fn a_bare_array_of_shots_is_still_a_reading() {
        // What a model returns when it ignores half the instruction, and what
        // every reading stored before the cast existed looks like.
        let reading = parse_reading("[{\"action\":\"Nera turns\",\"motion\":\"low\"}]");
        assert_eq!(reading.shots.len(), 1);
        assert!(reading.cast.is_empty());
    }

    #[test]
    fn an_invented_kind_becomes_the_one_that_costs_least_to_be_wrong_about() {
        let reading = parse_reading(
            "{\"cast\":[{\"name\":\"X\",\"kind\":\"vehicle\"}],\"shots\":[{\"action\":\"a\"}]}",
        );
        assert_eq!(reading.cast[0].kind, "character");
    }

    #[test]
    fn traits_are_bounded_like_the_bible_bounds_its_own() {
        let long = "x".repeat(900);
        let raw = format!(
            "{{\"cast\":[{{\"name\":\"X\",\"kind\":\"character\",\"traits\":\"{long}\"}}],\"shots\":[{{\"action\":\"a\"}}]}}"
        );
        assert_eq!(parse_reading(&raw).cast[0].traits.chars().count(), 300);
    }

    #[test]
    fn shots_are_read_out_of_whatever_the_model_wrapped_them_in() {
        let wrapped = "Sure! Here you go:\n```json\n[{\"scene\":\"Alley\",\"action\":\"Nera turns\",\"motion\":\"LOW\",\"characters\":[\"Nera\",\"  \"]}]\n```\nHope that helps.";
        let shots = parse_shots(wrapped);
        assert_eq!(shots.len(), 1);
        assert_eq!(shots[0].scene, "Alley");
        assert_eq!(shots[0].motion, "low");
        // A blank name is not a character: it would become an empty reference.
        assert_eq!(shots[0].characters, vec!["Nera".to_string()]);
    }

    #[test]
    fn a_motion_class_nobody_defined_becomes_the_middle_one() {
        // A wrong-but-sane render beats a refused script, and the compiler
        // routes on this value.
        let shots = parse_shots("[{\"action\":\"a\",\"motion\":\"balletic\"}]");
        assert_eq!(shots[0].motion, "medium");
        let missing = parse_shots("[{\"action\":\"a\"}]");
        assert_eq!(missing[0].motion, "medium");
    }

    #[test]
    fn a_shot_with_nothing_happening_in_it_is_dropped() {
        assert!(parse_shots("[{\"scene\":\"Alley\",\"action\":\"   \"}]").is_empty());
    }

    #[test]
    fn an_unreadable_part_yields_no_shots_rather_than_failing_the_run() {
        // Four parts that landed are worth more than a run that refused
        // because the fifth was chatty.
        assert!(parse_shots("I would rather not.").is_empty());
        assert!(parse_shots("[not json]").is_empty());
        assert!(parse_shots("").is_empty());
        assert!(parse_shots("][").is_empty());
    }
}
