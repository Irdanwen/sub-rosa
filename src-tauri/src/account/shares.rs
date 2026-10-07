//! Sharing a note as a link the service cannot read.
//!
//! The whole design is one sentence: a fresh key per share, the ciphertext on
//! the service, the key in the URL fragment. A fragment is not sent with a
//! request, so the bytes and the key that opens them never meet anywhere but
//! in the reader's browser.
//!
//! This is the one place a key deliberately crosses the webview boundary, and
//! it is not the exception the module header forbids: the vault key still never
//! leaves, and what crosses here is a key generated for this share alone, whose
//! entire purpose is to be copied into a message. Nothing else it opens exists.
//!
//! What cannot be taken back is said where the link is made, not here: revoking
//! stops the service answering and reaches no copy already downloaded
//! ([ADR 0050](../../../docs/adr/0050-vault-admission-uses-an-out-of-band-secret.md)).
use super::*;

/// How long a link may answer. The service rejects anything outside a minute
/// and thirty days, and the surface offers exactly these three: a deadline is
/// a decision the person makes, and "never" is not on the list.
pub const WINDOW_HOURS: &[i64] = &[24, 24 * 7, 24 * 30];

#[derive(Serialize)]
pub struct ShareLink {
    pub id: String,
    pub url: String,
    pub expires_at: String,
}

/// A live link, as far as this device knows. `title` is empty for a link made
/// on another device: the service has no idea what it is holding, so nothing
/// can tell us.
#[derive(Serialize)]
pub struct ShareSummary {
    pub id: String,
    pub title: String,
    pub note_id: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub bytes: i64,
}

/// The sealed head of a share. Position 0 of every share is one of these, and
/// for a note or a conversation it is the whole share. A note carries its
/// body; a conversation carries its turns and an empty body, so a note's
/// document is byte for byte what it always was.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SharedDocument {
    v: u8,
    kind: String,
    title: String,
    body: String,
    shared_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    messages: Option<Vec<SharedMessage>>,
}

/// One visible turn of a shared conversation: who said it, and the text the
/// person saw. Chat blocks stay in it as their fenced JSON, which the reader
/// renders as plain lists.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SharedMessage {
    pub role: String,
    pub content: String,
}

/// What the reader of a shared conversation may be handed, at most. Well
/// under the reader's piece ceiling, so the link that is made always opens.
const MAX_CONVERSATION_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareConversationRequest {
    /// A chat stored here (the phone, or a conversation from another device).
    #[serde(default)]
    pub task_id: Option<String>,
    /// A desktop Hermes session.
    #[serde(default)]
    pub session_id: Option<String>,
    /// The title the desktop shows for its session.
    #[serde(default)]
    pub title: Option<String>,
    pub window_hours: i64,
}

fn share_aad(id: &str, position: usize) -> String {
    format!("subrosa:share:v1:{id}:{position}")
}
fn share_error() -> AppError {
    error("share_failed")
}

/// Uploads one sealed piece under a fresh id and returns that id.
async fn put_piece(s: &Session, sealed: String) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let client = crate::http_client::credentialed(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("account_network"))?;
    let started = Instant::now();
    let bytes = sealed.into_bytes();
    let request_bytes = bytes.len() as u64;
    let response = client
        .put(format!("{}/api/v1/blobs/{id}", s.base))
        .bearer_auth(s.token.expose_str())
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|_| error("account_network"))?;
    let status = response.status();
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(&s.base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default(),
        purpose: "account synchronization".into(),
        method: "PUT".into(),
        request_bytes,
        response_bytes: 0,
        status: Some(status.as_u16()),
        duration_ms: started.elapsed().as_millis() as u64,
        model: None,
        note_id: None,
    });
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return Err(error("share_too_large"));
    }
    if !status.is_success() {
        return Err(share_error());
    }
    Ok(id)
}

/// Publishes one note. Everything a reader will see is sealed before the first
/// byte leaves, so the failure modes are "the upload did not happen" and
/// nothing in between.
pub async fn create_note_share(
    app: &AppHandle,
    note_id: &str,
    window_hours: i64,
) -> Result<ShareLink, AppError> {
    if !WINDOW_HOURS.contains(&window_hours) {
        return Err(error("share_window_invalid"));
    }
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let row = query("SELECT title, COALESCE(NULLIF(edited_content,''), generated_content, '') AS body FROM notes WHERE id = ?")
        .bind(note_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(share_error)?;
    let title: String = row.get("title");
    let body: String = row.get("body");
    let document = SharedDocument {
        v: 1,
        kind: "note".into(),
        title,
        body,
        shared_at: chrono::Utc::now().to_rfc3339(),
        messages: None,
    };
    publish(&pool, &s, document, Some(note_id), window_hours).await
}

/// Seals a document under a fresh key, uploads it, opens the share on the
/// service and names it locally.
async fn publish(
    pool: &SqlitePool,
    s: &Session,
    document: SharedDocument,
    note_id: Option<&str>,
    window_hours: i64,
) -> Result<ShareLink, AppError> {
    let title = document.title.clone();
    let document = serde_json::to_vec(&document).map_err(|_| share_error())?;
    let id = uuid::Uuid::new_v4().to_string();
    let key = crypto::random_key();
    let head = put_piece(s, crypto::seal(&key, &share_aad(&id, 0), &document)?).await?;
    let expires_at = (chrono::Utc::now() + chrono::Duration::hours(window_hours)).to_rfc3339();
    call(
        s,
        reqwest::Method::POST,
        "/api/v1/shares",
        Some(json!({"id": id, "expires_at": expires_at, "blob_ids": [head]})),
    )
    .await?;
    query("INSERT OR REPLACE INTO account_shares(id,note_id,title,created_at,expires_at) VALUES(?,?,?,?,?)")
        .bind(&id)
        .bind(note_id)
        .bind(&title)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&expires_at)
        .execute(pool)
        .await?;
    Ok(ShareLink {
        url: format!("{}/s/{id}#k={}", s.base, crypto::encode(key.as_slice())),
        id,
        expires_at,
    })
}

/// Publishes one conversation: its visible turns and nothing else. A
/// temporary chat is refused before anything is read (ADR-0083).
pub async fn create_conversation_share(
    app: &AppHandle,
    request: ShareConversationRequest,
) -> Result<ShareLink, AppError> {
    if !WINDOW_HOURS.contains(&request.window_hours) {
        return Err(error("share_window_invalid"));
    }
    let pool = pool(app).await?;
    let (title, turns) = match (request.task_id.as_deref(), request.session_id.as_deref()) {
        (Some(task_id), _) => stored_turns(&pool, task_id).await?,
        (None, Some(session_id)) => {
            if crate::temporary_chat::is_temporary_session(&pool, session_id).await? {
                return Err(error("share_temporary"));
            }
            let turns = super::conversations::hermes_turns(app, session_id).await?;
            (request.title.unwrap_or_default(), turns)
        }
        (None, None) => return Err(share_error()),
    };
    let messages = visible_turns(turns);
    if messages.is_empty() {
        return Err(error("share_empty"));
    }
    if messages.iter().map(|m| m.content.len()).sum::<usize>() > MAX_CONVERSATION_BYTES {
        return Err(error("share_too_large"));
    }
    let s = session(&pool).await?;
    let document = SharedDocument {
        v: 1,
        kind: "conversation".into(),
        title: title.trim().chars().take(200).collect(),
        body: String::new(),
        shared_at: chrono::Utc::now().to_rfc3339(),
        messages: Some(messages),
    };
    publish(&pool, &s, document, None, request.window_hours).await
}

/// A stored chat's title and its user and assistant messages, oldest first.
async fn stored_turns(
    pool: &SqlitePool,
    task_id: &str,
) -> Result<(String, Vec<(String, String)>), AppError> {
    let task = query("SELECT title, ephemeral FROM agent_tasks WHERE id = ?")
        .bind(task_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(share_error)?;
    if task.get::<i64, _>("ephemeral") != 0 {
        return Err(error("share_temporary"));
    }
    let rows = query("SELECT role, content FROM agent_messages WHERE task_id = ? AND role IN ('user','assistant') ORDER BY created_at, rowid")
        .bind(task_id)
        .fetch_all(pool)
        .await?;
    Ok((
        task.get("title"),
        rows.into_iter()
            .map(|row| (row.get("role"), row.get("content")))
            .collect(),
    ))
}

/// Only what the person saw in the conversation: user and assistant text,
/// without the context the app attached to a question, without any inline
/// attachment bytes, and without a turn that is left empty by that.
pub(crate) fn visible_turns(turns: Vec<(String, String)>) -> Vec<SharedMessage> {
    turns
        .into_iter()
        .filter(|(role, _)| matches!(role.as_str(), "user" | "assistant"))
        .filter_map(|(role, content)| {
            let content = without_inline_data(&without_attached_context(&content));
            let content = content.trim();
            (!content.is_empty()).then(|| SharedMessage {
                role,
                content: content.to_string(),
            })
        })
        .collect()
}

/// The desktop appends notes and files to a question under these markers;
/// the conversation shows the question alone.
fn without_attached_context(content: &str) -> String {
    let mut end = content.len();
    for marker in ["--- Context Warnings ---", "--- Attached Context ---"] {
        if let Some(at) = content.find(marker) {
            end = end.min(at);
        }
    }
    content[..end].to_string()
}

/// Replaces every `data:` URI (an image pasted inline, say) with a marker.
fn without_inline_data(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(at) = rest.find("data:") {
        let candidate = &rest[at..];
        let end = candidate
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '"' | '\'' | '>' | ']'))
            .unwrap_or(candidate.len());
        let token = &candidate[..end];
        out.push_str(&rest[..at]);
        if token.contains(";base64,") {
            out.push_str("[attachment]");
        } else {
            out.push_str(token);
        }
        rest = &candidate[end..];
    }
    out.push_str(rest);
    out
}

/// The service is the authority on what is still answering. The local rows only
/// supply names, and a row the service no longer lists is swept away with it.
pub async fn list_shares(app: &AppHandle) -> Result<Vec<ShareSummary>, AppError> {
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let live = call(&s, reqwest::Method::GET, "/api/v1/shares", None).await?;
    let live = live.as_array().cloned().unwrap_or_default();
    let mut summaries = Vec::new();
    let mut known = Vec::new();
    for entry in live {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let local = query("SELECT note_id, title FROM account_shares WHERE id = ?")
            .bind(id)
            .fetch_optional(&pool)
            .await?;
        known.push(id.to_string());
        summaries.push(ShareSummary {
            id: id.to_string(),
            title: local
                .as_ref()
                .map(|r| r.get::<String, _>("title"))
                .unwrap_or_default(),
            note_id: local.and_then(|r| r.get::<Option<String>, _>("note_id")),
            created_at: entry
                .get("created_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            expires_at: entry
                .get("expires_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            bytes: entry
                .get("bytes")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
        });
    }
    // A name for a link that stopped answering is litter, and the service is
    // the only thing that knows which those are.
    if known.is_empty() {
        query("DELETE FROM account_shares").execute(&pool).await?;
    } else {
        let prune = format!(
            "DELETE FROM account_shares WHERE id NOT IN ({})",
            vec!["?"; known.len()].join(",")
        );
        let mut statement = query(&prune);
        for id in &known {
            statement = statement.bind(id);
        }
        statement.execute(&pool).await?;
    }
    Ok(summaries)
}

pub async fn revoke_share(app: &AppHandle, id: &str) -> Result<(), AppError> {
    uuid::Uuid::parse_str(id).map_err(|_| share_error())?;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    call(
        &s,
        reqwest::Method::DELETE,
        &format!("/api/v1/shares/{id}"),
        None,
    )
    .await?;
    query("DELETE FROM account_shares WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reader's browser derives the same context from the identifier in the
    /// link, and from nothing else: a share carries no account, so a fragment
    /// key opens exactly one share and cannot be replayed against another.
    #[test]
    fn the_context_binds_the_share_and_the_position_only() {
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(share_aad(&id, 0), format!("subrosa:share:v1:{id}:0"));
        assert_ne!(share_aad(&id, 0), share_aad(&id, 1));
        let key = crypto::random_key();
        let sealed = crypto::seal(&key, &share_aad(&id, 0), b"head").unwrap();
        assert!(crypto::open(&key, &share_aad(&id, 1), &sealed).is_err());
        assert!(crypto::open(
            &key,
            &share_aad(&uuid::Uuid::new_v4().to_string(), 0),
            &sealed
        )
        .is_err());
        assert_eq!(
            crypto::open(&key, &share_aad(&id, 0), &sealed)
                .unwrap()
                .as_slice(),
            b"head"
        );
    }

    /// A shared conversation carries the turns the person saw and nothing
    /// else: no system or tool message, no attached context, no inline bytes,
    /// and chat blocks kept as the fenced JSON the reader renders.
    #[test]
    fn a_shared_conversation_carries_only_visible_text() {
        let block = "Here are two places.\n```subrosa:places\n{\"v\":1,\"places\":[]}\n```";
        let turns = vec![
            (
                "system".to_string(),
                "You are Sub Rosa. Secret rules.".to_string(),
            ),
            (
                "user".to_string(),
                "Find me a café\n\n--- Attached Context ---\nnote: private".to_string(),
            ),
            ("tool".to_string(), "{\"results\":[1,2,3]}".to_string()),
            ("assistant".to_string(), block.to_string()),
            (
                "user".to_string(),
                "Look: ![x](data:image/png;base64,AAAA) thanks".to_string(),
            ),
            ("assistant".to_string(), "   ".to_string()),
        ];
        let shared = visible_turns(turns);
        assert_eq!(
            shared,
            vec![
                SharedMessage {
                    role: "user".into(),
                    content: "Find me a café".into()
                },
                SharedMessage {
                    role: "assistant".into(),
                    content: block.into()
                },
                SharedMessage {
                    role: "user".into(),
                    content: "Look: ![x]([attachment]) thanks".into()
                },
            ]
        );
        let text = serde_json::to_string(&shared).unwrap();
        assert!(!text.contains("Secret rules"));
        assert!(!text.contains("private"));
        assert!(!text.contains("base64"));
        assert!(!text.contains("results"));
    }

    /// A note's sealed document is unchanged by the conversation kind: no
    /// `messages` key appears, so every reader already deployed still opens it.
    #[test]
    fn a_note_document_keeps_its_shape() {
        let note = serde_json::to_value(SharedDocument {
            v: 1,
            kind: "note".into(),
            title: "T".into(),
            body: "B".into(),
            shared_at: "now".into(),
            messages: None,
        })
        .unwrap();
        assert!(note.get("messages").is_none());
    }

    #[tokio::test]
    async fn a_temporary_chat_is_never_read_for_a_share() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        let task = crate::temporary_chat::create(&pool, "hello", None)
            .await
            .unwrap();
        let refused = stored_turns(&pool, &task).await.err().unwrap();
        assert_eq!(refused.code, "share_temporary");
    }

    /// A window is one of three, so a link cannot be made to outlive the
    /// sentence printed under the button that makes it.
    #[test]
    fn a_window_is_one_of_three() {
        assert!(WINDOW_HOURS.contains(&24));
        assert!(!WINDOW_HOURS.contains(&0));
        assert!(!WINDOW_HOURS.contains(&(24 * 365)));
    }
}
