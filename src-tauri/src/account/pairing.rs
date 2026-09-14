//! Device admission through a short-lived, physically transferred secret.
//! The service sees only an opaque encrypted vault-key envelope. The QR/code
//! authenticates the secret out of band; a relay cannot substitute its key.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};

const PENDING: &str = "pairing-request";
const PREFIX: &str = "srpair1.";
const MAX_CODE_BYTES: usize = 2048;

#[derive(Serialize)]
pub struct PairingRequest {
    pub request_id: String,
    pub transfer_code: String,
    pub expires_at: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransferWire {
    request_id: String,
    account_id: String,
    secret: String,
}
struct Transfer {
    request_id: String,
    account_id: String,
    secret: Redacted<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredWire {
    request_id: String,
    secret: String,
    expires_at: String,
}
fn invalid() -> AppError {
    AppError::new(
        "pairing_invalid",
        "This device code could not be verified. Start a new request.",
    )
}
fn expired() -> AppError {
    AppError::new(
        "pairing_expired",
        "This device request expired. Start a new request.",
    )
}
fn decode_transfer(raw: &str, account_id: &str) -> Result<Transfer, AppError> {
    if raw.len() > MAX_CODE_BYTES {
        return Err(invalid());
    }
    let encoded = raw.trim().strip_prefix(PREFIX).ok_or_else(invalid)?;
    let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?);
    let wire: TransferWire = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let secret = Redacted::new(wire.secret);
    if wire.account_id != account_id {
        return Err(error("account_bound"));
    }
    uuid::Uuid::parse_str(&wire.request_id).map_err(|_| invalid())?;
    uuid::Uuid::parse_str(&wire.account_id).map_err(|_| invalid())?;
    crypto::decode_key(secret.expose_str()).map_err(|_| invalid())?;
    Ok(Transfer {
        request_id: wire.request_id,
        account_id: wire.account_id,
        secret,
    })
}
fn valid_expiry(value: &str) -> Result<DateTime<Utc>, AppError> {
    let expiry = DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid())?
        .with_timezone(&Utc);
    let now = Utc::now();
    if expiry <= now || expiry > now + chrono::Duration::seconds(310) {
        return Err(expired());
    }
    Ok(expiry)
}
fn context(account: &str, request: &str) -> String {
    format!("subrosa:pairing:v1:{account}:{request}")
}

#[tauri::command]
pub async fn account_pairing_start(app: AppHandle) -> Result<PairingRequest, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(&app).await?;
    let s = session(&pool).await?;
    if let Some(previous) = get_secret(&s.base, &s.account.id, PENDING)? {
        if let Ok(wire) = serde_json::from_str::<StoredWire>(previous.expose_str()) {
            // Replace one request at a time. Failure to delete a stale relay row
            // cannot expose its key: it expires server-side and is lost locally.
            if uuid::Uuid::parse_str(&wire.request_id).is_ok() {
                let _ = call(
                    &s,
                    reqwest::Method::DELETE,
                    &format!("/api/v1/pairing/{}", wire.request_id),
                    None,
                )
                .await;
            }
        }
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let secret = crypto::random_key();
    let encoded = Redacted::new(crypto::encode(&*secret));
    let expires_at = (Utc::now() + chrono::Duration::seconds(300)).to_rfc3339();
    // Store before the first network request, so suspension never leaves a
    // server approval whose decryption material was only in a JS promise.
    let stored = Zeroizing::new(
        serde_json::to_string(
            &json!({"request_id":request_id,"secret":encoded.expose_str(),"expires_at":expires_at}),
        )
        .map_err(|_| invalid())?,
    );
    put_secret(&s.base, &s.account.id, PENDING, &stored)?;
    let result = call(
        &s,
        reqwest::Method::POST,
        "/api/v1/pairing",
        Some(json!({"request_id":request_id})),
    )
    .await?;
    let expires_at = result["expires_at"]
        .as_str()
        .ok_or_else(invalid)?
        .to_owned();
    valid_expiry(&expires_at)?;
    let code = Zeroizing::new(serde_json::to_vec(&json!({"request_id":request_id,"account_id":s.account.id,"secret":encoded.expose_str()})).map_err(|_| invalid())?);
    Ok(PairingRequest {
        request_id,
        transfer_code: format!("{PREFIX}{}", crypto::encode(&code)),
        expires_at,
    })
}

#[tauri::command]
pub async fn account_pairing_approve(
    app: AppHandle,
    transfer_code: String,
) -> Result<(), AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(&app).await?;
    let s = session(&pool).await?;
    let raw = Zeroizing::new(transfer_code);
    let transfer = decode_transfer(&raw, &s.account.id)?;
    let confirmed: i64 = query("SELECT recovery_confirmed FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?
        .get("recovery_confirmed");
    if confirmed == 0 {
        return Err(error("recovery_unconfirmed"));
    }
    let key = vault_key(&s)?;
    let secret = crypto::decode_key(transfer.secret.expose_str())?;
    let body = Zeroizing::new(
        serde_json::to_vec(&json!({"v":1,"key":crypto::encode(&*key)})).map_err(|_| invalid())?,
    );
    let envelope = crypto::seal(
        &secret,
        &context(&transfer.account_id, &transfer.request_id),
        &body,
    )?;
    call(
        &s,
        reqwest::Method::POST,
        &format!("/api/v1/pairing/{}/approve", transfer.request_id),
        Some(json!({"envelope":envelope})),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn account_pairing_exchange(
    app: AppHandle,
    request_id: String,
) -> Result<AccountStatus, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    uuid::Uuid::parse_str(&request_id).map_err(|_| invalid())?;
    let pool = pool(&app).await?;
    let s = session(&pool).await?;
    let stored = get_secret(&s.base, &s.account.id, PENDING)?.ok_or_else(expired)?;
    let wire: StoredWire = serde_json::from_str(stored.expose_str()).map_err(|_| invalid())?;
    let secret = Redacted::new(wire.secret);
    if wire.request_id != request_id {
        return Err(invalid());
    }
    if valid_expiry(&wire.expires_at).is_err() {
        remove_secret(&s.base, &s.account.id, PENDING)?;
        return Err(expired());
    }
    let result = call(
        &s,
        reqwest::Method::GET,
        &format!("/api/v1/pairing/{request_id}"),
        None,
    )
    .await?;
    if result["envelope"].is_null() {
        return Err(AppError::new(
            "pairing_pending",
            "Approve this device from an unlocked device.",
        ));
    }
    let envelope = result["envelope"].as_str().ok_or_else(invalid)?;
    if envelope.len() > 4096 {
        return Err(invalid());
    }
    let secret = crypto::decode_key(secret.expose_str())?;
    let clear = crypto::open(&secret, &context(&s.account.id, &request_id), envelope)?;
    let body: Value = serde_json::from_slice(&clear).map_err(|_| invalid())?;
    if body["v"] != 1 {
        return Err(invalid());
    }
    let key = crypto::decode_key(body["key"].as_str().ok_or_else(invalid)?)?;
    if let Ok(existing) = vault_key(&s) {
        if *existing != *key {
            return Err(error("account_conflict"));
        }
    }
    put_secret(&s.base, &s.account.id, "vault", &crypto::encode(&*key))?;
    query("UPDATE account_sync_control SET vault_exists=1,recovery_confirmed=1 WHERE id=1")
        .execute(&pool)
        .await?;
    // A lost acknowledgement is harmless: the installed key is already safe,
    // the envelope expires, and its one-time secret is discarded locally.
    let _ = call(
        &s,
        reqwest::Method::DELETE,
        &format!("/api/v1/pairing/{request_id}"),
        None,
    )
    .await;
    remove_secret(&s.base, &s.account.id, PENDING)?;
    account_status(app).await
}

#[tauri::command]
pub async fn account_pairing_cancel(app: AppHandle, request_id: String) -> Result<(), AppError> {
    let _guard = SESSION_LOCK.lock().await;
    uuid::Uuid::parse_str(&request_id).map_err(|_| invalid())?;
    let s = session(&pool(&app).await?).await?;
    let stored = get_secret(&s.base, &s.account.id, PENDING)?.ok_or_else(expired)?;
    let wire: StoredWire = serde_json::from_str(stored.expose_str()).map_err(|_| invalid())?;
    if wire.request_id != request_id {
        return Err(invalid());
    }
    remove_secret(&s.base, &s.account.id, PENDING)?;
    let _ = call(
        &s,
        reqwest::Method::DELETE,
        &format!("/api/v1/pairing/{request_id}"),
        None,
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ACCOUNT: &str = "10000000-0000-4000-8000-000000000001";
    const REQUEST: &str = "20000000-0000-4000-8000-000000000002";
    fn code(secret: &str) -> String {
        format!(
            "{PREFIX}{}",
            crypto::encode(
                serde_json::to_string(
                    &json!({"request_id":REQUEST,"account_id":ACCOUNT,"secret":secret})
                )
                .unwrap()
                .as_bytes()
            )
        )
    }
    #[test]
    fn transferred_secret_is_account_bound_and_strictly_sized() {
        assert!(decode_transfer(&code(&crypto::encode(&[42; 32])), ACCOUNT).is_ok());
        assert!(decode_transfer(&code(&crypto::encode(&[42; 32])), REQUEST).is_err());
        assert!(decode_transfer(&code("password"), ACCOUNT).is_err());
        assert!(decode_transfer(&"x".repeat(2049), ACCOUNT).is_err());
    }
    #[test]
    fn relay_cannot_substitute_account_or_request() {
        let secret = crypto::random_key();
        let sealed = crypto::seal(&secret, &context(ACCOUNT, REQUEST), b"vault key").unwrap();
        assert!(crypto::open(&secret, &context(REQUEST, ACCOUNT), &sealed).is_err());
        assert!(crypto::open(&crypto::random_key(), &context(ACCOUNT, REQUEST), &sealed).is_err());
        assert_eq!(
            crypto::open(&secret, &context(ACCOUNT, REQUEST), &sealed)
                .unwrap()
                .as_slice(),
            b"vault key"
        );
    }
    #[test]
    fn expired_or_extended_requests_are_rejected() {
        assert!(valid_expiry(&(Utc::now() - chrono::Duration::seconds(1)).to_rfc3339()).is_err());
        assert!(valid_expiry(&(Utc::now() + chrono::Duration::seconds(600)).to_rfc3339()).is_err());
        assert!(valid_expiry(&(Utc::now() + chrono::Duration::seconds(299)).to_rfc3339()).is_ok());
    }
}
