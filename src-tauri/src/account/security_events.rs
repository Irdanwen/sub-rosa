//! The account's security history, read in the app (ADR-0049 addendum).
//!
//! `GET /api/v1/security-events` answers the device's own bearer session as
//! it answers the website's cookie, so the app reads the same list the
//! account site shows: sign-ins, devices, passkeys, the vault and Carpe Diem
//! keys, newest first, never an address or a place.

use super::{pool, session};
use crate::domain::types::AppError;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

const PATH: &str = "/api/v1/security-events";
/// The service returns at most this many lines; anything more is not trusted.
const MAX_EVENTS: usize = 200;
const MAX_DEVICE_NAME: usize = 120;

/// One line of the history, as the screens render it. `kind` is the
/// service's own name; a kind this app does not know yet still renders.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurityEventDto {
    pub id: String,
    pub kind: String,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

/// The lines a response carries, newest first. A line missing its id, kind
/// or a readable instant is left out rather than shown half; anything that
/// is not a list is refused.
pub(super) fn parse(value: &Value) -> Result<Vec<SecurityEventDto>, AppError> {
    let items = value
        .as_array()
        .ok_or_else(|| super::error("account_response_invalid"))?;
    let mut events: Vec<(chrono::DateTime<chrono::FixedOffset>, SecurityEventDto)> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.trim();
            let kind = item.get("kind")?.as_str()?.trim();
            let occurred_at = item.get("occurred_at")?.as_str()?;
            let at = chrono::DateTime::parse_from_rfc3339(occurred_at).ok()?;
            if id.is_empty() || kind.is_empty() {
                return None;
            }
            let device_name = match item.get("device_name") {
                None | Some(Value::Null) => None,
                Some(Value::String(name)) => Some(name.chars().take(MAX_DEVICE_NAME).collect()),
                Some(_) => return None,
            };
            Some((
                at,
                SecurityEventDto {
                    id: id.to_string(),
                    kind: kind.to_string(),
                    occurred_at: occurred_at.to_string(),
                    device_name,
                },
            ))
        })
        .collect();
    events.sort_by_key(|event| std::cmp::Reverse(event.0));
    Ok(events
        .into_iter()
        .take(MAX_EVENTS)
        .map(|(_, event)| event)
        .collect())
}

pub(super) async fn fetch(
    base: &str,
    token: &crate::redacted::Redacted<String>,
) -> Result<Vec<SecurityEventDto>, AppError> {
    let value = super::request(base, Some(token), reqwest::Method::GET, PATH, None).await?;
    parse(&value)
}

#[tauri::command]
pub async fn account_security_events(app: AppHandle) -> Result<Vec<SecurityEventDto>, AppError> {
    let s = session(&pool(&app).await?).await?;
    fetch(&s.base, &s.token).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    #[test]
    fn lines_come_newest_first_and_damaged_ones_are_left_out() {
        let events = parse(&json!([
            {"id":"a","kind":"signed_in","occurred_at":"2026-10-01T08:00:00Z","device_name":null},
            {"id":"b","kind":"device_added","occurred_at":"2026-10-03T09:30:00Z","device_name":"Morgan's iPhone"},
            {"id":"c","kind":"some_new_kind","occurred_at":"2026-10-02T12:00:00+02:00"},
            {"id":"d","kind":"signed_out","occurred_at":"not a date"},
            {"kind":"signed_out","occurred_at":"2026-10-04T00:00:00Z"},
            {"id":"e","kind":"signed_out","occurred_at":"2026-10-04T00:00:00Z","device_name":7},
        ]))
        .unwrap();
        let ids: Vec<&str> = events.iter().map(|event| event.id.as_str()).collect();
        assert_eq!(ids, ["b", "c", "a"]);
        assert_eq!(events[0].device_name.as_deref(), Some("Morgan's iPhone"));
        assert_eq!(events[1].kind, "some_new_kind");
        assert_eq!(
            serde_json::to_value(&events[2]).unwrap(),
            json!({"id":"a","kind":"signed_in","occurredAt":"2026-10-01T08:00:00Z"})
        );
    }

    #[test]
    fn a_response_that_is_not_a_list_is_refused_and_a_long_one_is_cut() {
        assert_eq!(
            parse(&json!({"events": []})).unwrap_err().code,
            "account_response_invalid"
        );
        let many: Vec<Value> = (0..250)
            .map(|i| {
                json!({
                    "id": format!("e{i}"),
                    "kind": "signed_in",
                    "occurred_at": format!("2026-01-01T00:{:02}:{:02}Z", i / 60, i % 60),
                })
            })
            .collect();
        let events = parse(&Value::Array(many)).unwrap();
        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(events[0].id, "e249");
    }

    /// The request the app sends: a GET on the endpoint with the device's
    /// bearer token, the `data` envelope unwrapped.
    #[tokio::test]
    async fn the_history_is_read_with_the_device_session() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut chunk = [0u8; 2048];
            while !received.windows(4).any(|w| w == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    break;
                }
                received.extend_from_slice(&chunk[..read]);
            }
            let body = r#"{"data":[{"id":"x","kind":"passkey_added","occurred_at":"2026-10-05T10:00:00Z","device_name":null}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&received).into_owned()
        });
        let token = crate::redacted::Redacted::new("device-token".to_string());
        let events = fetch(&base, &token).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "passkey_added");
        let request = server.await.unwrap();
        assert!(request.starts_with("GET /api/v1/security-events HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer device-token"));
    }
}
