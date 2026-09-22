//! The app's half of an iPhone Shortcuts action (App Intents).
//!
//! An intent (`gen/apple/Sources/os-june/Intents`) runs in the app's own
//! process when someone taps a Shortcuts tile, the Action Button or a
//! Spotlight suggestion. It leaves a manifest in the app group container
//! (`intent-inbox/<id>.json`) and opens `subrosa://intent/<id>`: the same
//! hand-off as the share inbox (ADR-0048).
//!
//! Why not the address alone: any page can open `subrosa://chat?q=…`, so an
//! address may pre-fill a question but never send one. Only the app and its
//! extension can write in the app group, which is what makes "send it now"
//! safe when it comes from a manifest. Each manifest is read once and deleted
//! before it is acted on, and a stale one is dropped: a request from ten
//! minutes ago is not a request any more.
//!
//! The container lookup is iOS only; the rules are plain Rust, tested on
//! every platform.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::share_inbox::{app_group_container, valid_item_id};

const INBOX_DIR: &str = "intent-inbox";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024;
const MAX_QUERY_CHARS: usize = 2_000;
const MAX_AGE_SECONDS: i64 = 600;
/// Clock skew allowed between the intent and this read, in seconds.
const FUTURE_SLACK_SECONDS: i64 = 60;
const MAX_PENDING: usize = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntentManifest {
    v: u32,
    action: String,
    query: Option<String>,
    send: Option<bool>,
    created_at: String,
}

/// What the shell acts on.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntentRequest {
    pub id: String,
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    pub send: bool,
}

/// Validates one manifest. `None` for anything unreadable, unknown or stale:
/// the caller then does nothing, which is the right answer to a request it
/// cannot vouch for.
pub fn parse_manifest(id: &str, bytes: &[u8], now: DateTime<Utc>) -> Option<IntentRequest> {
    let manifest: IntentManifest = serde_json::from_slice(bytes).ok()?;
    if manifest.v != 1 {
        return None;
    }
    let action = match manifest.action.as_str() {
        "record" => "record",
        "dictate" => "dictate",
        "ask" => "ask",
        _ => return None,
    };
    let created = DateTime::parse_from_rfc3339(&manifest.created_at)
        .ok()?
        .with_timezone(&Utc);
    let age = (now - created).num_seconds();
    if !(-FUTURE_SLACK_SECONDS..=MAX_AGE_SECONDS).contains(&age) {
        return None;
    }
    let query = match action {
        "ask" => manifest
            .query
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(MAX_QUERY_CHARS).collect::<String>()),
        _ => None,
    };
    let send = manifest.send.unwrap_or(false) && query.is_some();
    Some(IntentRequest {
        id: id.to_string(),
        action,
        query,
        send,
    })
}

/// Reads and deletes one manifest, then validates what was read. Deleted
/// first, so a manifest that fails validation is not left to be retried.
fn take(path: &Path, id: &str) -> Option<IntentRequest> {
    let size = std::fs::metadata(path).ok()?.len();
    let bytes = if size <= MAX_MANIFEST_BYTES {
        std::fs::read(path).ok()
    } else {
        None
    };
    let _ = std::fs::remove_file(path);
    parse_manifest(id, &bytes?, Utc::now())
}

/// One request, by the id its address carried. Consumed.
#[tauri::command]
pub fn take_intent(id: String) -> Option<IntentRequest> {
    if !valid_item_id(&id) {
        return None;
    }
    let dir = app_group_container()?.join(INBOX_DIR);
    take(&dir.join(format!("{id}.json")), &id)
}

/// Every request still waiting, oldest first. A cold start can lose the
/// address that was meant to deliver one; the manifest is still here.
#[tauri::command]
pub fn take_pending_intents() -> Vec<IntentRequest> {
    let Some(dir) = app_group_container().map(|container| container.join(INBOX_DIR)) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, String)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".json")?.to_string();
            valid_item_id(&id).then_some(())?;
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, id))
        })
        .collect();
    found.sort();
    found
        .into_iter()
        .take(MAX_PENDING)
        .filter_map(|(_, id)| take(&dir.join(format!("{id}.json")), &id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(stamp: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&Utc)
    }

    const NOW: &str = "2026-09-22T12:00:00Z";

    #[test]
    fn reads_the_three_actions() {
        for action in ["record", "dictate", "ask"] {
            let bytes =
                format!(r#"{{"v":1,"action":"{action}","createdAt":"2026-09-22T11:59:30Z"}}"#);
            let request = parse_manifest("abc", bytes.as_bytes(), at(NOW)).unwrap();
            assert_eq!(request.action, action);
            assert!(!request.send);
        }
    }

    #[test]
    fn sends_only_a_question_that_exists() {
        let ask = br#"{"v":1,"action":"ask","query":"  what did I decide  ","send":true,"createdAt":"2026-09-22T11:59:00Z"}"#;
        let request = parse_manifest("abc", ask, at(NOW)).unwrap();
        assert_eq!(request.query.as_deref(), Some("what did I decide"));
        assert!(request.send);

        let empty = br#"{"v":1,"action":"ask","query":"   ","send":true,"createdAt":"2026-09-22T11:59:00Z"}"#;
        let request = parse_manifest("abc", empty, at(NOW)).unwrap();
        assert!(request.query.is_none());
        assert!(!request.send);

        let record = br#"{"v":1,"action":"record","query":"x","send":true,"createdAt":"2026-09-22T11:59:00Z"}"#;
        let request = parse_manifest("abc", record, at(NOW)).unwrap();
        assert!(request.query.is_none());
        assert!(!request.send);
    }

    #[test]
    fn refuses_what_it_cannot_vouch_for() {
        let stale = br#"{"v":1,"action":"record","createdAt":"2026-09-22T11:40:00Z"}"#;
        assert!(parse_manifest("abc", stale, at(NOW)).is_none());
        let future = br#"{"v":1,"action":"record","createdAt":"2026-09-22T12:05:00Z"}"#;
        assert!(parse_manifest("abc", future, at(NOW)).is_none());
        let unknown = br#"{"v":1,"action":"delete_everything","createdAt":"2026-09-22T11:59:00Z"}"#;
        assert!(parse_manifest("abc", unknown, at(NOW)).is_none());
        let version = br#"{"v":2,"action":"record","createdAt":"2026-09-22T11:59:00Z"}"#;
        assert!(parse_manifest("abc", version, at(NOW)).is_none());
        assert!(parse_manifest("abc", b"not json", at(NOW)).is_none());
    }

    #[test]
    fn caps_a_long_question() {
        let long = "a".repeat(5_000);
        let bytes = format!(
            r#"{{"v":1,"action":"ask","query":"{long}","createdAt":"2026-09-22T11:59:00Z"}}"#
        );
        let request = parse_manifest("abc", bytes.as_bytes(), at(NOW)).unwrap();
        assert_eq!(request.query.unwrap().chars().count(), MAX_QUERY_CHARS);
    }

    #[test]
    fn takes_a_manifest_once() {
        let dir = std::env::temp_dir().join(format!("intent-inbox-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.json");
        let created = Utc::now().to_rfc3339();
        std::fs::write(
            &path,
            format!(r#"{{"v":1,"action":"dictate","createdAt":"{created}"}}"#),
        )
        .unwrap();
        assert_eq!(take(&path, "abc").unwrap().action, "dictate");
        assert!(!path.exists());
        assert!(take(&path, "abc").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
