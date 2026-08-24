//! The bible: the persistent identities of a production.
//!
//! A character, a location, a prop, a look. Until now the Studio could attach
//! reference images to a single render and nothing made them survive it, so
//! the same character was re-uploaded by hand every session and drifted a
//! little each time. These are the rows that persist, and everything else
//! about them is deliberately already-existing machinery: a reference is a
//! pointer at a gallery artifact (ADR-0020), and the surfaces that consume one
//! are the reference slots that were already there.
//!
//! This module is CRUD and validation only. How an entry becomes a prompt is
//! the webview's business (`src/lib/studio/bible/prompt.ts`), because that is
//! where the model constraints and the canonical mention machinery already
//! live.

use crate::domain::types::{AppError, BibleEntryDto};
use serde::Deserialize;
use tauri::AppHandle;

/// The kinds an entry can be. Closed on purpose: a fifth kind would be a
/// product decision, and a typo reaching the database would be a category that
/// no surface knows how to show.
pub const KINDS: [&str; 4] = ["character", "location", "prop", "look"];

/// The roles a reference can play.
///
/// The five image roles are the ordered stack a reference-to-video model wants:
/// the identity anchor first, then the angles, then the place it happens in.
/// `voice` is the odd one out - it points at an audio artifact and rides as a
/// voice donor rather than as a picture.
pub const ROLES: [&str; 6] = ["portrait", "profile", "wide", "medium", "detail", "voice"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBibleEntryRequest {
    /// Absent to create, present to update.
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    pub traits: Option<String>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBibleRefRequest {
    pub entry_id: String,
    /// A gallery artifact id, which is its file name.
    pub artifact_id: String,
    pub role: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderBibleRefsRequest {
    pub entry_id: String,
    /// Every reference of the entry, in the order they should be offered.
    pub ref_ids: Vec<String>,
}

fn validated(value: &str, allowed: &[&str], noun: &str) -> Result<String, AppError> {
    let trimmed = value.trim().to_ascii_lowercase();
    if allowed.contains(&trimmed.as_str()) {
        return Ok(trimmed);
    }
    Err(AppError::new(
        "bible_invalid",
        format!("\"{value}\" is not a {noun}. Pick {}.", allowed.join(", ")),
    ))
}

/// A name the surfaces can show and a model can be told about.
fn validated_name(raw: &str) -> Result<String, AppError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::new("bible_invalid", "Give this one a name."));
    }
    // Bounded because the name is restated on every prompt of every shot: a
    // runaway paste would silently eat the prompt budget of a whole film.
    Ok(name.chars().take(120).collect())
}

#[tauri::command]
pub async fn list_bible_entries(app: AppHandle) -> Result<Vec<BibleEntryDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.list_bible_entries().await?)
}

#[tauri::command]
pub async fn save_bible_entry(
    app: AppHandle,
    request: SaveBibleEntryRequest,
) -> Result<String, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let kind = validated(&request.kind, &KINDS, "kind")?;
    let name = validated_name(&request.name)?;
    // Traits are restated on every shot, so they are bounded for the same
    // reason the name is.
    let traits: String = request
        .traits
        .unwrap_or_default()
        .trim()
        .chars()
        .take(600)
        .collect();
    let note: String = request
        .note
        .unwrap_or_default()
        .trim()
        .chars()
        .take(2000)
        .collect();
    Ok(repos
        .upsert_bible_entry(request.id, &kind, &name, &traits, &note)
        .await?)
}

#[tauri::command]
pub async fn delete_bible_entry(app: AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.delete_bible_entry(&id).await?)
}

#[tauri::command]
pub async fn add_bible_ref(
    app: AppHandle,
    request: AddBibleRefRequest,
) -> Result<String, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let role = validated(&request.role, &ROLES, "role")?;
    let artifact_id = request.artifact_id.trim();
    if artifact_id.is_empty() {
        return Err(AppError::new(
            "bible_invalid",
            "That reference has no file.",
        ));
    }
    let label: String = request
        .label
        .unwrap_or_default()
        .trim()
        .chars()
        .take(120)
        .collect();
    Ok(repos
        .add_bible_ref(&request.entry_id, artifact_id, &role, &label)
        .await?)
}

#[tauri::command]
pub async fn remove_bible_ref(app: AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.remove_bible_ref(&id).await?)
}

#[tauri::command]
pub async fn reorder_bible_refs(
    app: AppHandle,
    request: ReorderBibleRefsRequest,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos
        .reorder_bible_refs(&request.entry_id, &request.ref_ids)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_or_a_role_the_surfaces_do_not_know_is_refused() {
        assert_eq!(validated("Character", &KINDS, "kind").unwrap(), "character");
        assert_eq!(validated(" WIDE ", &ROLES, "role").unwrap(), "wide");
        // A typo reaching the table would be a category nothing can display,
        // and it would only be noticed by its absence.
        let error = validated("charcter", &KINDS, "kind").unwrap_err();
        assert!(error.message.contains("character"));
        assert!(validated("", &ROLES, "role").is_err());
    }

    #[test]
    fn a_name_is_required_and_bounded() {
        assert_eq!(validated_name("  Nera  ").unwrap(), "Nera");
        assert!(validated_name("   ").is_err());
        // The name is restated on every prompt of every shot, so a runaway
        // paste must not silently eat a film's prompt budget.
        assert_eq!(
            validated_name(&"x".repeat(500)).unwrap().chars().count(),
            120
        );
    }
}
