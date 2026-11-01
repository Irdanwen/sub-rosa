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
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(AppError::new(
            "hermes_session_id_required",
            "Hermes session ID is required.",
        ));
    }
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

/// Which of `ids` the shared home's database has. Unreadable is none.
pub(crate) async fn in_shared_home(any_home: &Path, ids: &[&str]) -> HashSet<String> {
    let mut found = HashSet::new();
    let path = shared_home(any_home).join("state.db");
    if ids.is_empty() || !path.is_file() {
        return found;
    }
    let Ok(mut connection) =
        <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(
            &hardened_read_options(&path),
        )
        .await
    else {
        return found;
    };
    for id in ids {
        let present: Option<(i64,)> =
            sqlx::query_as::query_as("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
                .bind(*id)
                .fetch_optional(&mut connection)
                .await
                .ok()
                .flatten();
        if present.is_some() {
            found.insert((*id).to_string());
        }
    }
    let _ = sqlx::connection::Connection::close(connection).await;
    found
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

/// Records the home a conversation was created or resumed in, from the
/// mode of the runtime that did it (ADR-0140).
#[tauri::command]
pub async fn hermes_record_session_home(
    app: tauri::AppHandle,
    request: RecordSessionHomeRequest,
) -> Result<(), AppError> {
    let home = super::resolve_june_hermes_home(&app)?;
    record(
        &home,
        &request.session_id,
        Owner::of_mode(request.unrestricted),
    )
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
