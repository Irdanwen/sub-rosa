//! Recordings leave after their note is transcribed (ADR-0112). The choice is
//! one row of `account_preferences`, which travels like any synchronised
//! object, so every device applies the same rule: it deletes its own copy of
//! the file and takes the account's copy out, and the note keeps its
//! transcript and its text. Without an account the rule is this device's.
//!
//! The rule is the existing purge of Settings › Storage, made automatic: an
//! artifact older than the chosen age, on a note that reached `ready`, with
//! a transcript of its own.
use crate::diagnostics::PurgeRecordingsResult;
use crate::domain::types::AppError;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use std::sync::atomic::{AtomicI64, Ordering};
use tauri::AppHandle;

/// The one row of account choices; every device writes and reads this id.
pub const PREFERENCES_ID: &str = "00000000-0000-4000-8000-0000000000a1";
/// Ages a person may choose, in days.
pub const CHOICES: [u32; 5] = [7, 30, 90, 180, 365];
/// How often the automatic rule runs while the app stays open.
const EVERY_SECONDS: i64 = 3600;
static LAST_RUN: AtomicI64 = AtomicI64::new(0);

/// The chosen age, or `None` to keep recordings.
pub async fn retention_days(pool: &SqlitePool) -> Result<Option<u32>, AppError> {
    Ok(
        query("SELECT audio_retention_days FROM account_preferences WHERE id=?")
            .bind(PREFERENCES_ID)
            .fetch_optional(pool)
            .await?
            .and_then(|r| r.get::<Option<i64>, _>("audio_retention_days"))
            .and_then(|d| u32::try_from(d).ok()),
    )
}

/// Deletes the recordings older than `days` whose note is done with them,
/// here and in the account. `dry_run` only says what would go.
pub async fn purge(
    app: &AppHandle,
    days: u32,
    dry_run: bool,
) -> Result<PurgeRecordingsResult, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let paths = crate::commands::app_paths(app)?;
    purge_in(&repos, &paths, days, dry_run).await
}

/// `purge`, given the library and its folders.
pub(crate) async fn purge_in(
    repos: &crate::db::repositories::Repositories,
    paths: &crate::app_paths::AppPaths,
    days: u32,
    dry_run: bool,
) -> Result<PurgeRecordingsResult, AppError> {
    let days = days.max(1);
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(i64::from(days))).to_rfc3339();
    let candidates = repos.purgeable_recordings(&cutoff).await?;
    let mut removed = 0u64;
    let mut bytes = 0u64;
    for candidate in candidates {
        let size = candidate.size_bytes.max(0) as u64;
        if dry_run {
            removed += 1;
            bytes = bytes.saturating_add(size);
            continue;
        }
        // A device that never fetched the file has nothing here to delete,
        // and still takes the account's copy out.
        let local = if candidate.path.is_empty() {
            Ok(())
        } else {
            match paths.remove_recording_file(&candidate.path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            }
        };
        match local {
            Ok(()) => {
                crate::account::forget_recording(&repos.pool, &candidate.artifact_id).await?;
                repos
                    .mark_audio_artifact_purged(&candidate.artifact_id)
                    .await?;
                removed += 1;
                if !candidate.path.is_empty() {
                    bytes = bytes.saturating_add(size);
                }
            }
            Err(error) => {
                tracing::warn!(artifact = %candidate.artifact_id, error = %error, "could not remove a recording");
            }
        }
    }
    if removed > 0 && !dry_run {
        crate::account::poke();
    }
    Ok(PurgeRecordingsResult {
        recordings: removed,
        bytes,
        dry_run,
    })
}

/// Applies the chosen rule, at most once an hour. Best effort: a failure is
/// logged and tried again on the next run.
pub async fn tick(app: &AppHandle) {
    let now = chrono::Utc::now().timestamp();
    if now - LAST_RUN.load(Ordering::Relaxed) < EVERY_SECONDS {
        return;
    }
    LAST_RUN.store(now, Ordering::Relaxed);
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    match retention_days(&repos.pool).await {
        Ok(Some(days)) => {
            if let Err(error) = purge(app, days, false).await {
                tracing::warn!(code = %error.code, "recording retention deferred");
            }
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(code = %error.code, "recording retention unreadable"),
    }
}

/// The chosen age, for Settings › Storage.
#[tauri::command]
pub async fn recordings_retention(app: AppHandle) -> Result<Option<u32>, AppError> {
    retention_days(&crate::commands::repositories(&app).await?.pool).await
}

/// Chooses how long recordings stay after transcription (`None` keeps them),
/// for every device on the account, and applies it at once here.
#[tauri::command]
pub async fn set_recordings_retention(
    app: AppHandle,
    days: Option<u32>,
) -> Result<PurgeRecordingsResult, AppError> {
    if days.is_some_and(|d| !CHOICES.contains(&d)) {
        return Err(AppError::new(
            "retention_invalid",
            "Choose one of the offered durations.",
        ));
    }
    let pool = crate::commands::repositories(&app).await?.pool.clone();
    query("INSERT INTO account_preferences(id,audio_retention_days,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET audio_retention_days=excluded.audio_retention_days,updated_at=excluded.updated_at")
        .bind(PREFERENCES_ID)
        .bind(days.map(i64::from))
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&pool)
        .await?;
    crate::account::poke();
    match days {
        Some(days) => purge(&app, days, false).await,
        None => Ok(PurgeRecordingsResult {
            recordings: 0,
            bytes: 0,
            dry_run: false,
        }),
    }
}
