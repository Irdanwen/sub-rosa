//! Asking another of your devices to fetch a link.
//!
//! The phone cannot read a streaming platform page: `ingest/extractor.rs` is
//! `#![cfg(desktop)]` and iOS cannot run a binary its owner installed
//! somewhere else (ADR-0028). The tempting fix is to put the extractor on the
//! account service, and it is the wrong one twice over — it relocates a refusal
//! instead of lifting it, and it hands the service the one thing it has never
//! had, a link in the clear.
//!
//! So the extractor does not move. The **work** does. The phone writes an
//! ordinary encrypted revision saying "fetch this, on that device"; the device
//! it names sees it on its next sweep and runs the import it was always able
//! to run, with the `yt-dlp` its owner installed and the key its owner
//! configured. The note comes back through synchronisation like any other. The
//! service carries a sealed envelope and learns nothing.
//!
//! This is the single deliberate exception to ADR-0049's rule that incoming
//! state is history rather than an instruction, and [ADR-0054](../../../docs/adr/0054-an-errand-runs-on-the-device-that-has-the-means.md)
//! is where it is argued. Five things keep the exception narrow:
//!
//! 1. **Addressed.** An errand names one device. Nothing races, and the
//!    waiting message can say which machine it is waiting for.
//! 2. **Authenticated.** It arrives inside the vault's AEAD, so it came from a
//!    device holding the vault key. A service that forged one would fail to
//!    decrypt.
//! 3. **Consented on the machine that pays.** Errands are off until the owner
//!    of that machine switches them on, because an import spends credits and
//!    the switch is a statement about what they want their computer doing when
//!    they are not in front of it.
//! 4. **Single use.** `account_errand_runs` is written before any work starts
//!    and is never synchronised, so a row that comes back as `requested` after
//!    a conflict or a restore cannot buy the same transcription twice.
//! 5. **Perishable.** An errand nobody picked up inside [`EXPIRY_DAYS`] is
//!    declined rather than run late.
use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

/// Emitted whenever an errand changes, so both ends follow it without polling.
pub const ERRAND_EVENT: &str = "june://errand";

/// How long an errand may wait for its device. Long enough for a laptop that
/// spends the weekend shut, short enough that a link you forgot about does not
/// start downloading a month later.
pub const EXPIRY_DAYS: i64 = 7;

static ACTIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn active() -> MutexGuard<'static, HashSet<String>> {
    ACTIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// One errand runs once per process. The durable ledger stops it running again
/// after a restart; this stops two sweeps overlapping before either has
/// written anything.
struct RunClaim(String);

impl RunClaim {
    fn take(id: &str) -> Option<Self> {
        active()
            .insert(id.to_string())
            .then(|| Self(id.to_string()))
    }
}

impl Drop for RunClaim {
    fn drop(&mut self) {
        active().remove(&self.0);
    }
}

/// Whether this machine accepts work queued from your other devices.
///
/// Off until said otherwise, for the same reason the extractor rail is: an
/// import spends credits and occupies the machine, and switching it on is a
/// statement about what you want your computer doing while you are elsewhere.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ErrandSettings {
    pub enabled: bool,
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager as _;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("errands.json"))
}

pub fn settings(app: &AppHandle) -> ErrandSettings {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, value: &ErrandSettings) -> Result<(), AppError> {
    let path = settings_path(app)
        .ok_or_else(|| AppError::new("errand_failed", "No config directory to write to."))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("errand_failed", error.to_string()))?;
    }
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| AppError::new("errand_failed", error.to_string()))?;
    std::fs::write(&path, body).map_err(|error| AppError::new("errand_failed", error.to_string()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrandDto {
    pub id: String,
    pub device_id: String,
    pub url: String,
    pub folder_id: Option<String>,
    pub requested_by: String,
    pub requested_at: String,
    /// `requested`, `done` or `declined`. `expired` is derived from the clock
    /// rather than stored, so a row cannot claim to be fresh forever.
    pub state: String,
    pub note_id: Option<String>,
    pub message: Option<String>,
    pub updated_at: String,
}

fn row_to_dto(row: &sqlx_sqlite::SqliteRow) -> ErrandDto {
    let state: String = row.get("state");
    let requested_at: String = row.get("requested_at");
    ErrandDto {
        state: if state == "requested" && is_expired(&requested_at) {
            "expired".into()
        } else {
            state
        },
        id: row.get("id"),
        device_id: row.get("device_id"),
        url: row.get("url"),
        folder_id: row.get("folder_id"),
        requested_by: row.get("requested_by"),
        requested_at,
        note_id: row.get("note_id"),
        message: row.get("message"),
        updated_at: row.get("updated_at"),
    }
}

fn is_expired(requested_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(requested_at).is_ok_and(|at| {
        chrono::Utc::now().signed_duration_since(at.with_timezone(&chrono::Utc))
            > chrono::Duration::days(EXPIRY_DAYS)
    })
}

fn error(code: &str) -> AppError {
    AppError::new(
        code,
        match code {
            "errand_no_account" => {
                "Connect your account on both devices before sending a link to one of them."
            }
            "errand_unknown_device" => "That device is not connected to your account any more.",
            "errand_same_device" => "This is the device you are on.",
            _ => "That link could not be sent to your other device.",
        },
    )
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool.clone())
}

async fn this_device(pool: &SqlitePool) -> Result<String, AppError> {
    query("SELECT device_id FROM account_sync_control WHERE id=1")
        .fetch_optional(pool)
        .await?
        .and_then(|row| row.get::<Option<String>, _>("device_id"))
        .ok_or_else(|| error("errand_no_account"))
}

async fn emit_all(app: &AppHandle) {
    if let Ok(list) = list(app).await {
        let _ = app.emit(ERRAND_EVENT, list);
    }
}

/// Queue a link for another of your devices.
///
/// The link is resolved here so an unusable one is refused while the person is
/// still looking at it, rather than three days later on a machine they are not
/// sitting in front of. Everything else this device deliberately does not
/// decide: whether the target can read the link is the target's answer.
pub async fn request(
    app: &AppHandle,
    url: &str,
    device_id: &str,
    folder_id: Option<String>,
) -> Result<ErrandDto, AppError> {
    let resolved = crate::ingest::link::resolve_link(url)?;
    let pool = pool(app).await?;
    let mine = this_device(&pool).await?;
    if mine == device_id {
        return Err(error("errand_same_device"));
    }
    let devices = crate::account::account_devices(app.clone()).await?;
    let devices = devices.as_array().cloned().unwrap_or_default();
    let named = |id: &str| {
        devices
            .iter()
            .find(|device| device.get("id").and_then(serde_json::Value::as_str) == Some(id))
    };
    // A revoked device is not going to answer, and a link that waits seven
    // days for a machine that cannot sign in is worse than a refusal now.
    if !named(device_id).is_some_and(|device| {
        device
            .get("revoked_at")
            .map_or(true, serde_json::Value::is_null)
    }) {
        return Err(error("errand_unknown_device"));
    }
    let requested_by = named(&mine)
        .and_then(|device| device.get("name").and_then(serde_json::Value::as_str))
        .unwrap_or_default()
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO account_errands(id,device_id,url,folder_id,requested_by,requested_at,state,updated_at) VALUES(?,?,?,?,?,?,'requested',?)")
        .bind(&id)
        .bind(device_id)
        .bind(&resolved.url)
        .bind(&folder_id)
        .bind(&requested_by)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await?;
    // Leave now rather than at the next sweep: the point of the feature is
    // that the other machine starts while you are still holding the phone.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::account::sync::run(&handle).await;
        emit_all(&handle).await;
    });
    let row = query("SELECT * FROM account_errands WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await?;
    Ok(row_to_dto(&row))
}

/// Every errand this library knows about, newest first. Both ends read the
/// same rows: one sees what it asked for, the other what it was asked.
pub async fn list(app: &AppHandle) -> Result<Vec<ErrandDto>, AppError> {
    let rows = query("SELECT * FROM account_errands ORDER BY requested_at DESC LIMIT 100")
        .fetch_all(&pool(app).await?)
        .await?;
    Ok(rows.iter().map(row_to_dto).collect())
}

/// Withdraw an errand. Deleting the row is the cancel: the tombstone travels
/// and the other device stops seeing anything to do.
pub async fn cancel(app: &AppHandle, id: &str) -> Result<(), AppError> {
    let pool = pool(app).await?;
    query("DELETE FROM account_errands WHERE id=?")
        .bind(id)
        .execute(&pool)
        .await?;
    emit_all(app).await;
    Ok(())
}

async fn settle(
    app: &AppHandle,
    pool: &SqlitePool,
    id: &str,
    state: &str,
    note_id: Option<&str>,
    message: Option<&str>,
) -> Result<(), AppError> {
    query("UPDATE account_errands SET state=?,note_id=?,message=?,updated_at=? WHERE id=?")
        .bind(state)
        .bind(note_id)
        .bind(message)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await?;
    emit_all(app).await;
    Ok(())
}

/// Pick up the errands addressed to this device, and finish the ones already
/// under way. Called by [`crate::background::sweep`], so it survives the app
/// being killed between the ask and the answer.
pub async fn run_pending(app: &AppHandle) {
    let Ok(pool) = pool(app).await else {
        return;
    };
    let Ok(mine) = this_device(&pool).await else {
        return;
    };
    if let Err(error) = reconcile(app, &pool).await {
        tracing::warn!(code = %error.code, "errand reconciliation failed");
    }
    let Ok(rows) = query("SELECT * FROM account_errands WHERE device_id=? AND state='requested' AND id NOT IN (SELECT errand_id FROM account_errand_runs) ORDER BY requested_at LIMIT 5")
        .bind(&mine)
        .fetch_all(&pool)
        .await
    else {
        return;
    };
    let accepting = settings(app).enabled;
    for row in rows {
        let errand = row_to_dto(&row);
        let Some(_claim) = RunClaim::take(&errand.id) else {
            continue;
        };
        if errand.state == "expired" {
            let _ = settle(
                app,
                &pool,
                &errand.id,
                "declined",
                None,
                Some("This errand waited too long and was not run."),
            )
            .await;
            continue;
        }
        if !accepting {
            let _ = settle(
                app,
                &pool,
                &errand.id,
                "declined",
                None,
                Some(
                    "This device is not accepting links from your other devices. Turn on \"Run links sent from your other devices\" in Settings, Import.",
                ),
            )
            .await;
            continue;
        }
        // Durable before paid: if this device dies between here and the
        // import, the errand is never retried by this machine.
        if query("INSERT OR IGNORE INTO account_errand_runs(errand_id,started_at) VALUES(?,?)")
            .bind(&errand.id)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await
            .map(|done| done.rows_affected())
            .unwrap_or(0)
            == 0
        {
            continue;
        }
        match crate::ingest::start_link_ingest(
            app.clone(),
            errand.url.clone(),
            errand.folder_id.clone(),
        )
        .await
        {
            Ok(ingest) => {
                let _ = query("UPDATE account_errand_runs SET ingest_id=? WHERE errand_id=?")
                    .bind(&ingest.id)
                    .bind(&errand.id)
                    .execute(&pool)
                    .await;
            }
            // The refusal the import rail already writes is the honest answer,
            // and it says what would change it.
            Err(refusal) => {
                let _ = settle(
                    app,
                    &pool,
                    &errand.id,
                    "declined",
                    None,
                    Some(&refusal.message),
                )
                .await;
            }
        }
    }
}

/// Close errands whose import has landed one way or the other.
async fn reconcile(app: &AppHandle, pool: &SqlitePool) -> Result<(), AppError> {
    let rows = query("SELECT r.errand_id, r.ingest_id, i.status, i.note_id, i.title FROM account_errand_runs r JOIN account_errands e ON e.id=r.errand_id LEFT JOIN ingests i ON i.id=r.ingest_id WHERE e.state='requested' AND r.ingest_id IS NOT NULL")
        .fetch_all(pool)
        .await?;
    for row in rows {
        let id: String = row.get("errand_id");
        match row.get::<Option<String>, _>("status").as_deref() {
            Some("done") => {
                settle(
                    app,
                    pool,
                    &id,
                    "done",
                    row.get::<Option<String>, _>("note_id").as_deref(),
                    None,
                )
                .await?;
            }
            Some("failed") => {
                settle(
                    app,
                    pool,
                    &id,
                    "declined",
                    None,
                    Some("The import did not finish on that device."),
                )
                .await?;
            }
            // Still running, or the row was discarded by hand on that machine.
            Some(_) => {}
            None => {
                settle(
                    app,
                    pool,
                    &id,
                    "declined",
                    None,
                    Some("The import was cancelled on that device."),
                )
                .await?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn errand_request(
    app: AppHandle,
    url: String,
    device_id: String,
    folder_id: Option<String>,
) -> Result<ErrandDto, AppError> {
    request(&app, &url, &device_id, folder_id).await
}

#[tauri::command]
pub async fn errand_list(app: AppHandle) -> Result<Vec<ErrandDto>, AppError> {
    list(&app).await
}

#[tauri::command]
pub async fn errand_cancel(app: AppHandle, id: String) -> Result<(), AppError> {
    cancel(&app, &id).await
}

#[tauri::command]
pub async fn errand_settings(app: AppHandle) -> Result<ErrandSettings, AppError> {
    Ok(settings(&app))
}

#[tauri::command]
pub async fn errand_set_enabled(app: AppHandle, enabled: bool) -> Result<ErrandSettings, AppError> {
    let value = ErrandSettings { enabled };
    save_settings(&app, &value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        for statement in include_str!("../../migrations/025_errands.sql").split(';') {
            if !statement.trim().is_empty() {
                query(statement).execute(&pool).await.unwrap();
            }
        }
        pool
    }

    /// The guarantee the whole design rests on: an errand buys one
    /// transcription, not one per sweep.
    ///
    /// The synchronised row cannot carry this. It can legitimately come back
    /// as `requested` — an old revision arriving late, a conflict resolved the
    /// other way, a library restored from an archive — and each of those would
    /// otherwise spend money again on a machine nobody is sitting at. So the
    /// claim is a local row, written before any work starts, and the second
    /// writer is told no by the primary key rather than by a check it could
    /// race with.
    #[tokio::test]
    async fn a_second_sweep_cannot_buy_the_same_import_again() {
        let pool = store().await;
        let id = uuid::Uuid::new_v4().to_string();
        let claim = || async {
            query("INSERT OR IGNORE INTO account_errand_runs(errand_id,started_at) VALUES(?,?)")
                .bind(&id)
                .bind(chrono::Utc::now().to_rfc3339())
                .execute(&pool)
                .await
                .unwrap()
                .rows_affected()
        };
        assert_eq!(claim().await, 1, "the first sweep runs it");
        assert_eq!(claim().await, 0, "every later sweep is refused");
        // And the refusal survives the row being put back to `requested`,
        // which is exactly the case a synchronised flag would miss.
        query("INSERT INTO account_errands(id,device_id,url,requested_at,state,updated_at) VALUES(?,'d','https://example.com/a.mp3','now','requested','now')")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        let pending: i64 = sqlx::query_scalar::query_scalar("SELECT count(*) FROM account_errands WHERE state='requested' AND id NOT IN (SELECT errand_id FROM account_errand_runs)")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            pending, 0,
            "a row that came back as requested is still spent"
        );
    }

    /// A stored state never says "expired": the clock does. A row that could
    /// keep claiming to be fresh would be run whenever a machine came back.
    #[test]
    fn an_errand_perishes_on_the_clock_not_in_the_row() {
        let fresh = chrono::Utc::now().to_rfc3339();
        let stale = (chrono::Utc::now() - chrono::Duration::days(EXPIRY_DAYS + 1)).to_rfc3339();
        assert!(!is_expired(&fresh));
        assert!(is_expired(&stale));
        assert!(!is_expired("not a date"));
    }
}
