//! Writing a note on the assistant's behalf, on either shell.
//!
//! The phone's agent could put something in the user's notes from the day it
//! shipped (`agent_lite`'s `create_note` / `append_to_note`); the desktop's
//! could not. Its only local toolset, the `june_context` MCP, reads. Asked to
//! "write this up as a note", the desktop agent had a sandboxed filesystem and
//! nothing else, so it wrote a markdown file into its workspace and told the
//! user where to find it. The note it was asked for never existed.
//!
//! This module is the one place either shell writes a note from a model, so
//! the two cannot drift into different behavior for the same sentence:
//!
//! - **The Rust process owns the write.** The MCP reads the same SQLite file
//!   read-only and reaches this through the local proxy, exactly as
//!   `search_calendar` reaches EventKit. Nothing writes to the database from
//!   Python.
//! - **Append means append to what the user sees.** `edited_content` when they
//!   have edits, the generated note otherwise
//!   ([`Repositories::append_to_note_content`]), which is also what tapping a
//!   follow-up card does (`crate::actions`).
//! - **A written note is an ordinary note.** No new noun, no "agent note": it
//!   lands in the same list, is searchable, and is a plain note rather than a
//!   *meeting note*, which is what a transcribed recording produces.

use crate::domain::types::{AppError, NoteDto};
use tauri::{AppHandle, Emitter};

/// Emitted after either shell's assistant writes a note, so an open list
/// reloads instead of showing a note count from before the turn.
pub const NOTES_CHANGED_EVENT: &str = "june://notes-changed";

/// Fallback title. Sentence case, like every other label the app writes.
const UNTITLED: &str = "Untitled note";

/// Title bound, matching `crate::actions`' label bound: a title is one line.
const MAX_TITLE_CHARS: usize = 200;

/// Body bound. Far above any note a person would keep (a long audit report is
/// a few tens of thousands of characters) and still a bound, because the text
/// arrives from a model.
const MAX_BODY_CHARS: usize = 200_000;

/// Creates a note holding `content`. Returns the saved note so the caller can
/// tell the model the id it needs to append to it later.
pub async fn create(
    app: &AppHandle,
    title: Option<&str>,
    content: &str,
) -> Result<NoteDto, AppError> {
    let body = clean_body(content)?;
    let title = title
        .and_then(clean_title)
        .unwrap_or_else(|| UNTITLED.to_string());
    let repos = crate::commands::repositories(app).await?;
    let note = repos
        .create_note(None)
        .await
        .map_err(|error| AppError::new("agent_note_create_failed", error.to_string()))?;
    let saved = repos
        .update_note(&note.id, Some(title), Some(body), None)
        .await
        .map_err(|error| AppError::new("agent_note_create_failed", error.to_string()))?;
    announce(app, std::slice::from_ref(&note.id));
    Ok(saved)
}

/// Appends `content` to an existing note, below what is already there.
pub async fn append(app: &AppHandle, note_id: &str, content: &str) -> Result<NoteDto, AppError> {
    let body = clean_body(content)?;
    let note_id = note_id.trim();
    if note_id.is_empty() {
        return Err(AppError::new(
            "agent_note_invalid",
            "That note id is empty.",
        ));
    }
    let repos = crate::commands::repositories(app).await?;
    repos
        .append_to_note_content(note_id, &body)
        .await
        .map_err(|error| AppError::new("agent_note_append_failed", error.to_string()))?;
    let saved = repos
        .get_note(note_id)
        .await
        .map_err(|error| AppError::new("agent_note_append_failed", error.to_string()))?;
    announce(app, std::slice::from_ref(&saved.id));
    Ok(saved)
}

/// What `NOTES_CHANGED_EVENT` carries: which notes moved, so the shell can
/// reload the one it has open instead of only the list.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesChanged {
    pub note_ids: Vec<String>,
}

/// Tells the open shell which notes moved, and refreshes the search index so
/// a note written outside the editor (by the assistant, by an import, by a
/// background sweep) is findable like one the user wrote. Both are
/// best-effort: a note that is saved is saved, whether or not anyone was
/// listening. Every path that creates or rewrites a note off the editor's
/// own save goes through here; the list used to refresh on the agent's
/// writes only, and an open note never did.
pub fn announce(app: &AppHandle, note_ids: &[String]) {
    let _ = app.emit(
        NOTES_CHANGED_EVENT,
        NotesChanged {
            note_ids: note_ids.to_vec(),
        },
    );
    crate::spotlight::reindex_detached(app);
}

/// A body worth writing: trimmed, non-empty, bounded.
fn clean_body(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "agent_note_invalid",
            "There is nothing to write.",
        ));
    }
    Ok(truncate_chars(trimmed, MAX_BODY_CHARS))
}

/// A single-line title, or `None` when there is nothing usable in it.
fn clean_title(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate_chars(&collapsed, MAX_TITLE_CHARS))
}

/// Truncates on a character boundary, never a byte one: a cut inside a
/// multi-byte character would panic on a note written in any language with
/// accents, which is most of them.
fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((byte, _)) => value[..byte].to_string(),
        None => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_event_names_its_notes_in_camel_case() {
        let json = serde_json::to_string(&super::NotesChanged {
            note_ids: vec!["n1".into(), "n2".into()],
        })
        .expect("serialize");
        assert_eq!(json, r#"{"noteIds":["n1","n2"]}"#);
    }

    use super::{clean_body, clean_title, truncate_chars, MAX_BODY_CHARS, MAX_TITLE_CHARS};

    #[test]
    fn a_blank_body_is_refused_rather_than_saved_as_an_empty_note() {
        assert!(clean_body("   \n  ").is_err());
        assert_eq!(clean_body("  Audit passed.  ").unwrap(), "Audit passed.");
    }

    #[test]
    fn a_title_is_one_line() {
        assert_eq!(
            clean_title("  Audit\n  DiemPoolImmutable  ").unwrap(),
            "Audit DiemPoolImmutable"
        );
        assert!(clean_title("   ").is_none());
    }

    #[test]
    fn bounds_cut_on_characters_so_accents_cannot_panic() {
        // A byte-indexed cut inside "é" would panic; this is what a note in
        // French, Japanese or anything else non-ASCII actually looks like.
        let accented = "é".repeat(MAX_TITLE_CHARS + 50);
        assert_eq!(
            clean_title(&accented).unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
        let long = "à".repeat(MAX_BODY_CHARS + 10);
        assert_eq!(clean_body(&long).unwrap().chars().count(), MAX_BODY_CHARS);
        assert_eq!(truncate_chars("short", 999), "short");
    }
}
