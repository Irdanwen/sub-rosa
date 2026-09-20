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
/// for a note it is the whole share.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SharedDocument {
    v: u8,
    kind: String,
    title: String,
    body: String,
    shared_at: String,
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
    let id = uuid::Uuid::new_v4().to_string();
    let key = crypto::random_key();
    let document = serde_json::to_vec(&SharedDocument {
        v: 1,
        kind: "note".into(),
        title: title.clone(),
        body,
        shared_at: chrono::Utc::now().to_rfc3339(),
    })
    .map_err(|_| share_error())?;
    let head = put_piece(&s, crypto::seal(&key, &share_aad(&id, 0), &document)?).await?;
    let expires_at = (chrono::Utc::now() + chrono::Duration::hours(window_hours)).to_rfc3339();
    call(
        &s,
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
        .execute(&pool)
        .await?;
    Ok(ShareLink {
        url: format!("{}/s/{id}#k={}", s.base, crypto::encode(key.as_slice())),
        id,
        expires_at,
    })
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

    /// A window is one of three, so a link cannot be made to outlive the
    /// sentence printed under the button that makes it.
    #[test]
    fn a_window_is_one_of_three() {
        assert!(WINDOW_HOURS.contains(&24));
        assert!(!WINDOW_HOURS.contains(&0));
        assert!(!WINDOW_HOURS.contains(&(24 * 365)));
    }
}
