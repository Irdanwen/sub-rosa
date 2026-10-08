//! The daily brief (ADR-0091, an addendum to the moments): one card a
//! morning, at the time the person chose.
//!
//! It is the third moment the app speaks first, and it keeps the two rules
//! the others live by. **Off until asked for**, because a card every morning
//! is the app starting to talk. And **silence is a feature**: a morning with
//! nothing on the calendar, nothing written yesterday, nothing to review,
//! nothing failed and nothing new on a followed topic gets no card and no
//! notification. It counts against the moments' daily cap like a brief does.
//!
//! What it says is read, never written by a model: the day's agenda as one
//! line (the calendar stays context, never a list you open, ADR-0025),
//! yesterday's notes and the follow-ups they wrote down, the assignment
//! results waiting for review, the runs that failed, and what is new on the
//! topics the person follows, one web search each. The card is a row
//! (`daily_briefs`), written once a day by the sweep or the clock, so a phone
//! that was asleep at 7:30 still has its card when it is opened.

use chrono::{DateTime, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::domain::types::AppError;

const SETTINGS_FILE: &str = "daily_brief.json";
/// A card first written this long after its time is shown, never announced.
pub(crate) const NOTIFY_WINDOW_MINUTES: i64 = 4 * 60;
pub(crate) const MAX_TOPICS: usize = 5;
pub(crate) const MAX_TOPIC_CHARS: usize = 80;
pub(crate) const LINKS_PER_TOPIC: usize = 2;
pub(crate) const MAX_NOTES: usize = 5;
pub(crate) const MAX_FOLLOW_UPS: usize = 3;
pub(crate) const MAX_ITEMS: usize = 5;

static SETTINGS: std::sync::OnceLock<std::sync::Mutex<DailyBriefSettings>> =
    std::sync::OnceLock::new();
static CONFIG_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
static WRITING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct DailyBriefSettings {
    pub enabled: bool,
    /// Minutes after local midnight.
    pub at_minute: u32,
}

impl Default for DailyBriefSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            at_minute: 7 * 60 + 30,
        }
    }
}

pub fn settings() -> DailyBriefSettings {
    *SETTINGS
        .get_or_init(|| std::sync::Mutex::new(DailyBriefSettings::default()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn replace(next: DailyBriefSettings) {
    *SETTINGS
        .get_or_init(|| std::sync::Mutex::new(DailyBriefSettings::default()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = next;
}

/// Loaded with the other moments' settings, at setup.
pub(super) fn load(app: &AppHandle) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let path = dir.join(SETTINGS_FILE);
    let loaded = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DailyBriefSettings>(&raw).ok())
        .unwrap_or_default();
    replace(loaded);
    let _ = CONFIG_PATH.set(path);
}

// --- The card ------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Agenda {
    /// Meetings today that are not all-day entries.
    pub count: usize,
    /// The next one still ahead when the card was written, else the first.
    pub first_title: String,
    pub first_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardNote {
    pub id: String,
    pub title: String,
    pub follow_ups: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardItem {
    /// The assignment run, when there is one to open.
    pub run_id: Option<String>,
    pub assignment_id: Option<String>,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardLink {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardTopic {
    pub topic: String,
    pub links: Vec<CardLink>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DailyCard {
    pub day: String,
    pub created_at: String,
    pub agenda: Option<Agenda>,
    pub notes: Vec<CardNote>,
    pub reviews: Vec<CardItem>,
    pub failures: Vec<CardItem>,
    pub topics: Vec<CardTopic>,
}

impl DailyCard {
    /// Nothing to say: the silence rule.
    pub fn is_empty(&self) -> bool {
        self.agenda.is_none()
            && self.notes.is_empty()
            && self.reviews.is_empty()
            && self.failures.is_empty()
            && self.topics.iter().all(|topic| topic.links.is_empty())
    }

    /// The notification's one line: what is in the card, counted, in the
    /// app's language. Read on a lock screen, so short. Plurals are two
    /// sentences chosen here, as in the webview (ADR-0047).
    pub fn headline(&self) -> String {
        let mut parts = Vec::new();
        if let Some(agenda) = &self.agenda {
            parts.push(match agenda.count {
                1 => crate::tr!("1 meeting"),
                count => crate::tr!("{count} meetings", count = count),
            });
        }
        if !self.notes.is_empty() {
            parts.push(match self.notes.len() {
                1 => crate::tr!("1 note from yesterday"),
                count => crate::tr!("{count} notes from yesterday", count = count),
            });
        }
        if !self.reviews.is_empty() {
            parts.push(match self.reviews.len() {
                1 => crate::tr!("1 result to review"),
                count => crate::tr!("{count} results to review", count = count),
            });
        }
        if !self.failures.is_empty() {
            parts.push(match self.failures.len() {
                1 => crate::tr!("1 run that failed"),
                count => crate::tr!("{count} runs that failed", count = count),
            });
        }
        let news = self
            .topics
            .iter()
            .filter(|topic| !topic.links.is_empty())
            .count();
        if news > 0 {
            parts.push(match news {
                1 => crate::tr!("news on 1 followed topic"),
                count => crate::tr!("news on {count} followed topics", count = count),
            });
        }
        parts.join(", ")
    }
}

/// Words that make a heading a list of follow-ups, in English or French.
pub(crate) const FOLLOW_UP_HEADINGS: [&str; 9] = [
    "follow",
    "next step",
    "action",
    "to do",
    "todo",
    "à faire",
    "suite",
    "prochaine",
    "actions",
];

/// The follow-ups a note wrote down: the items under a heading that names
/// them (follow-ups, next steps, action items, to do, in English or French).
pub fn follow_ups(content: &str) -> Vec<String> {
    let mut inside = false;
    let mut found = Vec::new();
    for line in content.lines().map(str::trim) {
        if line.starts_with('#') || (line.starts_with("**") && line.ends_with("**")) {
            let heading = line
                .trim_start_matches('#')
                .trim_matches('*')
                .trim()
                .to_lowercase();
            inside = FOLLOW_UP_HEADINGS.iter().any(|word| heading.contains(word));
            continue;
        }
        if !inside {
            continue;
        }
        let item = line
            .trim_start_matches(['-', '*', '•'])
            .trim()
            .trim_start_matches("[ ]")
            .trim_start_matches("[x]")
            .trim()
            .replace("**", "");
        if !item.is_empty() {
            found.push(item);
        }
        if found.len() == MAX_FOLLOW_UPS {
            break;
        }
    }
    found
}

/// Whether today's card is owed now: the brief is on, its time has passed,
/// and today has no row yet.
pub fn card_due(settings: &DailyBriefSettings, now_minute: u32, written_today: bool) -> bool {
    settings.enabled && !written_today && now_minute >= settings.at_minute
}

/// Whether a card written at `now_minute` may still notify, rather than wait
/// quietly in the Today view.
pub fn may_notify(settings: &DailyBriefSettings, now_minute: u32) -> bool {
    i64::from(now_minute) - i64::from(settings.at_minute) <= NOTIFY_WINDOW_MINUTES
}

fn minute_of(now: &DateTime<Local>) -> u32 {
    now.hour() * 60 + now.minute()
}

fn day_of(now: &DateTime<Local>) -> String {
    now.format("%Y-%m-%d").to_string()
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool.clone())
}

fn local_midnight(day: chrono::NaiveDate) -> DateTime<Local> {
    Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap_or_default())
        .earliest()
        .unwrap_or_else(Local::now)
}

/// One calendar entry as the agenda line reads it: when it starts, whether it
/// fills the day, its title, and its start as the card prints it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgendaEvent {
    pub start: i64,
    pub all_day: bool,
    pub title: String,
    /// `HH:MM`, in the composing device's time.
    pub at: String,
}

/// The agenda line of a day's entries: the meetings that are not all-day,
/// counted, and the next one still ahead at `now`, else the first. Pure, and
/// ported to the web client, which reads its entries from a connected
/// calendar instead (ADR-0107).
pub fn agenda_of(events: &[AgendaEvent], now: i64) -> Option<Agenda> {
    let mut events: Vec<&AgendaEvent> = events.iter().filter(|event| !event.all_day).collect();
    events.sort_by_key(|event| event.start);
    let first = events
        .iter()
        .find(|event| event.start >= now)
        .or_else(|| events.first())?;
    Some(Agenda {
        count: events.len(),
        first_title: first.title.clone(),
        first_at: first.at.clone(),
    })
}

fn agenda(now: &DateTime<Local>) -> Option<Agenda> {
    if crate::calendar::access_state() != crate::calendar::CalendarAccess::Granted {
        return None;
    }
    let start = local_midnight(now.date_naive());
    let end = start + chrono::Duration::days(1);
    let events: Vec<AgendaEvent> =
        crate::calendar::events_in_window(start.timestamp(), end.timestamp())
            .into_iter()
            .map(|event| AgendaEvent {
                start: event.start,
                all_day: event.all_day,
                at: Local
                    .timestamp_opt(event.start, 0)
                    .single()
                    .map(|at| at.format("%H:%M").to_string())
                    .unwrap_or_default(),
                title: event.title,
            })
            .collect();
    agenda_of(&events, now.timestamp())
}

async fn yesterdays_notes(pool: &SqlitePool, now: &DateTime<Local>) -> Vec<CardNote> {
    let today = local_midnight(now.date_naive());
    let yesterday = today - chrono::Duration::days(1);
    let Ok(rows) = query("SELECT id, title, COALESCE(edited_content, generated_content, '') AS content FROM notes WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
        .bind(yesterday.with_timezone(&chrono::Utc).to_rfc3339())
        .bind(today.with_timezone(&chrono::Utc).to_rfc3339())
        .bind(MAX_NOTES as i64)
        .fetch_all(pool)
        .await
    else {
        return Vec::new();
    };
    rows.iter()
        .map(|row| {
            let content: String = row.get("content");
            CardNote {
                id: row.get("id"),
                title: row.get("title"),
                follow_ups: follow_ups(&content),
            }
        })
        .collect()
}

async fn reviews_and_failures(
    app: &AppHandle,
    pool: &SqlitePool,
) -> (Vec<CardItem>, Vec<CardItem>) {
    use crate::assignments::store;
    let reviews = store::needs_review(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .take(MAX_ITEMS)
        .map(|(run, title)| CardItem {
            detail: run
                .result
                .as_deref()
                .map(crate::assignments::prompt::result_summary)
                .unwrap_or_default(),
            run_id: Some(run.id),
            assignment_id: Some(run.assignment_id),
            title,
        })
        .collect();
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    let mut failures: Vec<CardItem> = store::failed_since(pool, &since)
        .await
        .unwrap_or_default()
        .into_iter()
        .take(MAX_ITEMS)
        .map(|(run, title)| CardItem {
            detail: run.error.unwrap_or_default(),
            run_id: Some(run.id),
            assignment_id: Some(run.assignment_id),
            title,
        })
        .collect();
    failures.extend(failed_routines(app, &since).await);
    failures.truncate(MAX_ITEMS);
    (reviews, failures)
}

/// Desktop routines (Hermes cron jobs) whose last run failed in the last day.
#[cfg(desktop)]
async fn failed_routines(app: &AppHandle, since: &str) -> Vec<CardItem> {
    use tauri::Manager as _;
    let Some(bridge) = app.try_state::<crate::hermes_bridge::HermesBridge>() else {
        return Vec::new();
    };
    let Ok(jobs) = crate::hermes_bridge::hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        "/api/cron/jobs?profile=default",
        None,
    )
    .await
    else {
        return Vec::new();
    };
    failed_jobs(&jobs, since)
}

#[cfg(mobile)]
async fn failed_routines(_app: &AppHandle, _since: &str) -> Vec<CardItem> {
    Vec::new()
}

/// The jobs in a cron listing whose last run failed since `since`. Pure.
pub fn failed_jobs(jobs: &serde_json::Value, since: &str) -> Vec<CardItem> {
    let since = chrono::DateTime::parse_from_rfc3339(since).ok();
    jobs.as_array()
        .or_else(|| jobs.get("jobs").and_then(serde_json::Value::as_array))
        .into_iter()
        .flatten()
        .filter(|job| job.get("last_status").and_then(serde_json::Value::as_str) == Some("error"))
        // An assignment's run job is reported through its run row, not as a
        // routine.
        .filter(|job| {
            !job.get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .starts_with(crate::assignments::ASSIGNMENT_JOB_TAG.trim_end())
        })
        .filter(|job| {
            let ran = job
                .get("last_run_at")
                .and_then(serde_json::Value::as_str)
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok());
            matches!((ran, since), (Some(ran), Some(since)) if ran >= since)
        })
        .map(|job| CardItem {
            run_id: None,
            assignment_id: None,
            title: job
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            detail: job
                .get("last_error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect(),
        })
        .collect()
}

/// What is new on each followed topic: one web search each, the freshest
/// links. A failed search says nothing rather than something wrong.
async fn topics(pool: &SqlitePool) -> Vec<CardTopic> {
    let followed = follow_list_rows(pool).await.unwrap_or_default();
    let mut out = Vec::new();
    for topic in followed.into_iter().take(MAX_TOPICS) {
        let body = serde_json::json!({
            "query": topic.topic,
            "limit": 5,
            "requestId": uuid::Uuid::new_v4().to_string(),
        });
        let links = match crate::june_api::forward_web_request("/v1/web/search", &body).await {
            Ok(response) if (200..300).contains(&response.status) => {
                fresh_links(&response.body, chrono::Utc::now())
            }
            _ => Vec::new(),
        };
        out.push(CardTopic {
            topic: topic.topic,
            links,
        });
    }
    out
}

/// The links of a search answer worth a morning: published in the last two
/// days when the answer says when, else the first ones. Pure.
pub fn fresh_links(body: &[u8], now: chrono::DateTime<chrono::Utc>) -> Vec<CardLink> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(results) = value
        .pointer("/data/results")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let dated: Vec<_> = results
        .iter()
        .filter(|result| {
            result
                .get("publishedAt")
                .and_then(serde_json::Value::as_str)
                .is_some()
        })
        .collect();
    let chosen: Vec<&serde_json::Value> = if dated.is_empty() {
        results.iter().collect()
    } else {
        dated
            .into_iter()
            .filter(|result| {
                result
                    .get("publishedAt")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                    .is_some_and(|at| now.signed_duration_since(at) <= chrono::Duration::days(2))
            })
            .collect()
    };
    chosen
        .into_iter()
        .filter_map(|result| {
            let url = result.get("url").and_then(serde_json::Value::as_str)?;
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return None;
            }
            Some(CardLink {
                title: result
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(url)
                    .chars()
                    .take(160)
                    .collect(),
                url: url.to_string(),
            })
        })
        .take(LINKS_PER_TOPIC)
        .collect()
}

async fn compose(app: &AppHandle, pool: &SqlitePool, now: &DateTime<Local>) -> DailyCard {
    let (reviews, failures) = reviews_and_failures(app, pool).await;
    DailyCard {
        day: day_of(now),
        created_at: chrono::Utc::now().to_rfc3339(),
        agenda: agenda(now),
        notes: yesterdays_notes(pool, now).await,
        reviews,
        failures,
        topics: topics(pool).await,
    }
}

async fn written_today(pool: &SqlitePool, day: &str) -> bool {
    query("SELECT 1 FROM daily_briefs WHERE day=?")
        .bind(day)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Daily briefs announced since `since`: the moments' cap counts them.
pub async fn delivered_since(pool: &SqlitePool, since: &str) -> i64 {
    query("SELECT count(*) AS n FROM daily_briefs WHERE status='delivered' AND created_at>=?")
        .bind(since)
        .fetch_one(pool)
        .await
        .map(|row| row.get::<i64, _>("n"))
        .unwrap_or(0)
}

/// Write the card once. The first writer wins, so a second tick that got
/// this far announces nothing.
async fn store_card(pool: &SqlitePool, card: &DailyCard, status: &str) -> bool {
    let body = serde_json::to_string(card).unwrap_or_else(|_| "{}".into());
    let stored =
        query("INSERT OR IGNORE INTO daily_briefs(day,card,status,created_at) VALUES(?,?,?,?)")
            .bind(&card.day)
            .bind(body)
            .bind(status)
            .bind(&card.created_at)
            .execute(pool)
            .await
            .is_ok_and(|done| done.rows_affected() == 1);
    // The card travels too, agenda line included, for the devices that read
    // no calendar (ADR-0107). A silent card has nothing to show anywhere.
    if stored && status != "silent" {
        super::daily_cards::record(pool, card, status).await;
    }
    stored
}

/// Writes today's card when it is owed, and announces it when there is
/// something to say, it is still morning enough, and the moments' cap has
/// room. Called by the sweep and the clock; idempotent.
pub async fn tick(app: &AppHandle) {
    let settings = settings();
    let now = Local::now();
    let Ok(pool) = pool(app).await else {
        return;
    };
    let day = day_of(&now);
    if !card_due(&settings, minute_of(&now), written_today(&pool, &day).await) {
        return;
    }
    if WRITING.swap(true, Ordering::SeqCst) {
        return;
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            WRITING.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    let card = compose(app, &pool, &now).await;
    if card.is_empty() {
        store_card(&pool, &card, "silent").await;
        return;
    }
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    let spoken =
        super::briefs_spoken_since(app, &since).await + delivered_since(&pool, &since).await;
    let announce = may_notify(&settings, minute_of(&now)) && spoken < super::MAX_BRIEFS_PER_DAY;
    if store_card(&pool, &card, if announce { "delivered" } else { "quiet" }).await && announce {
        let _ = app
            .notification()
            .builder()
            .title(crate::tr!("Your day"))
            .body(card.headline())
            .extra(crate::destinations::EXTRA_KEY, crate::destinations::today())
            .show();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayDto {
    pub settings: DailyBriefSettings,
    /// Today's card, when one was written.
    pub card: Option<DailyCard>,
    /// `delivered`, `quiet` or `silent` (nothing to say).
    pub status: Option<String>,
}

async fn today(pool: &SqlitePool) -> TodayDto {
    let row = query("SELECT card, status FROM daily_briefs WHERE day=?")
        .bind(day_of(&Local::now()))
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    TodayDto {
        settings: settings(),
        card: row
            .as_ref()
            .and_then(|row| serde_json::from_str(&row.get::<String, _>("card")).ok()),
        status: row.as_ref().map(|row| row.get("status")),
    }
}

// --- Follow list -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowedTopic {
    pub id: String,
    pub topic: String,
    pub created_at: String,
}

async fn follow_list_rows(pool: &SqlitePool) -> Result<Vec<FollowedTopic>, AppError> {
    let rows = query("SELECT id, topic, created_at FROM followed_topics ORDER BY created_at")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| FollowedTopic {
            id: row.get("id"),
            topic: row.get("topic"),
            created_at: row.get("created_at"),
        })
        .collect())
}

// --- Commands ------------------------------------------------------------------

#[tauri::command]
pub fn daily_brief_get_settings() -> DailyBriefSettings {
    settings()
}

#[tauri::command]
pub fn daily_brief_set_settings(
    request: DailyBriefSettings,
) -> Result<DailyBriefSettings, AppError> {
    let next = DailyBriefSettings {
        enabled: request.enabled,
        at_minute: request.at_minute.min(24 * 60 - 1),
    };
    if let Some(path) = CONFIG_PATH.get() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let body = serde_json::to_string_pretty(&next)
            .map_err(|error| AppError::new("daily_brief_failed", error.to_string()))?;
        std::fs::write(path, body)
            .map_err(|error| AppError::new("daily_brief_failed", error.to_string()))?;
    }
    replace(next);
    Ok(next)
}

#[tauri::command]
pub async fn daily_brief_today(app: AppHandle) -> Result<TodayDto, AppError> {
    Ok(today(&pool(&app).await?).await)
}

/// Write today's card now, before its time, without a notification: the
/// person is looking at it. Its time then has nothing left to announce.
#[tauri::command]
pub async fn daily_brief_prepare(app: AppHandle) -> Result<TodayDto, AppError> {
    let pool = pool(&app).await?;
    let now = Local::now();
    if !written_today(&pool, &day_of(&now)).await {
        let card = compose(&app, &pool, &now).await;
        store_card(
            &pool,
            &card,
            if card.is_empty() { "silent" } else { "quiet" },
        )
        .await;
    }
    Ok(today(&pool).await)
}

#[tauri::command]
pub async fn follow_list(app: AppHandle) -> Result<Vec<FollowedTopic>, AppError> {
    follow_list_rows(&pool(&app).await?).await
}

#[tauri::command]
pub async fn follow_add(app: AppHandle, topic: String) -> Result<Vec<FollowedTopic>, AppError> {
    let topic: String = topic.trim().chars().take(MAX_TOPIC_CHARS).collect();
    let pool = pool(&app).await?;
    if topic.is_empty() {
        return follow_list_rows(&pool).await;
    }
    let existing = follow_list_rows(&pool).await?;
    if existing.len() >= MAX_TOPICS {
        return Err(AppError::new(
            "follow_full",
            "You can follow five topics. Remove one to add another.",
        ));
    }
    if !existing
        .iter()
        .any(|row| row.topic.eq_ignore_ascii_case(&topic))
    {
        query("INSERT INTO followed_topics(id,topic,created_at) VALUES(?,?,?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&topic)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await?;
    }
    follow_list_rows(&pool).await
}

#[tauri::command]
pub async fn follow_remove(app: AppHandle, id: String) -> Result<Vec<FollowedTopic>, AppError> {
    let pool = pool(&app).await?;
    query("DELETE FROM followed_topics WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await?;
    follow_list_rows(&pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_brief_is_off_until_asked_for_and_waits_for_its_time() {
        let off = DailyBriefSettings::default();
        assert!(!off.enabled);
        assert!(!card_due(&off, 12 * 60, false));
        let on = DailyBriefSettings {
            enabled: true,
            at_minute: 7 * 60 + 30,
        };
        assert!(!card_due(&on, 7 * 60 + 29, false));
        assert!(card_due(&on, 7 * 60 + 30, false));
        assert!(!card_due(&on, 9 * 60, true), "one card a day");
        assert!(may_notify(&on, 9 * 60));
        assert!(
            !may_notify(&on, 15 * 60),
            "an afternoon card waits quietly in Today"
        );
    }

    #[test]
    fn a_morning_with_nothing_to_say_says_nothing() {
        let card = DailyCard {
            day: "2026-10-08".into(),
            topics: vec![CardTopic {
                topic: "Tarifs de l'électricité".into(),
                links: Vec::new(),
            }],
            ..Default::default()
        };
        assert!(
            card.is_empty(),
            "a followed topic with nothing new is silence"
        );
        let busy = DailyCard {
            agenda: Some(Agenda {
                count: 3,
                first_title: "Point produit".into(),
                first_at: "09:30".into(),
            }),
            reviews: vec![CardItem::default()],
            ..card
        };
        assert!(!busy.is_empty());
        assert_eq!(busy.headline(), "3 meetings, 1 result to review");
        let french = crate::i18n::with_locale(crate::i18n::Locale::Fr, || busy.headline());
        assert_eq!(french, "3 réunions, 1 résultat à relire");
    }

    #[test]
    fn follow_ups_are_read_from_the_heading_that_names_them() {
        let note = "# Décisions\n- On garde le tarif\n\n## Prochaines étapes\n- Envoyer le devis à Marie\n- [ ] Relancer Tom\n\n# Notes\n- autre chose";
        assert_eq!(
            follow_ups(note),
            ["Envoyer le devis à Marie", "Relancer Tom"]
        );
        let english = "**Action items**\n* **Ship** the beta\n";
        assert_eq!(follow_ups(english), ["Ship the beta"]);
        assert!(follow_ups("# Summary\n- nothing to do here").is_empty());
    }

    #[test]
    fn fresh_links_keep_the_last_two_days_and_only_web_addresses() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-08T07:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let body = serde_json::json!({ "data": { "results": [
            { "title": "Old", "url": "https://a.example/old", "publishedAt": "2026-09-01T00:00:00Z" },
            { "title": "New", "url": "https://a.example/new", "publishedAt": "2026-10-07T18:00:00Z" },
            { "title": "Bad", "url": "javascript:alert(1)", "publishedAt": "2026-10-08T00:00:00Z" }
        ]}});
        let links = fresh_links(body.to_string().as_bytes(), now);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://a.example/new");
        // Undated answers keep their first links.
        let undated = serde_json::json!({ "data": { "results": [
            { "title": "A", "url": "https://a.example/1" },
            { "title": "B", "url": "https://a.example/2" },
            { "title": "C", "url": "https://a.example/3" }
        ]}});
        assert_eq!(fresh_links(undated.to_string().as_bytes(), now).len(), 2);
    }

    #[test]
    fn failed_routines_are_the_errors_of_the_last_day() {
        let jobs = serde_json::json!([
            { "name": "Veille", "last_status": "error", "last_error": "timeout", "last_run_at": "2026-10-08T06:00:00+00:00" },
            { "name": "Old", "last_status": "error", "last_run_at": "2026-10-01T06:00:00+00:00" },
            { "name": "Fine", "last_status": "ok", "last_run_at": "2026-10-08T06:00:00+00:00" },
            { "name": "[assignment] Veille énergie", "last_status": "error", "last_run_at": "2026-10-08T06:00:00+00:00" }
        ]);
        let failed = failed_jobs(&jobs, "2026-10-07T07:00:00+00:00");
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].title, "Veille");
        assert_eq!(failed[0].detail, "timeout");
    }

    #[tokio::test]
    async fn a_card_is_written_once_a_day_and_counted_against_the_cap() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        let card = DailyCard {
            day: "2026-10-08".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            reviews: vec![CardItem::default()],
            ..Default::default()
        };
        assert!(store_card(&pool, &card, "delivered").await);
        assert!(
            !store_card(&pool, &card, "delivered").await,
            "a second writer announces nothing"
        );
        assert!(written_today(&pool, "2026-10-08").await);
        let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
        assert_eq!(delivered_since(&pool, &since).await, 1);
    }
}
