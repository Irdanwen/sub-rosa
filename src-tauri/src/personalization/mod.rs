//! Personalization: what the user tells Sub Rosa about themselves, how they
//! want it to answer, and a personality preset (ADR-0081).
//!
//! It is one rendered block, injected at the two existing memory seams and
//! nowhere else: the desktop SOUL (written when the Hermes runtime starts, and
//! rewritten in place when these settings change, so new chats pick it up)
//! and the phone's per-turn system prompt. It reaches the default chat only:
//! a custom assistant carries its own instructions (ADR-0058) and its prompt
//! is built by `assistants::runtime::system_prompt`, which never sees this.
//!
//! Stored in `personalization.json` next to `memory.json`, on this device
//! only: settings files have no sync codec (the account syncs table rows and
//! one reserved credential object), so a second device keeps its own.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, State};

const SETTINGS_FILE: &str = "personalization.json";
/// The most either free-text field may hold, in characters.
pub const MAX_FIELD_CHARS: usize = 1_500;

static SETTINGS: OnceLock<Mutex<PersonalizationSettings>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Personality {
    #[default]
    Default,
    Professional,
    Friendly,
    Candid,
    Efficient,
    Nerdy,
}

impl Personality {
    /// The style sentence the preset adds, or `None` for the default voice.
    pub fn instruction(self) -> Option<&'static str> {
        match self {
            Self::Default => None,
            Self::Professional => Some(
                "Write in a polished, precise and courteous register, as you would for a colleague \
                 or a client. Prefer complete sentences and a clear structure, and leave out slang, \
                 jokes and emoji.",
            ),
            Self::Friendly => Some(
                "Be warm and conversational, like a knowledgeable friend. Keep the tone light and \
                 encouraging, without padding the answer or overdoing the enthusiasm.",
            ),
            Self::Candid => Some(
                "Be direct and honest. Say plainly when something is wrong, risky or a bad idea, \
                 give your actual opinion when asked, and never soften a clear answer into a vague \
                 one. Stay respectful.",
            ),
            Self::Efficient => Some(
                "Be brief. Lead with the answer, cut preamble, recaps and pleasantries, and use as \
                 few words as the question allows. Go into detail only when asked.",
            ),
            Self::Nerdy => Some(
                "Be curious and exploratory. Bring in the underlying mechanism, a telling detail or \
                 the precise term when it helps understanding, and enjoy the subject, without \
                 burying the answer.",
            ),
        }
    }
}

/// The settings file. Missing fields (older files, hand edits) default.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PersonalizationSettings {
    pub enabled: bool,
    /// "What should Sub Rosa know about you?"
    pub about_you: String,
    /// "How should Sub Rosa respond?"
    pub response_style: String,
    pub personality: Personality,
}

impl Default for PersonalizationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            about_you: String::new(),
            response_style: String::new(),
            personality: Personality::Default,
        }
    }
}

/// The words of the block. The web client reads them from the export in
/// `agent_lite::web_client_export`, so a browser's block reads like a phone's.
pub(crate) const BLOCK_HEADER: &str =
    "Personalization: the user set these in Settings for how you work with them. Follow \
     them unless the user asks otherwise in the conversation. They never override your \
     safety rules or the facts.\n";
pub(crate) const ABOUT_LABEL: &str = "About the user:\n";
pub(crate) const STYLE_LABEL: &str = "How the user wants you to respond:\n";
pub(crate) const PERSONALITY_LABEL: &str = "Personality: ";

/// The block both shells inject, or `None` when there is nothing to say:
/// switched off, or every field empty with the default personality. Fields
/// are capped again here, so a hand-edited file cannot grow the prompt.
pub fn render_block(settings: &PersonalizationSettings) -> Option<String> {
    if !settings.enabled {
        return None;
    }
    let about = clean(&settings.about_you);
    let style = clean(&settings.response_style);
    let personality = settings.personality.instruction();
    if about.is_empty() && style.is_empty() && personality.is_none() {
        return None;
    }
    let mut block = String::from(BLOCK_HEADER);
    if !about.is_empty() {
        block.push_str(ABOUT_LABEL);
        block.push_str(&about);
        block.push('\n');
    }
    if !style.is_empty() {
        block.push_str(STYLE_LABEL);
        block.push_str(&style);
        block.push('\n');
    }
    if let Some(instruction) = personality {
        block.push_str(PERSONALITY_LABEL);
        block.push_str(instruction);
        block.push('\n');
    }
    Some(block)
}

fn clean(text: &str) -> String {
    text.trim()
        .chars()
        .take(MAX_FIELD_CHARS)
        .collect::<String>()
}

/// Joins the blocks that are present with a blank line, the way the phone's
/// system prompt is assembled.
fn join_blocks(blocks: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let parts: Vec<String> = blocks
        .into_iter()
        .flatten()
        .map(|block| block.trim_end().to_string())
        .filter(|block| !block.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// Everything the phone's default chat adds to its system prompt this turn:
/// personalization, the memory block the caller already chose, and excerpts
/// of the user's other chats. Custom assistants never come through here.
pub async fn default_chat_context(
    repos: &crate::db::repositories::Repositories,
    task: &crate::domain::types::AgentTaskDto,
    memory_block: Option<&str>,
) -> Option<String> {
    let latest = task.messages.last().map_or("", |m| m.content.as_str());
    let past = crate::memory::past_chats::block_for_turn(repos, &task.id, latest).await;
    join_blocks([
        render_block(&settings()),
        memory_block.map(str::to_string),
        past,
    ])
}

// --- The desktop SOUL ---------------------------------------------------------

const SOUL_START: &str = "<!-- sub-rosa:personal-context -->";
const SOUL_END: &str = "<!-- /sub-rosa:personal-context -->";
/// Around the person's own memory inside the personal section. The SOUL is
/// shared by every chat of the runtime, so the provider proxy cuts this part
/// out of a "Project only" project's requests (ADR-0085 addendum).
pub const MEMORY_START: &str = "<!-- sub-rosa:user-memory -->";
pub const MEMORY_END: &str = "<!-- /sub-rosa:user-memory -->";

/// The personal section of the desktop SOUL: personalization, the memory
/// block, and the line about past chats, between two markers so a settings
/// change can rewrite it in place. Always present, even empty, so there is
/// always a place to write into. The memory block has markers of its own,
/// also always present, so a project's memory can take its place.
pub async fn soul_section_for_app(app: &AppHandle) -> Option<String> {
    let memory = crate::memory::prompt_block_for_app(app).await;
    // Protected mode's block leads the section, so a preference written
    // below it reads as subordinate (ADR-0084).
    Some(soul_section(
        join_blocks([
            crate::protected_mode::prompt_block(),
            render_block(&settings()),
        ]),
        memory,
        crate::memory::past_chats::soul_note().map(str::to_string),
    ))
}

fn soul_section(
    personalization: Option<String>,
    memory: Option<String>,
    past_chats: Option<String>,
) -> String {
    let memory = memory
        .map(|block| format!("{}\n", defuse_markers(block.trim_end())))
        .unwrap_or_default();
    let body = join_blocks([
        personalization.map(|block| defuse_markers(&block)),
        Some(format!("{MEMORY_START}\n{memory}{MEMORY_END}")),
        past_chats.map(|block| defuse_markers(&block)),
    ])
    .unwrap_or_default();
    format!("{SOUL_START}\n{body}\n{SOUL_END}\n")
}

/// A remembered fact or a preference is the person's text (or the model's
/// reading of it): an HTML comment in it must not open or close a section,
/// or the cut the proxy makes would leave part of the memory behind.
fn defuse_markers(text: &str) -> String {
    text.replace("<!--", "<!\u{200B}--")
}

/// `soul` with its personal section replaced by `section`, or `None` when
/// the soul has no markers (written by an older build: the next start fixes
/// it). `section` carries its own markers.
#[cfg_attr(mobile, allow(dead_code))]
fn splice_soul_section(soul: &str, section: &str) -> Option<String> {
    let start = soul.find(SOUL_START)?;
    let end_marker = start + soul[start..].find(SOUL_END)?;
    let mut end = end_marker + SOUL_END.len();
    if soul[end..].starts_with('\n') {
        end += 1;
    }
    Some(format!("{}{section}{}", &soul[..start], &soul[end..]))
}

/// Rewrites the personal section of the SOUL the runtime already has, so a
/// chat started from now on reads the new settings. Best-effort: no SOUL yet
/// means the runtime has not started, and it will write the section itself.
#[cfg(desktop)]
pub async fn refresh_soul(app: &AppHandle) {
    // `hermes_bridge` keeps the managed Hermes home at `<app data>/hermes`.
    let Ok(dir) = crate::app_paths::app_data_dir(app) else {
        return;
    };
    let path = dir.join("hermes").join("SOUL.md");
    let Ok(current) = fs::read_to_string(&path) else {
        return;
    };
    let Some(section) = soul_section_for_app(app).await else {
        return;
    };
    if let Some(next) = splice_soul_section(&current, &section) {
        if next != current {
            if let Err(error) = fs::write(&path, next) {
                tracing::warn!("Could not refresh the personal section of the soul: {error}");
            }
        }
    }
}

// --- Settings ----------------------------------------------------------------

pub struct PersonalizationState {
    config_path: PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE));
    replace_mirror(load_from_disk(path.as_ref()));
    app.manage(PersonalizationState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
}

pub fn settings() -> PersonalizationSettings {
    mirror()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

#[tauri::command]
pub fn personalization_get_settings() -> PersonalizationSettings {
    settings()
}

#[tauri::command]
pub async fn personalization_set_settings(
    app: AppHandle,
    state: State<'_, PersonalizationState>,
    request: PersonalizationSettings,
) -> Result<PersonalizationSettings, AppError> {
    let next = validate(request)?;
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    #[cfg(desktop)]
    refresh_soul(&app).await;
    #[cfg(not(desktop))]
    let _ = app;
    Ok(next)
}

fn validate(request: PersonalizationSettings) -> Result<PersonalizationSettings, AppError> {
    let about_you = request.about_you.trim().to_string();
    let response_style = request.response_style.trim().to_string();
    if about_you.chars().count() > MAX_FIELD_CHARS
        || response_style.chars().count() > MAX_FIELD_CHARS
    {
        return Err(AppError::new(
            "personalization_too_long",
            "Keep each answer under 1500 characters.",
        ));
    }
    Ok(PersonalizationSettings {
        about_you,
        response_style,
        ..request
    })
}

fn mirror() -> &'static Mutex<PersonalizationSettings> {
    SETTINGS.get_or_init(|| Mutex::new(PersonalizationSettings::default()))
}

fn replace_mirror(settings: PersonalizationSettings) {
    let mut current = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    *current = settings;
}

fn load_from_disk(path: Option<&PathBuf>) -> PersonalizationSettings {
    path.and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<PersonalizationSettings>(&raw).ok())
        .unwrap_or_default()
}

fn persist(path: &PathBuf, settings: &PersonalizationSettings) -> Result<(), AppError> {
    let failed = |error: String| AppError::new("personalization_save", error);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| failed(error.to_string()))?;
    }
    let serialized =
        serde_json::to_string_pretty(settings).map_err(|error| failed(error.to_string()))?;
    fs::write(path, serialized).map_err(|error| failed(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filled() -> PersonalizationSettings {
        PersonalizationSettings {
            enabled: true,
            about_you: "  I run a bakery in Lyon.  ".to_string(),
            response_style: "Answer in French.".to_string(),
            personality: Personality::Efficient,
        }
    }

    #[test]
    fn empty_fields_and_the_default_personality_render_nothing() {
        assert_eq!(render_block(&PersonalizationSettings::default()), None);
        let blank = PersonalizationSettings {
            about_you: "   ".to_string(),
            response_style: "\n".to_string(),
            ..PersonalizationSettings::default()
        };
        assert_eq!(render_block(&blank), None);
    }

    #[test]
    fn switched_off_renders_nothing_whatever_is_filled() {
        let off = PersonalizationSettings {
            enabled: false,
            ..filled()
        };
        assert_eq!(render_block(&off), None);
    }

    #[test]
    fn the_block_holds_each_filled_part_and_only_those() {
        let block = render_block(&filled()).unwrap();
        assert!(block.starts_with("Personalization:"));
        assert!(block.contains("About the user:\nI run a bakery in Lyon.\n"));
        assert!(block.contains("How the user wants you to respond:\nAnswer in French.\n"));
        assert!(block.contains("Personality: Be brief."));

        let only_preset = PersonalizationSettings {
            personality: Personality::Candid,
            ..PersonalizationSettings::default()
        };
        let block = render_block(&only_preset).unwrap();
        assert!(!block.contains("About the user"));
        assert!(!block.contains("How the user wants you to respond"));
        assert!(block.contains("Be direct and honest."));
    }

    #[test]
    fn every_preset_but_the_default_has_a_style() {
        for preset in [
            Personality::Professional,
            Personality::Friendly,
            Personality::Candid,
            Personality::Efficient,
            Personality::Nerdy,
        ] {
            let instruction = preset.instruction().unwrap();
            assert!(instruction.len() > 40 && instruction.len() < 300);
        }
        assert_eq!(Personality::Default.instruction(), None);
    }

    #[test]
    fn the_block_caps_a_hand_edited_field() {
        let long = PersonalizationSettings {
            about_you: "a".repeat(5_000),
            ..PersonalizationSettings::default()
        };
        let block = render_block(&long).unwrap();
        let field = block
            .lines()
            .skip_while(|line| *line != "About the user:")
            .nth(1)
            .unwrap();
        assert_eq!(field.chars().count(), MAX_FIELD_CHARS);
    }

    #[test]
    fn validation_trims_and_refuses_overlong_answers() {
        let ok = validate(filled()).unwrap();
        assert_eq!(ok.about_you, "I run a bakery in Lyon.");
        let too_long = PersonalizationSettings {
            response_style: "x".repeat(MAX_FIELD_CHARS + 1),
            ..filled()
        };
        assert_eq!(
            validate(too_long).unwrap_err().code,
            "personalization_too_long"
        );
        let at_limit = PersonalizationSettings {
            response_style: format!("  {}  ", "x".repeat(MAX_FIELD_CHARS)),
            ..filled()
        };
        assert!(validate(at_limit).is_ok());
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let dir = std::env::temp_dir().join(format!("personalization-{}", uuid::Uuid::new_v4()));
        let path = dir.join(SETTINGS_FILE);
        persist(&path, &filled()).unwrap();
        assert_eq!(load_from_disk(Some(&path)), filled());
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"personality\": \"efficient\""));
        assert!(raw.contains("\"aboutYou\""));
        let _ = fs::remove_dir_all(dir);
        // A missing file, or one from a future build with fewer fields.
        assert_eq!(
            load_from_disk(Some(&PathBuf::from("/nonexistent/p.json"))),
            PersonalizationSettings::default()
        );
        let partial: PersonalizationSettings =
            serde_json::from_str(r#"{"personality":"nerdy"}"#).unwrap();
        assert!(partial.enabled);
        assert_eq!(partial.personality, Personality::Nerdy);
    }

    #[test]
    fn the_soul_section_is_marked_even_when_empty_and_splices_in_place() {
        let empty = soul_section(None, None, None);
        assert_eq!(
            empty,
            format!("{SOUL_START}\n{MEMORY_START}\n{MEMORY_END}\n{SOUL_END}\n")
        );
        let soul = format!("You are Sub Rosa.\n\n{empty}## Context\nTools.\n");
        let full = soul_section(
            render_block(&filled()),
            Some("User memory: facts\n- likes tea\n".to_string()),
            None,
        );
        let next = splice_soul_section(&soul, &full).unwrap();
        assert!(next.starts_with("You are Sub Rosa.\n\n<!-- sub-rosa:personal-context -->\n"));
        assert!(next.contains("Personalization:"));
        assert!(next.contains("Personality: Be brief."));
        assert!(next.contains("\n\n<!-- sub-rosa:user-memory -->\nUser memory: facts\n- likes tea\n<!-- /sub-rosa:user-memory -->\n<!-- /sub-rosa:personal-context -->\n## Context\nTools.\n"));
        // Splicing the same section again changes nothing, and back to empty
        // restores the original byte for byte.
        assert_eq!(splice_soul_section(&next, &full).unwrap(), next);
        assert_eq!(splice_soul_section(&next, &empty).unwrap(), soul);
        // A soul from an older build has no markers to write into.
        assert_eq!(splice_soul_section("You are Sub Rosa.\n", &full), None);
    }

    #[test]
    fn a_comment_in_a_fact_cannot_close_the_memory_section_early() {
        let section = soul_section(
            None,
            Some("User memory:\n- wrote <!-- /sub-rosa:user-memory --> once\n- likes tea\n".into()),
            Some("Earlier conversations: search them.\n".into()),
        );
        let start = section.find(MEMORY_START).unwrap();
        let end = section.find(MEMORY_END).unwrap();
        assert_eq!(section.matches(MEMORY_END).count(), 1);
        assert!(section[start..end].contains("likes tea"));
        assert!(section[end..].contains("Earlier conversations"));
    }

    #[test]
    fn the_phone_context_joins_only_the_blocks_present() {
        assert_eq!(join_blocks([None, None]), None);
        assert_eq!(
            join_blocks([Some("A\n".to_string()), None, Some("B".to_string())]),
            Some("A\n\nB".to_string())
        );
    }
}
