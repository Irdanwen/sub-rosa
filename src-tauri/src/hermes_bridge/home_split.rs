//! One home per runtime mode (ADR-0140).
//!
//! The sandboxed runtime lives in `<app data>/hermes-sandboxed/`, its own
//! home: its sessions, its workspace, its logs. The unrestricted runtime,
//! the gateway the system service manager runs and the app's settings
//! changes keep `<app data>/hermes/`, which the jail cannot write at all. No
//! process outside the jail runs or obeys anything from the sandboxed home:
//! no gateway, no routine, no messaging, no delegation delivered by another
//! process. The app reads it as data only (the list of sessions, a
//! transcript), through the sandboxed runtime when it runs, or through a
//! one-off reader under the same jail when it does not.
//!
//! The person sees one list of conversations: both homes are merged. A
//! conversation from before the split stays in the shared home, and is
//! copied once into the sandboxed home so it continues in either mode.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::domain::types::AppError;

use super::session_owner::{self, Owner};
use super::{admin_once, admin_settings, hermes_connection_json, HermesBridgeConnection};

/// The unrestricted runtime's and the gateway's home, beside the app data.
pub(crate) const SHARED_HOME: &str = "hermes";
/// The sandboxed runtime's home.
pub(crate) const SANDBOXED_HOME: &str = "hermes-sandboxed";

/// The data folder both homes sit in.
fn data_dir(any_home: &Path) -> &Path {
    any_home.parent().unwrap_or(any_home)
}

/// The shared home, from either home.
pub(crate) fn shared_home(any_home: &Path) -> PathBuf {
    data_dir(any_home).join(SHARED_HOME)
}

/// The sandboxed home, from either home.
pub(crate) fn sandboxed_home(any_home: &Path) -> PathBuf {
    data_dir(any_home).join(SANDBOXED_HOME)
}

/// Both homes, sandboxed first (most conversations live there).
pub(crate) fn both_homes(any_home: &Path) -> [PathBuf; 2] {
    [sandboxed_home(any_home), shared_home(any_home)]
}

/// The home a runtime of this mode lives in, from either home.
pub(crate) fn home_of_mode(any_home: &Path, full_mode: bool) -> PathBuf {
    if full_mode {
        shared_home(any_home)
    } else {
        sandboxed_home(any_home)
    }
}

/// The home a runtime of this mode lives in.
pub(crate) fn home_for_mode(app: &tauri::AppHandle, full_mode: bool) -> Result<PathBuf, AppError> {
    let shared = super::resolve_june_hermes_home(app)?;
    if full_mode {
        return Ok(shared);
    }
    let home = home_of_mode(&shared, false);
    std::fs::create_dir_all(&home)
        .map_err(|error| AppError::new("hermes_bridge_home_failed", error.to_string()))?;
    Ok(home)
}

/// Copies, once, the conversations of the shared home into the sandboxed
/// one, before its first runtime starts, so a conversation from before the
/// split continues in either mode. Data goes from the shared home to the
/// jail's, never back. `VACUUM INTO` makes a consistent copy of a database
/// another process may be using.
///
/// A failure never stops the start (F5): it is logged, said once in the
/// notice, and tried again at the next start while the sandboxed home has
/// no database of its own. Until then the earlier conversations open from
/// the shared home, where they still are.
pub(super) async fn migrate_once(sandboxed: &Path) -> bool {
    match copy_once(sandboxed).await {
        Ok(copied) => copied,
        Err(error) => {
            eprintln!(
                "hermes home: the conversations were not copied: {}",
                error.message
            );
            let target = sandboxed.join("state.db");
            if target.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
                let _ = std::fs::remove_file(&target);
            }
            let mut settings = admin_settings::load(sandboxed);
            let record = settings.quarantine.get_or_insert_with(Default::default);
            if !record.redo.iter().any(|code| code == "conversations") {
                record.redo.push("conversations".to_string());
            }
            record.seen = false;
            let _ = admin_settings::save(sandboxed, &settings);
            false
        }
    }
}

async fn copy_once(sandboxed: &Path) -> Result<bool, AppError> {
    let shared = shared_home(sandboxed);
    let mut settings = admin_settings::load(sandboxed);
    if settings.sandboxed_home_seeded {
        return Ok(false);
    }
    let source = shared.join("state.db");
    let target = sandboxed.join("state.db");
    let mut copied = false;
    if source.is_file() && target.symlink_metadata().is_err() {
        let options = sqlx_sqlite::SqliteConnectOptions::new()
            .filename(&source)
            .read_only(true)
            .create_if_missing(false);
        let mut connection =
            <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(&options)
                .await
                .map_err(|error| {
                    AppError::new("hermes_home_migration_failed", error.to_string())
                })?;
        sqlx::query::query("VACUUM INTO ?")
            .bind(target.to_string_lossy().into_owned())
            .execute(&mut connection)
            .await
            .map_err(|error| AppError::new("hermes_home_migration_failed", error.to_string()))?;
        copied = true;
    }
    settings = admin_settings::load(sandboxed);
    settings.sandboxed_home_seeded = true;
    if let Some(record) = settings.quarantine.as_mut() {
        record.redo.retain(|code| code != "conversations");
    }
    admin_settings::save(sandboxed, &settings)
        .map_err(|error| AppError::new("hermes_home_migration_failed", error.to_string()))?;
    Ok(copied)
}

fn home_of(connection: &HermesBridgeConnection) -> Owner {
    Owner::of_mode(connection.full_mode)
}

/// A dashboard request, sent to the home it is about (ADR-0140). Sessions
/// span both homes: the list is merged, one session is read and written in
/// the home that owns it (`session_owner`) and nowhere else, a deletion
/// applies to both. Routines, messaging and the gateway are the shared
/// home's. Everything else (skills, tools, servers) goes to the first live
/// runtime, sandboxed first, as before.
pub(super) async fn api_json(
    connections: &[HermesBridgeConnection],
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let Some(first) = connections.first() else {
        return Err(AppError::new(
            "hermes_bridge_not_running",
            "Hermes bridge is not running.",
        ));
    };
    let bare = path.split('?').next().unwrap_or(path);
    let segments: Vec<&str> = bare.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["api", "sessions"] if method == reqwest::Method::GET => {
            merged_sessions(connections, path).await
        }
        ["api", "sessions", ..] if method == reqwest::Method::DELETE => {
            let sandboxed = on_home(
                connections,
                Owner::Sandboxed,
                method.clone(),
                path,
                body.clone(),
            )
            .await;
            let shared = on_home(connections, Owner::Shared, method, path, body).await;
            match (sandboxed, shared) {
                (Ok(value), _) | (Err(_), Ok(value)) => Ok(value),
                (Err(error), Err(_)) => Err(error),
            }
        }
        ["api", "sessions", id, ..] => {
            let id = urlencoding::decode(id)
                .map(|id| id.into_owned())
                .unwrap_or_else(|_| (*id).to_string());
            let owner = session_owner::owner_of(Path::new(&first.hermes_home), &id).await;
            on_home(connections, owner, method, path, body).await
        }
        ["api", "cron", ..] | ["api", "messaging", ..] => {
            on_home(connections, Owner::Shared, method, path, body).await
        }
        _ => hermes_connection_json(first, method, path, body).await,
    }
}

/// One request on one home: its live runtime when there is one, otherwise a
/// one-off process of the app (under the jail, for the sandboxed home).
async fn on_home(
    connections: &[HermesBridgeConnection],
    home: Owner,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    if let Some(connection) = connections.iter().find(|c| home_of(c) == home) {
        return hermes_connection_json(connection, method, path, body).await;
    }
    let Some(any) = connections.first() else {
        return Err(AppError::new(
            "hermes_bridge_not_running",
            "Hermes bridge is not running.",
        ));
    };
    // A settings change (a routine, a messaging platform) is the app's, on
    // the shared home, whichever runtime is up.
    if home == Owner::Shared && admin_once::runs_outside_jail(&method, path) {
        return admin_once::run(any, method, path, body).await;
    }
    let Some(any) = connections.first() else {
        return Err(AppError::new(
            "hermes_bridge_not_running",
            "Hermes bridge is not running.",
        ));
    };
    let any_home = PathBuf::from(&any.hermes_home);
    let (dir, jail) = match home {
        Owner::Shared => (shared_home(&any_home), None),
        Owner::Sandboxed => (
            sandboxed_home(&any_home),
            reader_jail(&any_home, super::sandbox_profile::jail_engages())?,
        ),
    };
    if !dir.is_dir() {
        return Err(AppError::new(
            "hermes_bridge_api_failed",
            format!(
                "Hermes API returned 404 Not Found: no home at {}",
                dir.display()
            ),
        ));
    }
    admin_once::read_on(&any.command, &dir, jail, method, path, body).await
}

/// The jail a one-off reader of the sandboxed home runs under (ADR-0140):
/// its own fresh profile, without the working folder or the agent CLI state
/// of the last session. Where sandboxed processes run jailed, a reader
/// without that profile does not run at all: it fails closed, never reading
/// the jail's home from outside the jail. Where they do not (another system,
/// the debugging switch), the runtime itself has no jail to keep.
pub(super) fn reader_jail(
    any_home: &Path,
    jail_engages: bool,
) -> Result<Option<PathBuf>, AppError> {
    if !jail_engages {
        return Ok(None);
    }
    let profile = data_dir(any_home).join(super::sandbox_profile::READER_PROFILE_FILE);
    if profile.is_file() {
        Ok(Some(profile))
    } else {
        Err(AppError::new(
            "hermes_sandboxed_reader_unavailable",
            "The sandboxed conversations cannot be read until the assistant starts once.",
        ))
    }
}

/// The session list of both homes, merged: each is asked for the first
/// `offset + limit` sessions, each session is kept from the home that owns
/// it only (`session_owner`: a copy made at the split, or one the jail
/// wrote under another home's identifier, is never shown), and the page is
/// cut from the merge.
async fn merged_sessions(
    connections: &[HermesBridgeConnection],
    path: &str,
) -> Result<Value, AppError> {
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut limit = 20usize;
    let mut offset = 0usize;
    let mut kept = Vec::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        match pair.split_once('=') {
            Some(("limit", value)) => limit = value.parse().unwrap_or(limit),
            Some(("offset", value)) => offset = value.parse().unwrap_or(offset),
            _ => kept.push(pair.to_string()),
        }
    }
    kept.push(format!("limit={}", offset + limit));
    kept.push("offset=0".to_string());
    let each = format!("/api/sessions?{}", kept.join("&"));
    let recent = !kept.iter().any(|pair| pair == "order=created");
    let mut pages = Vec::new();
    let mut last_error = None;
    for home in [Owner::Sandboxed, Owner::Shared] {
        match on_home(connections, home, reqwest::Method::GET, &each, None).await {
            Ok(value) => pages.push((home, value)),
            Err(error) => last_error = Some(error),
        }
    }
    if pages.is_empty() {
        return Err(last_error.unwrap_or_else(|| {
            AppError::new("hermes_bridge_not_running", "Hermes bridge is not running.")
        }));
    }
    let any_home = connections
        .first()
        .map(|connection| PathBuf::from(&connection.hermes_home))
        .unwrap_or_default();
    let ids_of = |wanted: Owner| -> Vec<String> {
        pages
            .iter()
            .filter(|(home, _)| *home == wanted)
            .flat_map(|(_, page)| session_ids(page))
            .collect()
    };
    let mut in_shared: HashSet<String> = ids_of(Owner::Shared).into_iter().collect();
    let unknown = ids_of(Owner::Sandboxed);
    let unknown: Vec<&str> = unknown
        .iter()
        .map(String::as_str)
        .filter(|id| !in_shared.contains(*id))
        .collect();
    in_shared.extend(session_owner::in_shared_home(&any_home, &unknown).await);
    let all: Vec<String> = pages
        .iter()
        .flat_map(|(_, page)| session_ids(page))
        .collect();
    let owners = session_owner::owners_of(&any_home, all.iter().map(String::as_str), &in_shared);
    Ok(merge_session_pages(&pages, &owners, limit, offset, recent))
}

fn session_ids(page: &Value) -> Vec<String> {
    page.get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// Pure merge of `{"sessions": [...], "total": n}` pages, each from one
/// home, keeping each session from its owner only (also tested).
fn merge_session_pages(
    pages: &[(Owner, Value)],
    owners: &BTreeMap<String, Owner>,
    limit: usize,
    offset: usize,
    recent: bool,
) -> Value {
    let stamp =
        |session: &Value, key: &str| session.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let order_key = |session: &Value| {
        if recent {
            stamp(session, "last_active").max(stamp(session, "started_at"))
        } else {
            stamp(session, "started_at")
        }
    };
    let mut sessions: Vec<Value> = Vec::new();
    let mut dropped = 0u64;
    let mut total = 0u64;
    for (home, page) in pages {
        total += page.get("total").and_then(Value::as_u64).unwrap_or(0);
        for session in page
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = session.get("id").and_then(Value::as_str) else {
                continue;
            };
            if owners.get(id) == Some(home) {
                sessions.push(session.clone());
            } else {
                dropped += 1;
            }
        }
    }
    sessions.sort_by(|a, b| order_key(b).total_cmp(&order_key(a)));
    let page: Vec<Value> = sessions.into_iter().skip(offset).take(limit).collect();
    serde_json::json!({
        "sessions": page,
        "total": total.saturating_sub(dropped),
        "limit": limit,
        "offset": offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_homes_sit_side_by_side() {
        let shared = Path::new("/data/xyz.carpediem.subrosa/hermes");
        let sandboxed = Path::new("/data/xyz.carpediem.subrosa/hermes-sandboxed");
        assert_eq!(sandboxed_home(shared), sandboxed);
        assert_eq!(shared_home(sandboxed), shared);
        assert_eq!(
            both_homes(shared),
            [sandboxed.to_path_buf(), shared.to_path_buf()]
        );
        // A sandboxed runtime never lives in the shared home.
        assert_eq!(home_of_mode(shared, false), sandboxed);
        assert_eq!(home_of_mode(sandboxed, true), shared);
    }

    /// ADR-0140 (d): asked from the sandboxed runtime, the gateway still
    /// starts on the shared home: it never reads the jail's (where a forged
    /// delegation or an interrupted turn would sit), so nothing there is
    /// delivered or resumed by a process outside the jail.
    #[test]
    fn the_gateway_never_reads_the_sandboxed_home() {
        let data = tempfile::tempdir().unwrap();
        let shared = data.path().join(SHARED_HOME);
        let sandboxed = data.path().join(SANDBOXED_HOME);
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir_all(&sandboxed).unwrap();
        let connection = HermesBridgeConnection {
            base_url: "http://127.0.0.1:1".to_string(),
            ws_url: "ws://127.0.0.1:1/api/ws".to_string(),
            token: "t".to_string(),
            port: 1,
            command: "/usr/bin/false".to_string(),
            hermes_home: sandboxed.to_string_lossy().into_owned(),
            cwd: None,
            working_dir: None,
            provider_proxy_port: 2,
            pid: 3,
            sandboxed: true,
            full_mode: false,
        };
        let cmd = super::super::hermes_gateway_start_command(&connection);
        let home = cmd
            .get_envs()
            .find(|(key, _)| *key == "HERMES_HOME")
            .and_then(|(_, value)| value)
            .map(PathBuf::from)
            .unwrap();
        assert_eq!(home, shared);
        assert_eq!(cmd.get_current_dir(), Some(shared.as_path()));
        assert!(!cmd
            .get_args()
            .any(|arg| arg.to_string_lossy().contains(SANDBOXED_HOME)));
    }

    /// ADR-0140 (M3): one list from both homes, each conversation from the
    /// home that owns it. The copy of the other home is not shown, a
    /// routine's run or a conversation known as unrestricted never comes
    /// from the jail's home, whatever that home claims.
    #[test]
    fn one_list_of_conversations_each_from_its_owner() {
        let sandboxed = json!({"total": 5, "sessions": [
            {"id": "a", "last_active": 50.0},
            {"id": "old", "last_active": 40.0, "title": "continued sandboxed"},
            {"id": "full", "last_active": 99.0, "title": "forged"},
            {"id": "cron_job_1", "last_active": 98.0, "title": "forged"},
            {"id": "c", "last_active": 10.0}
        ]});
        let shared = json!({"total": 3, "sessions": [
            {"id": "old", "last_active": 5.0},
            {"id": "full", "last_active": 45.0, "title": "real"},
            {"id": "cron_job_1", "last_active": 30.0, "title": "real"}
        ]});
        let owners: BTreeMap<String, Owner> = [
            ("a", Owner::Sandboxed),
            ("old", Owner::Sandboxed),
            ("full", Owner::Shared),
            ("cron_job_1", Owner::Shared),
            ("c", Owner::Sandboxed),
        ]
        .into_iter()
        .map(|(id, owner)| (id.to_string(), owner))
        .collect();
        let pages = [(Owner::Sandboxed, sandboxed), (Owner::Shared, shared)];
        let merged = merge_session_pages(&pages, &owners, 10, 0, true);
        let ids: Vec<&str> = merged["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a", "full", "old", "cron_job_1", "c"]);
        assert_eq!(merged["sessions"][1]["title"], "real");
        assert_eq!(merged["sessions"][2]["title"], "continued sandboxed");
        assert_eq!(merged["sessions"][3]["title"], "real");
        assert_eq!(merged["total"], 5);
        let next = merge_session_pages(&pages, &owners, 1, 1, true);
        assert_eq!(next["sessions"][0]["id"], "full");
    }

    /// ADR-0140 (M3): the owners the list and every read use. A routine's
    /// run and a conversation the shared database has are the shared
    /// home's unless the app recorded otherwise, and a routine never is.
    #[tokio::test]
    async fn the_owner_never_comes_from_the_jails_home() {
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
        for id in ["telegram_1", "resumed"] {
            sqlx::query::query("INSERT INTO sessions VALUES (?)")
                .bind(id)
                .execute(&mut db)
                .await
                .unwrap();
        }
        session_owner::record(&shared, "resumed", Owner::Sandboxed).unwrap();
        session_owner::record(&shared, "unrestricted", Owner::Shared).unwrap();
        session_owner::record(&shared, "cron_j_1", Owner::Sandboxed).unwrap();
        for (id, owner) in [
            ("telegram_1", Owner::Shared),
            ("resumed", Owner::Sandboxed),
            ("unrestricted", Owner::Shared),
            ("cron_j_1", Owner::Shared),
            ("new", Owner::Sandboxed),
        ] {
            assert_eq!(session_owner::owner_of(&shared, id).await, owner, "{id}");
        }
    }

    /// ADR-0140 (review 2, F1): a reader of the jail's home runs under its
    /// own fresh profile, and without one it does not run at all.
    #[test]
    fn the_reader_of_the_jails_home_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join(SHARED_HOME);
        let error = reader_jail(&shared, true).unwrap_err();
        assert_eq!(error.code, "hermes_sandboxed_reader_unavailable");
        // The runtime's own profile (with its working folder) is not taken.
        std::fs::write(
            dir.path()
                .join(super::super::sandbox_profile::RUNTIME_PROFILE_FILE),
            "(version 1)",
        )
        .unwrap();
        assert!(reader_jail(&shared, true).is_err());
        let reader = dir
            .path()
            .join(super::super::sandbox_profile::READER_PROFILE_FILE);
        std::fs::write(&reader, "(version 1)").unwrap();
        assert_eq!(reader_jail(&shared, true).unwrap(), Some(reader));
        assert_eq!(reader_jail(&shared, false).unwrap(), None);
    }

    /// ADR-0140 (F5): a copy that fails does not stop the start, is said
    /// once, and is tried again at the next start.
    #[tokio::test]
    async fn a_failed_copy_is_said_and_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join(SHARED_HOME);
        let sandboxed = dir.path().join(SANDBOXED_HOME);
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir_all(&sandboxed).unwrap();
        std::fs::write(shared.join("state.db"), "not a database").unwrap();
        assert!(!migrate_once(&sandboxed).await);
        let settings = admin_settings::load(&sandboxed);
        assert!(!settings.sandboxed_home_seeded);
        let record = settings.quarantine.unwrap();
        assert!(record.redo.contains(&"conversations".to_string()) && !record.seen);
        assert!(sandboxed.join("state.db").symlink_metadata().is_err());
        // Next start, the shared database readable again: copied.
        std::fs::remove_file(shared.join("state.db")).unwrap();
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
        assert!(migrate_once(&sandboxed).await);
        let settings = admin_settings::load(&sandboxed);
        assert!(settings.sandboxed_home_seeded);
        assert!(!settings
            .quarantine
            .unwrap()
            .redo
            .contains(&"conversations".to_string()));
    }

    /// A sandboxed runtime that answers anything with a forged body, and
    /// says whether it was asked.
    fn forged_sandboxed_runtime(
        data: &Path,
    ) -> (
        HermesBridgeConnection,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        use std::io::{Read as _, Write as _};
        let sandboxed = data.join(SANDBOXED_HOME);
        std::fs::create_dir_all(&sandboxed).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = asked.clone();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let body = r#"{"jobs":[{"id":"forged"}],"messages":[{"role":"assistant","content":"forged"}]}"#;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let connection = HermesBridgeConnection {
            base_url: format!("http://127.0.0.1:{port}"),
            ws_url: format!("ws://127.0.0.1:{port}/api/ws"),
            token: "t".to_string(),
            port,
            command: "/usr/bin/false".to_string(),
            hermes_home: sandboxed.to_string_lossy().into_owned(),
            cwd: None,
            working_dir: None,
            provider_proxy_port: 2,
            pid: 3,
            sandboxed: true,
            full_mode: false,
        };
        (connection, asked)
    }

    fn forged(result: &Result<Value, AppError>) -> bool {
        result
            .as_ref()
            .is_ok_and(|value| value.to_string().contains("forged"))
    }

    /// ADR-0140 (M2): the routines are read from the shared home, never
    /// from the sandboxed runtime, even when it is the only one up.
    #[tokio::test]
    async fn the_routines_are_never_read_from_the_jail() {
        let dir = tempfile::tempdir().unwrap();
        let (connection, asked) = forged_sandboxed_runtime(dir.path());
        let jobs = super::super::cron_jobs_of(std::slice::from_ref(&connection)).await;
        assert!(!forged(&jobs), "{jobs:?}");
        assert!(!asked.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// ADR-0140 (M3): a conversation is read from its owner only. One the
    /// app knows as unrestricted, or a routine's run, is never asked of the
    /// sandboxed runtime; one of the jail's is.
    #[tokio::test]
    async fn a_conversation_is_read_from_its_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let (connection, asked) = forged_sandboxed_runtime(dir.path());
        let shared = dir.path().join(SHARED_HOME);
        session_owner::record(&shared, "full", Owner::Shared).unwrap();
        let connections = std::slice::from_ref(&connection);
        for id in ["full", "cron_job_1"] {
            let read = api_json(
                connections,
                reqwest::Method::GET,
                &format!("/api/sessions/{id}/messages"),
                None,
            )
            .await;
            assert!(!forged(&read), "{id}: {read:?}");
            assert!(!asked.load(std::sync::atomic::Ordering::SeqCst), "{id}");
        }
        let own = api_json(
            connections,
            reqwest::Method::GET,
            "/api/sessions/jail-own/messages",
            None,
        )
        .await;
        assert!(forged(&own), "{own:?}");
    }

    #[tokio::test]
    async fn the_conversations_from_before_the_split_are_copied_once() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join(SHARED_HOME);
        let sandboxed = dir.path().join(SANDBOXED_HOME);
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir_all(&sandboxed).unwrap();
        let options = sqlx_sqlite::SqliteConnectOptions::new()
            .filename(shared.join("state.db"))
            .create_if_missing(true);
        let mut db =
            <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(&options)
                .await
                .unwrap();
        sqlx::query::query("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query::query("INSERT INTO sessions VALUES ('old', 'Before the split')")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(migrate_once(&sandboxed).await);
        let options = sqlx_sqlite::SqliteConnectOptions::new()
            .filename(sandboxed.join("state.db"))
            .read_only(true);
        let mut copy =
            <sqlx_sqlite::SqliteConnection as sqlx::connection::Connection>::connect_with(&options)
                .await
                .unwrap();
        let (title,): (String,) =
            sqlx::query_as::query_as("SELECT title FROM sessions WHERE id = 'old'")
                .fetch_one(&mut copy)
                .await
                .unwrap();
        assert_eq!(title, "Before the split");
        // Once: a later start copies nothing, whatever the shared home holds.
        sqlx::query::query("INSERT INTO sessions VALUES ('later', 'After')")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(!migrate_once(&sandboxed).await);
        let count: (i64,) = sqlx::query_as::query_as("SELECT count(*) FROM sessions")
            .fetch_one(&mut copy)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }
}
