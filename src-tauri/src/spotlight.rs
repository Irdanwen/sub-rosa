//! Notes, findable from the system's own search.
//!
//! CoreSpotlight is reachable from `objc2` exactly like the other native
//! bridges here, so this needs no Swift and no extension target — which is
//! why it is the cheap end of "be reachable from the OS" and gets done
//! first. Each indexed item carries a `subrosa://note/<id>` content URL, so
//! opening a result goes through the same destination router as a
//! notification tap (`crate::destinations`).
//!
//! **The privacy question, asked rather than assumed.** This app's promise is
//! that notes stay on the device. A Spotlight index is on the device too, but
//! it is a *system* index: other search surfaces read it, and it outlives the
//! app's own storage. So titles and dates are indexed by default (that is
//! what makes a note findable at all) and the body is indexed only if the
//! user says so. Turning indexing off removes everything already indexed.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const SETTINGS_FILE: &str = "spotlight.json";
/// Groups our items so a single call can drop all of them.
const DOMAIN: &str = "xyz.carpediem.subrosa.notes";
/// What a search result shows under the title.
const MAX_SUMMARY_CHARS: usize = 300;

static SETTINGS: std::sync::OnceLock<std::sync::Mutex<SpotlightSettings>> =
    std::sync::OnceLock::new();

/// What the system's index is allowed to hold.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SpotlightSettings {
    /// Titles and dates. On by default: without them nothing is findable,
    /// and a title is what the user typed on the outside of the note.
    pub enabled: bool,
    /// The note's own text. Off by default, and asked for explicitly — the
    /// body is the private half, and a system index is not the app's storage.
    pub include_content: bool,
}

impl Default for SpotlightSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            include_content: false,
        }
    }
}

pub struct SpotlightState {
    config_path: std::path::PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    use tauri::Manager;
    let path = settings_path(app.handle());
    replace_mirror(load_from_disk(path.as_ref()));
    app.manage(SpotlightState {
        config_path: path.unwrap_or_else(|| std::path::PathBuf::from(SETTINGS_FILE)),
    });
}

pub fn settings() -> SpotlightSettings {
    *mirror().lock().unwrap_or_else(|poison| poison.into_inner())
}

fn mirror() -> &'static std::sync::Mutex<SpotlightSettings> {
    SETTINGS.get_or_init(|| std::sync::Mutex::new(SpotlightSettings::default()))
}

fn replace_mirror(settings: SpotlightSettings) {
    let mut current = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    *current = settings;
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&std::path::PathBuf>) -> SpotlightSettings {
    path.and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<SpotlightSettings>(&raw).ok())
        .unwrap_or_default()
}

/// One note, as the system index sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedNote {
    pub id: String,
    pub title: String,
    /// Empty unless the user opted the body in.
    pub summary: String,
    pub updated_at: String,
}

/// Builds what gets indexed for a note, honouring the content setting.
///
/// Pure, so the privacy rule is testable without touching the system index:
/// with `include_content` off, nothing from the body appears anywhere in the
/// item — not in the summary, not shortened, not at all.
pub fn indexed_note(
    id: &str,
    title: &str,
    content: &str,
    updated_at: &str,
    include_content: bool,
) -> IndexedNote {
    let summary = if include_content {
        let flat = content
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect::<Vec<_>>()
            .join(" ");
        if flat.chars().count() > MAX_SUMMARY_CHARS {
            flat.chars().take(MAX_SUMMARY_CHARS).collect::<String>() + "…"
        } else {
            flat
        }
    } else {
        String::new()
    };
    IndexedNote {
        id: id.to_string(),
        // An untitled note is still findable by date, but it needs a name to
        // show; "New note" is what the app calls it everywhere else.
        title: if title.trim().is_empty() {
            "New note".to_string()
        } else {
            title.trim().to_string()
        },
        summary,
        updated_at: updated_at.to_string(),
    }
}

// --- Commands ----------------------------------------------------------------

#[tauri::command]
pub fn spotlight_get_settings() -> SpotlightSettings {
    settings()
}

/// Saves the setting and immediately makes the index match it: turning
/// indexing off removes what is already there, and toggling content
/// re-indexes rather than leaving a stale body behind.
#[tauri::command]
pub async fn spotlight_set_settings(
    app: AppHandle,
    state: tauri::State<'_, SpotlightState>,
    request: SpotlightSettings,
) -> Result<SpotlightSettings, AppError> {
    if let Some(parent) = state.config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let serialized = serde_json::to_string_pretty(&request)
        .map_err(|error| AppError::new("spotlight_settings_invalid", error.to_string()))?;
    std::fs::write(&state.config_path, serialized)
        .map_err(|error| AppError::new("spotlight_settings_failed", error.to_string()))?;
    replace_mirror(request);
    reindex_all(&app).await;
    Ok(request)
}

/// Rebuilds the whole index from the notes as they are now. Cheap enough to
/// run on launch (titles and dates), and the only way a setting change can
/// be honest about what is left behind.
pub async fn reindex_all(app: &AppHandle) {
    let settings = settings();
    if !settings.enabled {
        index::remove_all();
        return;
    }
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    // One page, generously sized: the index is a convenience, and walking a
    // huge library on every launch is not what "cheap enough to run on
    // launch" means.
    let Ok(response) = repos.list_notes(None, 500, None).await else {
        return;
    };
    let mut items = Vec::with_capacity(response.items.len());
    for note in response.items {
        // The list DTO carries a preview rather than the body; when content
        // is opted in, that preview is exactly the "first lines" a result
        // should show, and it costs no extra read.
        let content = if settings.include_content {
            note.preview.clone()
        } else {
            String::new()
        };
        items.push(indexed_note(
            &note.id,
            &note.title,
            &content,
            &note.updated_at,
            settings.include_content,
        ));
    }
    index::index(&items);
}

/// Fire-and-forget reindex, for call sites that are not async.
pub fn reindex_detached(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        reindex_all(&app).await;
    });
}

/// Drops notes from the index — called when they are deleted, so a search
/// result can never outlive the note it points at.
pub fn forget(note_ids: &[String]) {
    if note_ids.is_empty() {
        return;
    }
    index::remove(note_ids);
}

// --- CoreSpotlight ------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod index {
    use super::{IndexedNote, DOMAIN};
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_core_spotlight::{CSSearchableIndex, CSSearchableItem, CSSearchableItemAttributeSet};
    use objc2_foundation::{NSArray, NSString, NSURL};

    fn searchable(note: &IndexedNote) -> Retained<CSSearchableItem> {
        unsafe {
            // `new()` rather than a content-type initialiser: a note is not
            // a file, and pulling UniformTypeIdentifiers in for a type we
            // would only pass through is a dependency for nothing.
            let attributes = CSSearchableItemAttributeSet::new();
            attributes.setTitle(Some(&NSString::from_str(&note.title)));
            if !note.summary.is_empty() {
                attributes.setContentDescription(Some(&NSString::from_str(&note.summary)));
            }
            // The result opens through the destination router, the same way a
            // notification tap does.
            let url = NSString::from_str(&format!("subrosa://note/{}", note.id));
            if let Some(content_url) = NSURL::URLWithString(&url) {
                attributes.setContentURL(Some(&content_url));
            }
            CSSearchableItem::initWithUniqueIdentifier_domainIdentifier_attributeSet(
                CSSearchableItem::alloc(),
                Some(&NSString::from_str(&note.id)),
                Some(&NSString::from_str(DOMAIN)),
                &attributes,
            )
        }
    }

    pub fn index(notes: &[IndexedNote]) {
        if notes.is_empty() {
            remove_all();
            return;
        }
        unsafe {
            let items: Vec<Retained<CSSearchableItem>> = notes.iter().map(searchable).collect();
            let array = NSArray::from_retained_slice(&items);
            // Best-effort by design: an index that refuses us costs the user
            // nothing they can see, and must never surface as an error.
            CSSearchableIndex::defaultSearchableIndex()
                .indexSearchableItems_completionHandler(&array, None);
        }
    }

    pub fn remove(note_ids: &[String]) {
        unsafe {
            let ids: Vec<Retained<NSString>> =
                note_ids.iter().map(|id| NSString::from_str(id)).collect();
            let array = NSArray::from_retained_slice(&ids);
            CSSearchableIndex::defaultSearchableIndex()
                .deleteSearchableItemsWithIdentifiers_completionHandler(&array, None);
        }
    }

    pub fn remove_all() {
        unsafe {
            let domain = NSString::from_str(DOMAIN);
            let array = NSArray::from_retained_slice(&[domain]);
            CSSearchableIndex::defaultSearchableIndex()
                .deleteSearchableItemsWithDomainIdentifiers_completionHandler(&array, None);
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod index {
    use super::IndexedNote;

    pub fn index(_notes: &[IndexedNote]) {}
    pub fn remove(_note_ids: &[String]) {}
    pub fn remove_all() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "# Decisions\n\nThe rollout slips a week.\nMarie owns the migration.";

    #[test]
    fn the_body_never_reaches_the_index_unless_it_was_asked_for() {
        // The privacy rule of this module, in one assertion: with content
        // off, nothing from the note's text appears anywhere in the item.
        let item = indexed_note("n1", "Point produit", BODY, "2026-08-22T09:00:00Z", false);
        assert_eq!(item.summary, "");
        assert_eq!(item.title, "Point produit");
        assert!(!format!("{item:?}").contains("rollout"));
    }

    #[test]
    fn opted_in_content_is_flattened_past_the_headings_and_capped() {
        let item = indexed_note("n1", "Point produit", BODY, "2026-08-22T09:00:00Z", true);
        assert_eq!(
            item.summary,
            "The rollout slips a week. Marie owns the migration."
        );

        let long = indexed_note("n1", "T", &"word ".repeat(400), "now", true);
        assert!(long.summary.chars().count() <= MAX_SUMMARY_CHARS + 1);
        assert!(long.summary.ends_with('…'));
    }

    #[test]
    fn an_untitled_note_is_still_named_the_way_the_app_names_it() {
        let item = indexed_note("n1", "   ", "", "now", false);
        assert_eq!(item.title, "New note");
    }

    #[test]
    fn titles_are_indexed_by_default_and_the_body_is_not() {
        let defaults = SpotlightSettings::default();
        assert!(defaults.enabled);
        assert!(!defaults.include_content);
    }
}
