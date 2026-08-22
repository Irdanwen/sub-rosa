//! The moments the app speaks first.
//!
//! Two of them, and they are deliberately few:
//!
//! - **the brief**, ten minutes before a meeting: who, and what you last
//!   said to them;
//! - **the recap**, when a recording has become a note: that it is ready,
//!   and what it opens with.
//!
//! An app that speaks first has to earn it, so the governing rule here is
//! that **silence is a feature**. A meeting we know nothing about produces
//! nothing. A day with no history produces nothing. There is one brief per
//! meeting, ever, and a hard daily cap — a brief that arrives every morning
//! saying nothing trains people to swipe it away, which costs more than it
//! ever gave.
//!
//! Everything durable lives in a row, never in a timer (ADR-0018): iOS
//! freezes the webview and suspends the process, so a `setTimeout` for
//! "ten minutes before the 10:00" is a promise the platform will not keep.
//! `crate::background::sweep` schedules and delivers; the row is the truth.

use crate::domain::types::AppError;
use crate::{calendar, destinations, june_api};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// How long before a meeting the brief lands. Long enough to read and act
/// on, short enough that it is still about the next thing you do.
const BRIEF_LEAD_SECS: i64 = 10 * 60;
/// How far ahead we look when scheduling. Beyond this the calendar changes
/// too often for a scheduled row to still be true.
const SCHEDULE_HORIZON_SECS: i64 = 12 * 60 * 60;
/// A brief produced after this much of the meeting has passed is late enough
/// to be noise.
const BRIEF_STALE_SECS: i64 = 5 * 60;
/// The cap that keeps a busy day from becoming a notification storm.
const MAX_BRIEFS_PER_DAY: i64 = 6;
/// How many past notes feed one brief.
const NOTES_IN_BRIEF: i64 = 4;
/// Notification bodies are read on a lock screen, not in a reader.
const MAX_BRIEF_CHARS: usize = 240;

const BRIEF_SYSTEM_PROMPT: &str = "You write a one-line reminder for someone about to walk into a meeting. You are given the meeting and excerpts of their own past notes with these people. Write at most two short sentences: what was last decided or promised, and anything left open. Be concrete — names, decisions, numbers. No preamble, no greeting, no bullet points, no markdown. If the excerpts say nothing useful about these people or this subject, reply with exactly: NOTHING";

/// The sentinel the model returns when there is nothing worth saying. It is
/// the most important answer this feature has.
const NOTHING: &str = "NOTHING";

// --- Settings ----------------------------------------------------------------

const SETTINGS_FILE: &str = "moments.json";
static SETTINGS: std::sync::OnceLock<std::sync::Mutex<MomentSettings>> = std::sync::OnceLock::new();

/// What the app is allowed to say first.
///
/// The brief is **off until asked for**, unlike memory. Memory makes the app
/// better at answering; the brief makes it start talking, and nothing should
/// start talking to someone who never said yes. The recap is on by default:
/// it only ever fires as the result of a recording the user just made, and it
/// is the answer to "is it done yet".
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MomentSettings {
    /// The ten-minutes-before brief.
    pub brief_enabled: bool,
    /// "Your note is ready", when a recording has finished becoming one.
    pub recap_enabled: bool,
}

impl Default for MomentSettings {
    fn default() -> Self {
        Self {
            brief_enabled: false,
            recap_enabled: true,
        }
    }
}

pub struct MomentsState {
    config_path: std::path::PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    use tauri::Manager;
    let path = settings_path(app.handle());
    replace_mirror(load_from_disk(path.as_ref()));
    app.manage(MomentsState {
        config_path: path.unwrap_or_else(|| std::path::PathBuf::from(SETTINGS_FILE)),
    });
}

/// Readable from any thread: the sweep runs outside command context.
pub fn settings() -> MomentSettings {
    *mirror().lock().unwrap_or_else(|poison| poison.into_inner())
}

fn mirror() -> &'static std::sync::Mutex<MomentSettings> {
    SETTINGS.get_or_init(|| std::sync::Mutex::new(MomentSettings::default()))
}

fn replace_mirror(settings: MomentSettings) {
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

fn load_from_disk(path: Option<&std::path::PathBuf>) -> MomentSettings {
    path.and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<MomentSettings>(&raw).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn moments_get_settings() -> MomentSettings {
    settings()
}

#[tauri::command]
pub fn moments_set_settings(
    state: tauri::State<'_, MomentsState>,
    request: MomentSettings,
) -> Result<MomentSettings, AppError> {
    if let Some(parent) = state.config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let serialized = serde_json::to_string_pretty(&request)
        .map_err(|error| AppError::new("moments_settings_invalid", error.to_string()))?;
    std::fs::write(&state.config_path, serialized)
        .map_err(|error| AppError::new("moments_settings_failed", error.to_string()))?;
    replace_mirror(request);
    Ok(request)
}

/// Schedules briefs for the meetings ahead, and delivers the ones that are
/// due. Called from the sweep on both platforms; every step is idempotent,
/// so running it twice changes nothing.
pub async fn tick(app: &AppHandle) {
    // Off means off: no scheduling, no rows, no model call, no notification.
    if !settings().brief_enabled {
        return;
    }
    if let Err(error) = schedule_upcoming(app).await {
        eprintln!("brief scheduling failed: {}", error.message);
    }
    if let Err(error) = deliver_due(app).await {
        eprintln!("brief delivery failed: {}", error.message);
    }
}

/// Writes a pending row for every qualifying meeting in the next few hours.
///
/// Qualifying is deliberately narrow: a real meeting (not all-day), with
/// other people in it (a solo focus block needs no briefing), still ahead of
/// us, and not already scheduled. The unique index on the event id is what
/// makes "one brief per meeting, ever" true even across relaunches.
async fn schedule_upcoming(app: &AppHandle) -> Result<(), AppError> {
    if calendar::access_state() != calendar::CalendarAccess::Granted {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp();
    let events = calendar::events_in_window(now, now + SCHEDULE_HORIZON_SECS);
    if events.is_empty() {
        return Ok(());
    }
    let repos = crate::commands::repositories(app).await?;
    for event in events {
        if !qualifies_for_brief(&event, now) {
            continue;
        }
        let due = crate::domain::types::rfc3339_from_epoch_secs(event.start - BRIEF_LEAD_SECS);
        repos
            .insert_pending_brief(&event.id, &event.title, &due)
            .await
            .map_err(AppError::from)?;
    }
    Ok(())
}

/// The rule, pure so it is testable without a calendar.
pub fn qualifies_for_brief(event: &calendar::CalendarEventDto, now: i64) -> bool {
    // All-day entries are not meetings anyone walks into.
    if event.all_day {
        return false;
    }
    // A meeting with nobody else in it is a block of time, and briefing
    // someone about their own focus block is exactly the noise this feature
    // must not become.
    if event.attendees.len() < 2 {
        return false;
    }
    // Already started, or so close that the brief would land after it began.
    event.start - BRIEF_LEAD_SECS > now
}

/// Produces and delivers every brief that has come due.
async fn deliver_due(app: &AppHandle) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let now = chrono::Utc::now();
    let due = repos
        .due_briefs(&now.to_rfc3339())
        .await
        .map_err(AppError::from)?;
    if due.is_empty() {
        return Ok(());
    }
    let mut delivered_today = repos
        .briefs_delivered_since(&(now - chrono::Duration::hours(24)).to_rfc3339())
        .await
        .map_err(AppError::from)?;

    for brief in due {
        // The meeting may have moved or been deleted since we scheduled it.
        let Some(event) = calendar::event_by_id(&brief.calendar_event_id) else {
            repos.settle_brief(&brief.id, "skipped", None).await.ok();
            continue;
        };
        if event.start + BRIEF_STALE_SECS < now.timestamp() {
            // It already started: a brief now is worse than none.
            repos.settle_brief(&brief.id, "skipped", None).await.ok();
            continue;
        }
        if delivered_today >= MAX_BRIEFS_PER_DAY {
            repos.settle_brief(&brief.id, "skipped", None).await.ok();
            continue;
        }

        let context = brief_context(&repos, &event).await;
        // Nothing in the notes about these people: say nothing. This is the
        // silence rule, and it fires before any model is paid.
        if context.trim().is_empty() {
            repos.settle_brief(&brief.id, "skipped", None).await.ok();
            continue;
        }
        let Some(body) = write_brief(&event, &context).await else {
            repos.settle_brief(&brief.id, "skipped", None).await.ok();
            continue;
        };

        let _ = app
            .notification()
            .builder()
            .title(if event.title.trim().is_empty() {
                "Your next meeting".to_string()
            } else {
                event.title.clone()
            })
            .body(body.clone())
            // Tapping a brief starts recording the meeting it briefed you
            // on — the one thing you were about to do anyway.
            .extra(destinations::EXTRA_KEY, destinations::record())
            .show();
        repos
            .settle_brief(&brief.id, "delivered", Some(&body))
            .await
            .ok();
        delivered_today += 1;
    }
    Ok(())
}

/// The excerpts a brief is written from: the user's own notes about these
/// people and this subject. Nothing else is read, and nothing leaves the
/// device except what goes into the one completion below.
async fn brief_context(
    repos: &crate::db::repositories::Repositories,
    event: &calendar::CalendarEventDto,
) -> String {
    let mut queries: Vec<String> = Vec::new();
    let title = event.title.trim();
    if !title.is_empty() {
        queries.push(title.to_string());
    }
    // Attendee names find the history that a title alone would miss.
    for attendee in event.attendees.iter().take(3) {
        let first = attendee.split_whitespace().next().unwrap_or(attendee);
        if first.chars().count() > 2 {
            queries.push(first.to_string());
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut excerpts: Vec<String> = Vec::new();
    for query in queries {
        let Ok(snippets) = repos.search_note_context(&query, NOTES_IN_BRIEF).await else {
            continue;
        };
        for snippet in snippets {
            let text = snippet.snippet.trim().to_string();
            if text.is_empty() || !seen.insert(text.clone()) {
                continue;
            }
            excerpts.push(format!("[{}] {}", snippet.title, text));
            if excerpts.len() >= 6 {
                break;
            }
        }
        if excerpts.len() >= 6 {
            break;
        }
    }
    excerpts.join("\n\n")
}

/// One completion, on whatever model the proxy defaults to, with a tight
/// budget. A brief must never be felt on the bill.
async fn write_brief(event: &calendar::CalendarEventDto, context: &str) -> Option<String> {
    let who = if event.attendees.is_empty() {
        String::new()
    } else {
        format!("\nWith: {}", event.attendees.join(", "))
    };
    let prompt = format!(
        "Meeting: {}{}\n\nTheir past notes:\n{}",
        event.title, who, context
    );
    let response = june_api::proxy_agent_chat_completions(serde_json::json!({
        "messages": [
            { "role": "system", "content": BRIEF_SYSTEM_PROMPT },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.2,
        "max_tokens": 300
    }))
    .await
    .ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    let body = response.collect_body().await.ok()?;
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let text = june_api::extract_chat_completion_text(&value)?;
    clean_brief(&text)
}

/// Trims a model answer into something a lock screen can hold, and honours
/// the NOTHING sentinel.
pub fn clean_brief(raw: &str) -> Option<String> {
    let text = raw.trim().trim_matches('"').trim();
    if text.is_empty() || text.eq_ignore_ascii_case(NOTHING) || text.starts_with(NOTHING) {
        return None;
    }
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > MAX_BRIEF_CHARS {
        let mut cut: String = collapsed.chars().take(MAX_BRIEF_CHARS).collect();
        cut.push('…');
        return Some(cut);
    }
    Some(collapsed)
}

// --- The recap ---------------------------------------------------------------

/// Tells the user their recording has become a note, and what it opens with.
///
/// Free by design: the note is already written, so the recap reads it rather
/// than paying for a second opinion about it. Posted from Rust because the
/// webview is frozen while the app is in the background, which is exactly
/// when a long transcription finishes.
pub fn announce_note_ready(app: &AppHandle, note_id: &str, title: &str, content: &str) {
    if !settings().recap_enabled {
        return;
    }
    let Some(body) = recap_line(content) else {
        return;
    };
    let title = if title.trim().is_empty() {
        "Your note is ready".to_string()
    } else {
        format!("{} is ready", title.trim())
    };
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .extra(destinations::EXTRA_KEY, destinations::note(note_id))
        .show();
}

/// The first real sentence of a generated note: what it opens with, skipping
/// the headings the generator writes. None when there is nothing to say.
pub fn recap_line(content: &str) -> Option<String> {
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))?;
    let cleaned = line
        .trim_start_matches(['-', '*', '•'])
        .replace("**", "")
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.chars().count() > MAX_BRIEF_CHARS {
        let mut cut: String = cleaned.chars().take(MAX_BRIEF_CHARS).collect();
        cut.push('…');
        return Some(cut);
    }
    Some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::CalendarEventDto;

    const T: i64 = 1_760_000_000;

    fn event(attendees: &[&str], start: i64) -> CalendarEventDto {
        CalendarEventDto {
            id: "e1".to_string(),
            title: "Point produit".to_string(),
            start,
            end: start + 1800,
            all_day: false,
            location: None,
            agenda: None,
            attendees: attendees.iter().map(|name| (*name).to_string()).collect(),
        }
    }

    #[test]
    fn a_meeting_with_other_people_ahead_of_us_qualifies() {
        assert!(qualifies_for_brief(&event(&["Marie", "Tom"], T + 3600), T));
    }

    #[test]
    fn a_solo_block_never_earns_a_brief() {
        // The single most important no: briefing someone about their own
        // focus time is the noise that kills the feature.
        assert!(!qualifies_for_brief(&event(&[], T + 3600), T));
        assert!(!qualifies_for_brief(&event(&["Me"], T + 3600), T));
    }

    #[test]
    fn all_day_entries_and_meetings_already_upon_us_do_not() {
        let mut all_day = event(&["Marie", "Tom"], T + 3600);
        all_day.all_day = true;
        assert!(!qualifies_for_brief(&all_day, T));
        // Starts in five minutes: the brief would land after it began.
        assert!(!qualifies_for_brief(
            &event(&["Marie", "Tom"], T + 5 * 60),
            T
        ));
        assert!(!qualifies_for_brief(&event(&["Marie", "Tom"], T - 60), T));
    }

    #[test]
    fn the_nothing_sentinel_is_silence_not_a_notification() {
        assert_eq!(clean_brief("NOTHING"), None);
        assert_eq!(clean_brief("  nothing  "), None);
        assert_eq!(clean_brief("NOTHING useful in the notes"), None);
        assert_eq!(clean_brief("   "), None);
        assert_eq!(clean_brief(""), None);
    }

    #[test]
    fn a_brief_is_collapsed_unquoted_and_capped() {
        assert_eq!(
            clean_brief("\"You agreed the rollout\n  slips a week.\""),
            Some("You agreed the rollout slips a week.".to_string())
        );
        let long = clean_brief(&"word ".repeat(200)).unwrap();
        assert!(long.chars().count() <= MAX_BRIEF_CHARS + 1);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn the_brief_is_off_until_asked_for_and_the_recap_is_not() {
        // The defaults are the product decision: nothing starts talking to
        // someone who never said yes, but "is it done yet" may be answered.
        let defaults = MomentSettings::default();
        assert!(!defaults.brief_enabled);
        assert!(defaults.recap_enabled);
    }

    #[test]
    fn the_recap_reads_the_first_real_sentence_past_the_headings() {
        let note = "# Decisions\n\n- **Rollout** slips a week\n\n# Follow-ups\n";
        assert_eq!(recap_line(note), Some("Rollout slips a week".to_string()));
        assert_eq!(recap_line("# Only a heading\n"), None);
        assert_eq!(recap_line(""), None);
    }
}
