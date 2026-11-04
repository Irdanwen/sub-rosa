//! Which home owns each conversation (ADR-0140).
//!
//! A conversation lives in the home of the mode it runs in, and the app
//! reads and writes it there and nowhere else: never "the sandboxed home
//! first, the shared one if it has nothing", which would let the jail
//! shadow a conversation of the unrestricted side by writing one under the
//! same identifier. The owner of a conversation is, in order:
//!
//! 1. the shared home for a routine's run (`cron_*`), whatever is recorded;
//! 2. the home the app recorded when the conversation was created or
//!    resumed (`hermes-session-homes.json` beside both homes, written by
//!    the app alone);
//! 3. otherwise the shared home when its database has the conversation (a
//!    conversation from before the split, a gateway conversation): that
//!    database is written by processes outside the jail only;
//! 4. otherwise the sandboxed home.
//!
//! A conversation present in both homes (copied at the split) is read from
//! its owner only. The other copy is never shown, mirrored or merged.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::types::AppError;

use super::home_split::{shared_home, SANDBOXED_HOME, SHARED_HOME};

/// The record, beside both homes in the app's data folder.
const RECORD_FILE: &str = "hermes-session-homes.json";

/// Serializes the record's read-modify-write within the app.
static RECORD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Owner {
    Sandboxed,
    Shared,
}

impl Owner {
    pub(crate) fn of_mode(full_mode: bool) -> Owner {
        if full_mode {
            Owner::Shared
        } else {
            Owner::Sandboxed
        }
    }

    /// The owner's home, from either home or the data folder's child.
    pub(crate) fn home(self, any_home: &Path) -> PathBuf {
        match self {
            Owner::Shared => shared_home(any_home),
            Owner::Sandboxed => super::home_split::sandboxed_home(any_home),
        }
    }

    /// The home's folder name.
    pub(crate) fn dir_name(self) -> &'static str {
        match self {
            Owner::Shared => SHARED_HOME,
            Owner::Sandboxed => SANDBOXED_HOME,
        }
    }
}

fn record_path(any_home: &Path) -> PathBuf {
    any_home.parent().unwrap_or(any_home).join(RECORD_FILE)
}

/// The recorded owners. A missing or unreadable record is empty: every
/// conversation then falls to the rules after it.
pub(crate) fn recorded(any_home: &Path) -> BTreeMap<String, Owner> {
    std::fs::read(record_path(any_home))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Records the home a conversation was created or resumed in. A routine's
/// run is never recorded as the jail's.
pub(crate) fn record(any_home: &Path, session_id: &str, owner: Owner) -> Result<(), AppError> {
    let session_id = valid_session_id(session_id)?;
    if is_routine_run(session_id) && owner == Owner::Sandboxed {
        return Ok(());
    }
    let _guard = RECORD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut owners = recorded(any_home);
    if owners.get(session_id) == Some(&owner) {
        return Ok(());
    }
    owners.insert(session_id.to_string(), owner);
    let path = record_path(any_home);
    let text = serde_json::to_vec_pretty(&owners)
        .map_err(|error| AppError::new("hermes_session_home_failed", error.to_string()))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)
        .and_then(|()| std::fs::rename(&temp, &path))
        .map_err(|error| AppError::new("hermes_session_home_failed", error.to_string()))
}

/// The record of each task's home, by the mode it was created in, beside
/// the conversations' record; written by the app alone.
const TASK_RECORD_FILE: &str = "hermes-task-homes.json";

fn task_record_path(any_home: &Path) -> PathBuf {
    any_home.parent().unwrap_or(any_home).join(TASK_RECORD_FILE)
}

/// The home of the mode a task was created in, when the app knows it.
pub(crate) fn task_home(any_home: &Path, task_id: &str) -> Option<Owner> {
    std::fs::read(task_record_path(any_home))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, Owner>>(&bytes).ok())
        .and_then(|homes| homes.get(task_id).copied())
}

/// Records the home of the mode a task is created in.
pub(crate) fn record_task_home(
    any_home: &Path,
    task_id: &str,
    owner: Owner,
) -> Result<(), AppError> {
    let _guard = RECORD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = task_record_path(any_home);
    let mut homes: BTreeMap<String, Owner> = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    homes.insert(task_id.to_string(), owner);
    let text = serde_json::to_vec_pretty(&homes)
        .map_err(|error| AppError::new("hermes_session_home_failed", error.to_string()))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)
        .and_then(|()| std::fs::rename(&temp, &path))
        .map_err(|error| AppError::new("hermes_session_home_failed", error.to_string()))
}

/// Records, when the caller knows it, the mode a task was created in.
pub(crate) fn remember_task_home(
    app: &tauri::AppHandle,
    task_id: &str,
    unrestricted: Option<bool>,
) {
    let (Some(unrestricted), Ok(home)) = (unrestricted, super::resolve_june_hermes_home(app))
    else {
        return;
    };
    if let Err(error) = record_task_home(&home, task_id, Owner::of_mode(unrestricted)) {
        eprintln!("hermes: could not record task {task_id}'s home: {error:?}");
    }
}

/// The homes a task whose conversation is not bound yet may be matched in
/// by its title (ADR-0140): the home of the mode it was created in, and
/// only that one. A task whose mode the app does not know (made before this
/// record, or by a caller that did not say) is matched in the shared home
/// only, which only processes outside the jail write: never in the jail's,
/// where a conversation could have been forged to match it.
pub(crate) fn homes_for_unbound_task(any_home: &Path, task_id: &str) -> Vec<Owner> {
    match task_home(any_home, task_id) {
        Some(owner) => vec![owner],
        None => vec![Owner::Shared],
    }
}

/// A session identifier as the record keeps it: the exact text, checked
/// once (review 4): not empty, no surrounding space, no control character,
/// at most 256 bytes. One that would need trimming is refused, so the
/// value checked against the snapshot and the shared database is the one
/// recorded.
pub(crate) fn valid_session_id(session_id: &str) -> Result<&str, AppError> {
    if session_id.is_empty()
        || session_id.trim() != session_id
        || session_id.len() > 256
        || session_id.chars().any(char::is_control)
    {
        return Err(AppError::new(
            "hermes_session_id_required",
            "Hermes session ID is required.",
        ));
    }
    Ok(session_id)
}

/// A routine's run: always the shared home's, where the gateway runs it.
pub(crate) fn is_routine_run(session_id: &str) -> bool {
    session_id.starts_with("cron_")
}

/// The owner of each identifier, by the rules above. `in_shared` is the set
/// of those the shared database has.
pub(crate) fn owners_of<'a>(
    any_home: &Path,
    ids: impl IntoIterator<Item = &'a str>,
    in_shared: &HashSet<String>,
) -> BTreeMap<String, Owner> {
    let record = recorded(any_home);
    ids.into_iter()
        .map(|id| {
            (
                id.to_string(),
                decide(id, record.get(id).copied(), in_shared.contains(id)),
            )
        })
        .collect()
}

fn decide(id: &str, recorded: Option<Owner>, in_shared: bool) -> Owner {
    if is_routine_run(id) {
        return Owner::Shared;
    }
    if let Some(owner) = recorded {
        return owner;
    }
    if in_shared {
        Owner::Shared
    } else {
        Owner::Sandboxed
    }
}

/// The owner of one conversation.
pub(crate) async fn owner_of(any_home: &Path, session_id: &str) -> Owner {
    let in_shared = in_shared_home(any_home, &[session_id]).await;
    owners_of(any_home, [session_id], &in_shared)
        .remove(session_id)
        .unwrap_or(Owner::Shared)
}

/// Which of `ids` the shared home's database has. It fails closed: a
/// database that exists but cannot be read answers that it has them all,
/// so the shared home stays their owner (ADR-0140, review 2).
pub(crate) async fn in_shared_home(any_home: &Path, ids: &[&str]) -> HashSet<String> {
    let all = || {
        ids.iter()
            .map(|id| (*id).to_string())
            .collect::<HashSet<_>>()
    };
    let path = shared_home(any_home).join("state.db");
    if ids.is_empty() || path.symlink_metadata().is_err() {
        return HashSet::new();
    }
    let Ok(mut connection) = open_hardened(&path).await else {
        return all();
    };
    let mut found = HashSet::new();
    for id in ids {
        let present: Result<Option<(i64,)>, _> =
            sqlx::query_as::query_as("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
                .bind(*id)
                .fetch_optional(&mut connection)
                .await;
        match present {
            Ok(Some(_)) => {
                found.insert((*id).to_string());
            }
            Ok(None) => {}
            Err(_) => return all(),
        }
    }
    let _ = sqlx::connection::Connection::close(connection).await;
    found
}

/// The conversations copied from the shared home at the split, beside both
/// homes, written by the app alone.
const SPLIT_SNAPSHOT_FILE: &str = "hermes-split-sessions.json";

/// Keeps the identifiers of the conversations copied at the split.
pub(crate) fn save_split_snapshot(any_home: &Path, ids: &[String]) -> std::io::Result<()> {
    let path = record_path(any_home).with_file_name(SPLIT_SNAPSHOT_FILE);
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(ids).unwrap_or_default())?;
    std::fs::rename(&temp, &path)
}

fn split_snapshot(any_home: &Path) -> HashSet<String> {
    std::fs::read(record_path(any_home).with_file_name(SPLIT_SNAPSHOT_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Records where a conversation was created or resumed, as the app is told
/// by the webview. A conversation the shared home's database has goes to
/// the sandboxed home only when it was copied there at the split: a resume
/// that worked on the sandboxed runtime proves nothing for one the jail
/// could have written under the same identifier (ADR-0140, review 1).
pub(crate) async fn record_checked(
    any_home: &Path,
    session_id: &str,
    owner: Owner,
) -> Result<Owner, AppError> {
    let session_id = valid_session_id(session_id)?;
    let owner = if owner == Owner::Sandboxed
        && !split_snapshot(any_home).contains(session_id)
        && !in_shared_home(any_home, &[session_id]).await.is_empty()
    {
        Owner::Shared
    } else {
        owner
    };
    record(any_home, session_id, owner)?;
    Ok(owner)
}

/// How the app opens a runtime's database in its own process (ADR-0140):
/// read only, its schema distrusted (no function with a side effect runs
/// from a view or a trigger), every page checked before use, and no
/// extension (sqlx never enables loading one). The sandboxed home's
/// database is written by the jail.
pub(crate) fn hardened_read_options(path: &Path) -> sqlx_sqlite::SqliteConnectOptions {
    sqlx_sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .pragma("trusted_schema", "OFF")
        .pragma("cell_size_check", "ON")
        .pragma("query_only", "ON")
}

/// Turns SQLite's defensive mode on for `connection` (ADR-0140, D5): no
/// write to the schema or to a shadow table, whatever the file holds.
pub(crate) async fn harden(
    connection: &mut sqlx_sqlite::SqliteConnection,
) -> Result<(), sqlx::Error> {
    let mut handle = connection.lock_handle().await?;
    let raw = handle.as_raw_handle().as_ptr();
    // SAFETY: a live handle, locked for the call; the option takes an int
    // and an optional out pointer.
    let code = unsafe {
        libsqlite3_sys::sqlite3_db_config(
            raw,
            libsqlite3_sys::SQLITE_DBCONFIG_DEFENSIVE,
            1 as std::ffi::c_int,
            std::ptr::null_mut::<std::ffi::c_int>(),
        )
    };
    if code == libsqlite3_sys::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!(
            "defensive mode refused ({code})"
        )))
    }
}

/// A connection to a runtime's database as the app opens one in its own
/// process: [`hardened_read_options`] and defensive mode.
pub(crate) async fn open_hardened(
    path: &Path,
) -> Result<sqlx_sqlite::SqliteConnection, sqlx::Error> {
    let mut connection =
        <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(
            &hardened_read_options(path),
        )
        .await?;
    harden(&mut connection).await?;
    Ok(connection)
}

/// A pool on a runtime's database, each connection hardened.
pub(crate) async fn hardened_pool(
    path: &Path,
    max_connections: u32,
) -> Result<sqlx_sqlite::SqlitePool, sqlx::Error> {
    sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(max_connections)
        .after_connect(|connection, _| Box::pin(async move { harden(connection).await }))
        .connect_with(hardened_read_options(path))
        .await
}

/// Records the home a conversation was created or resumed in, from the
/// mode of the runtime that did it (ADR-0140).
#[tauri::command]
pub async fn hermes_record_session_home(
    app: tauri::AppHandle,
    request: RecordSessionHomeRequest,
) -> Result<(), AppError> {
    let home = super::resolve_june_hermes_home(&app)?;
    record_checked(
        &home,
        &request.session_id,
        Owner::of_mode(request.unrestricted),
    )
    .await
    .map(|_| ())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSessionHomeRequest {
    pub session_id: String,
    pub unrestricted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_routine_run_is_always_the_shared_homes() {
        assert_eq!(
            decide("cron_abc_1", Some(Owner::Sandboxed), false),
            Owner::Shared
        );
        assert_eq!(decide("cron_abc_1", None, false), Owner::Shared);
    }

    #[test]
    fn the_record_decides_then_the_shared_database_then_the_jail() {
        assert_eq!(decide("a", Some(Owner::Sandboxed), true), Owner::Sandboxed);
        assert_eq!(decide("a", Some(Owner::Shared), false), Owner::Shared);
        assert_eq!(decide("a", None, true), Owner::Shared);
        assert_eq!(decide("a", None, false), Owner::Sandboxed);
    }

    #[test]
    fn the_record_is_written_by_the_app_and_never_takes_a_routine() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join(SHARED_HOME);
        record(&home, "s1", Owner::Sandboxed).unwrap();
        record(&home, "s2", Owner::Shared).unwrap();
        record(&home, "cron_x_1", Owner::Sandboxed).unwrap();
        let owners = recorded(&home);
        assert_eq!(owners.get("s1"), Some(&Owner::Sandboxed));
        assert_eq!(owners.get("s2"), Some(&Owner::Shared));
        assert_eq!(owners.get("cron_x_1"), None);
        assert!(dir.path().join(RECORD_FILE).is_file());
    }

    async fn shared_db_with(shared: &Path, ids: &[&str]) {
        std::fs::create_dir_all(shared).unwrap();
        let options = sqlx_sqlite::SqliteConnectOptions::new()
            .filename(shared.join("state.db"))
            .create_if_missing(true);
        let mut db =
            <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(&options)
                .await
                .unwrap();
        sqlx::query::query("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
            .execute(&mut db)
            .await
            .unwrap();
        for id in ids {
            sqlx::query::query("INSERT INTO sessions VALUES (?)")
                .bind(*id)
                .execute(&mut db)
                .await
                .unwrap();
        }
    }

    /// ADR-0140 (review 1): a resume on the sandboxed runtime moves to the
    /// jail's home only a conversation the shared home does not have, or one
    /// copied at the split.
    #[tokio::test]
    async fn a_sandboxed_resume_never_takes_a_conversation_of_the_shared_home() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join(SHARED_HOME);
        shared_db_with(&shared, &["unrestricted", "before-split"]).await;
        save_split_snapshot(&shared, &["before-split".to_string()]).unwrap();
        assert_eq!(
            record_checked(&shared, "unrestricted", Owner::Sandboxed)
                .await
                .unwrap(),
            Owner::Shared
        );
        assert_eq!(
            record_checked(&shared, "before-split", Owner::Sandboxed)
                .await
                .unwrap(),
            Owner::Sandboxed
        );
        assert_eq!(
            record_checked(&shared, "new", Owner::Sandboxed)
                .await
                .unwrap(),
            Owner::Sandboxed
        );
        assert_eq!(recorded(&shared).get("unrestricted"), Some(&Owner::Shared));
    }

    /// Review 4 (3): one identifier, checked once: one that would need
    /// trimming is refused, never recorded under another form.
    #[tokio::test]
    async fn a_session_identifier_is_taken_exactly_or_refused() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join(SHARED_HOME);
        shared_db_with(&shared, &["s1"]).await;
        for bad in [" s1", "s1 ", "", "a\nb", &"x".repeat(300)] {
            assert!(
                record_checked(&shared, bad, Owner::Sandboxed)
                    .await
                    .is_err(),
                "{bad:?}"
            );
        }
        assert!(recorded(&shared).is_empty());
        assert_eq!(
            record_checked(&shared, "s1", Owner::Sandboxed)
                .await
                .unwrap(),
            Owner::Shared
        );
    }

    /// ADR-0140 (review 2): a shared database that cannot be read keeps
    /// everything on the shared side.
    #[tokio::test]
    async fn an_unreadable_shared_database_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join(SHARED_HOME);
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("state.db"), "not a database").unwrap();
        assert_eq!(owner_of(&shared, "any").await, Owner::Shared);
        assert_eq!(
            record_checked(&shared, "any", Owner::Sandboxed)
                .await
                .unwrap(),
            Owner::Shared
        );
        // A database that cannot even be opened (here, a folder).
        let folder = dir.path().join("third").join(SHARED_HOME);
        std::fs::create_dir_all(folder.join("state.db")).unwrap();
        assert_eq!(owner_of(&folder, "any").await, Owner::Shared);
        // No database at all (a new installation): nothing is there.
        let fresh = dir.path().join("other").join(SHARED_HOME);
        std::fs::create_dir_all(&fresh).unwrap();
        assert_eq!(owner_of(&fresh, "any").await, Owner::Sandboxed);
    }

    #[tokio::test]
    async fn the_shared_database_is_read_with_its_schema_distrusted() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join(SHARED_HOME);
        std::fs::create_dir_all(&shared).unwrap();
        let options = sqlx_sqlite::SqliteConnectOptions::new()
            .filename(shared.join("state.db"))
            .create_if_missing(true);
        let mut db =
            <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(&options)
                .await
                .unwrap();
        sqlx::query::query("CREATE TABLE sessions (id TEXT PRIMARY KEY)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query::query("INSERT INTO sessions VALUES ('old')")
            .execute(&mut db)
            .await
            .unwrap();
        let found = in_shared_home(&shared, &["old", "new"]).await;
        assert_eq!(found, HashSet::from(["old".to_string()]));
        assert_eq!(owner_of(&shared, "old").await, Owner::Shared);
        assert_eq!(owner_of(&shared, "new").await, Owner::Sandboxed);
        // The options the app opens a runtime's database with.
        let mut hardened =
            <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(
                &hardened_read_options(&shared.join("state.db")),
            )
            .await
            .unwrap();
        let (trusted,): (i64,) = sqlx::query_as::query_as("PRAGMA trusted_schema")
            .fetch_one(&mut hardened)
            .await
            .unwrap();
        let (checked,): (i64,) = sqlx::query_as::query_as("PRAGMA cell_size_check")
            .fetch_one(&mut hardened)
            .await
            .unwrap();
        assert_eq!((trusted, checked), (0, 1));
        let mut defended = open_hardened(&shared.join("state.db")).await.unwrap();
        let mut handle = defended.lock_handle().await.unwrap();
        let mut on: std::ffi::c_int = -1;
        // SAFETY: reads the option back into `on`.
        unsafe {
            libsqlite3_sys::sqlite3_db_config(
                handle.as_raw_handle().as_ptr(),
                libsqlite3_sys::SQLITE_DBCONFIG_DEFENSIVE,
                -1 as std::ffi::c_int,
                &mut on as *mut std::ffi::c_int,
            );
        }
        assert_eq!(on, 1, "defensive mode is off");
        drop(handle);
        assert!(sqlx::query::query("DELETE FROM sessions")
            .execute(&mut hardened)
            .await
            .is_err());
        assert!(sqlx::query::query("SELECT load_extension('x')")
            .execute(&mut hardened)
            .await
            .is_err());
    }
}
