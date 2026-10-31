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

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::domain::types::AppError;

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
pub(super) async fn migrate_once(sandboxed: &Path) -> Result<bool, AppError> {
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
    settings.sandboxed_home_seeded = true;
    admin_settings::save(sandboxed, &settings)
        .map_err(|error| AppError::new("hermes_home_migration_failed", error.to_string()))?;
    Ok(copied)
}

/// Copies an MCP server's sign-in from the shared home, where the app's
/// command ran it, into the sandboxed home, whose runtime keeps it fresh in
/// its own copy. One direction only: nothing of the jail's home reaches the
/// shared one.
pub(crate) fn copy_mcp_tokens(any_home: &Path, server: &str) {
    let from = shared_home(any_home).join("mcp-tokens");
    let to = sandboxed_home(any_home).join("mcp-tokens");
    if std::fs::create_dir_all(&to).is_err() {
        return;
    }
    for suffix in [".json", ".client.json", ".meta.json"] {
        let name = format!("{server}{suffix}");
        let source = from.join(&name);
        if !source.is_file() {
            continue;
        }
        let target = to.join(&name);
        let _ = std::fs::remove_file(&target);
        if let Err(error) = std::fs::copy(&source, &target) {
            eprintln!("hermes mcp: could not copy the sign-in of {server}: {error}");
        }
    }
}

/// Which home a request is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Home {
    Sandboxed,
    Shared,
}

fn home_of(connection: &HermesBridgeConnection) -> Home {
    if connection.full_mode {
        Home::Shared
    } else {
        Home::Sandboxed
    }
}

/// A dashboard request, sent to the home it is about (ADR-0140). Sessions
/// span both homes: the list is merged, one session is read where it is,
/// a deletion applies to both. Routines, messaging and the gateway are the
/// shared home's. Everything else (skills, tools, servers) goes to the
/// first live runtime, sandboxed first, as before.
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
                Home::Sandboxed,
                method.clone(),
                path,
                body.clone(),
            )
            .await;
            let shared = on_home(connections, Home::Shared, method, path, body).await;
            match (sandboxed, shared) {
                (Ok(value), _) | (Err(_), Ok(value)) => Ok(value),
                (Err(error), Err(_)) => Err(error),
            }
        }
        ["api", "sessions", ..] => {
            match on_home(
                connections,
                Home::Sandboxed,
                method.clone(),
                path,
                body.clone(),
            )
            .await
            {
                Err(error) if not_found(&error) => {
                    on_home(connections, Home::Shared, method, path, body).await
                }
                other => other,
            }
        }
        ["api", "cron", ..] | ["api", "messaging", ..] => {
            on_home(connections, Home::Shared, method, path, body).await
        }
        _ => hermes_connection_json(first, method, path, body).await,
    }
}

fn not_found(error: &AppError) -> bool {
    error.code == "hermes_bridge_api_failed" && error.message.starts_with("Hermes API returned 404")
}

/// One request on one home: its live runtime when there is one, otherwise a
/// one-off process of the app (under the jail, for the sandboxed home).
async fn on_home(
    connections: &[HermesBridgeConnection],
    home: Home,
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
    if home == Home::Shared && admin_once::runs_outside_jail(&method, path) {
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
        Home::Shared => (shared_home(&any_home), None),
        Home::Sandboxed => {
            let dir = sandboxed_home(&any_home);
            // The profile the last sandboxed runtime ran under: a reader of
            // the jail's home runs under the jail too.
            let profile = data_dir(&any_home).join("hermes-sandbox.sb");
            (dir, profile.is_file().then_some(profile))
        }
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

/// The session list of both homes, merged: each is asked for the first
/// `offset + limit` sessions, a session present in both (copied at the
/// split) counts once, under its latest activity, and the page is cut from
/// the merge.
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
    for home in [Home::Sandboxed, Home::Shared] {
        match on_home(connections, home, reqwest::Method::GET, &each, None).await {
            Ok(value) => pages.push(value),
            Err(error) => last_error = Some(error),
        }
    }
    if pages.is_empty() {
        return Err(last_error.unwrap_or_else(|| {
            AppError::new("hermes_bridge_not_running", "Hermes bridge is not running.")
        }));
    }
    Ok(merge_session_pages(&pages, limit, offset, recent))
}

/// Pure merge of `{"sessions": [...], "total": n}` pages (also tested).
fn merge_session_pages(pages: &[Value], limit: usize, offset: usize, recent: bool) -> Value {
    let stamp =
        |session: &Value, key: &str| session.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let order_key = |session: &Value| {
        if recent {
            stamp(session, "last_active").max(stamp(session, "started_at"))
        } else {
            stamp(session, "started_at")
        }
    };
    let mut by_id: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
    let mut duplicates = 0u64;
    let mut total = 0u64;
    for page in pages {
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
            match by_id.get(id) {
                Some(existing) => {
                    duplicates += 1;
                    if stamp(session, "last_active") > stamp(existing, "last_active") {
                        by_id.insert(id.to_string(), session.clone());
                    }
                }
                None => {
                    by_id.insert(id.to_string(), session.clone());
                }
            }
        }
    }
    let mut sessions: Vec<Value> = by_id.into_values().collect();
    sessions.sort_by(|a, b| order_key(b).total_cmp(&order_key(a)));
    let page: Vec<Value> = sessions.into_iter().skip(offset).take(limit).collect();
    serde_json::json!({
        "sessions": page,
        "total": total.saturating_sub(duplicates),
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

    #[test]
    fn one_list_of_conversations_from_both_homes() {
        let sandboxed = json!({"total": 3, "sessions": [
            {"id": "a", "last_active": 50.0},
            {"id": "old", "last_active": 40.0},
            {"id": "c", "last_active": 10.0}
        ]});
        let shared = json!({"total": 2, "sessions": [
            {"id": "old", "last_active": 5.0},
            {"id": "full", "last_active": 45.0}
        ]});
        let merged = merge_session_pages(&[sandboxed, shared], 3, 0, true);
        let ids: Vec<&str> = merged["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a", "full", "old"]);
        // The copy made at the split counts once, under its latest activity.
        assert_eq!(merged["total"], 4);
        assert_eq!(merged["sessions"][2]["last_active"], 40.0);
        let next = merge_session_pages(
            &[
                json!({"total": 1, "sessions": [{"id": "a", "last_active": 1.0}]}),
                json!({"total": 1, "sessions": [{"id": "b", "last_active": 2.0}]}),
            ],
            1,
            1,
            true,
        );
        assert_eq!(next["sessions"][0]["id"], "a");
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
        assert!(migrate_once(&sandboxed).await.unwrap());
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
        assert!(!migrate_once(&sandboxed).await.unwrap());
        let count: (i64,) = sqlx::query_as::query_as("SELECT count(*) FROM sessions")
            .fetch_one(&mut copy)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }
}
