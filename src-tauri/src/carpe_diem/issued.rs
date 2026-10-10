//! Device keys: a Carpe Diem key created for this device on the strength of
//! the Sub Rosa account, so a person with an email address and nothing else
//! can start (ADR-0069, `docs/carpe-diem-partner-contract.md`).
//!
//! Three parties, and the shape is chosen so the middle one never sees the key:
//!
//! 1. This app makes a P-256 key pair that lives in memory for one attempt and
//!    is never written anywhere. Its thumbprint (`jkt`) goes to the account
//!    service, which answers with a two minute assertion naming the account,
//!    the device and that thumbprint.
//! 2. The app hands the assertion to Carpe Diem together with a proof signed by
//!    the private half. Carpe Diem mints the key inside its enclave and returns
//!    it on that connection only.
//! 3. The key is checked against `/credits`, then stored exactly like a key
//!    restored from the vault, with one extra word next to it: `issued`.
//!
//! A stolen assertion is useless without the private half, which never left
//! this process. When Carpe Diem already knows the email from somewhere else it
//! asks the person to confirm by mail before linking; the key pair then has to
//! survive the wait, so it is held here, in memory, and a restart simply means
//! starting again.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use zeroize::Zeroizing;

use super::settings;
use crate::{domain::types::AppError, redacted::Redacted};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Carpe Diem's revocation cutoff counts whole seconds: an assertion signed
/// after this wait is past it.
const REVOKED_RETRY_AFTER: Duration = Duration::from_millis(1_100);

// --- The ephemeral key ------------------------------------------------------

/// One issuance attempt's key pair. Dropping it is the only way it ends.
pub(crate) struct Ephemeral {
    key: SigningKey,
    x: String,
    y: String,
}

impl Ephemeral {
    pub(crate) fn generate() -> Self {
        loop {
            // Rejection sampling: a 32 byte string is a valid scalar unless it
            // is zero or above the group order, which is vanishingly rare.
            let bytes = Zeroizing::new(rand::random::<[u8; 32]>());
            let field = p256::FieldBytes::from(*bytes);
            if let Ok(key) = SigningKey::from_bytes(&field) {
                return Self::from_key(key);
            }
        }
    }

    fn from_key(key: SigningKey) -> Self {
        let point = key.verifying_key().to_encoded_point(false);
        let coordinate = |c: Option<&p256::FieldBytes>| {
            c.map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                .unwrap_or_default()
        };
        Self {
            x: coordinate(point.x()),
            y: coordinate(point.y()),
            key,
        }
    }

    /// RFC 7638 thumbprint: SHA-256 over the required members, in
    /// lexicographic order, with no whitespace.
    pub(crate) fn jkt(&self) -> String {
        jkt_of(&self.x, &self.y)
    }

    fn public_jwk(&self) -> Value {
        json!({"kty":"EC","crv":"P-256","x":self.x,"y":self.y})
    }

    /// A DPoP style proof for one request, bound to `bound` (the assertion,
    /// or the link request id when polling).
    pub(crate) fn proof(&self, htu: &str, bound: &str, now: i64) -> String {
        let header = json!({"alg":"ES256","typ":"dpop+jwt","jwk":self.public_jwk()});
        let claims = json!({
            "htm": "POST",
            "htu": htu,
            "iat": now,
            "jti": uuid::Uuid::new_v4().to_string(),
            "ath": URL_SAFE_NO_PAD.encode(Sha256::digest(bound.as_bytes())),
        });
        compact_jws(&header, &claims, &self.key)
    }
}

pub(crate) fn jkt_of(x: &str, y: &str) -> String {
    let canonical = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
    URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()))
}

/// Compact JWS, ES256: the signature is the raw 64 byte `r || s`, not DER.
fn compact_jws(header: &Value, claims: &Value, key: &SigningKey) -> String {
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature: Signature = key.sign(input.as_bytes());
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

// --- Where Carpe Diem answers -------------------------------------------------

/// The operator root that partner routes hang off, from the configured base:
/// `…/api/operator/router` and `…/api/operator/v1` both become
/// `…/api/operator`. The proof's `htu` is built from it, and Carpe Diem
/// compares it byte for byte, so this is the only place it is derived.
pub(crate) fn partner_root(base: &str) -> String {
    settings::operator_root_of(base.trim())
}

fn client() -> Result<reqwest::Client, AppError> {
    // Carpe Diem is called at one address and answers there; a redirect on a
    // request carrying an assertion is refused rather than followed.
    crate::http_client::credentialed(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| unreachable_error())
}

async fn read_json(mut response: reqwest::Response) -> Result<(u16, Value), AppError> {
    let status = response.status().as_u16();
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| unreachable_error())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(rejected_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

fn record(host_of: &str, started: Instant, status: u16) {
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(host_of)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default(),
        purpose: "Carpe Diem device key".into(),
        method: "POST".into(),
        request_bytes: 0,
        response_bytes: 0,
        status: Some(status),
        duration_ms: started.elapsed().as_millis() as u64,
        model: None,
        note_id: None,
    });
}

// --- Errors, in the words a person reads -------------------------------------

fn unreachable_error() -> AppError {
    AppError::new(
        "carpe_diem_issue_unreachable",
        "Carpe Diem could not be reached. Check your connection and try again.",
    )
}
fn rejected_error() -> AppError {
    AppError::new(
        "carpe_diem_issue_rejected",
        "Carpe Diem did not accept this request. Try again in a moment.",
    )
}
fn unavailable_error() -> AppError {
    AppError::new(
        "carpe_diem_issue_unavailable",
        "Creating a key from your account is not available yet. Paste a Carpe Diem key instead.",
    )
}
fn expired_error() -> AppError {
    AppError::new(
        "carpe_diem_link_expired",
        "The confirmation expired. Start again to get a new code.",
    )
}

/// The outcome of one exchange with `/partner/keys` or its poll, before
/// anything is stored. Pure so the mapping is testable without a network.
#[derive(Debug, PartialEq)]
pub(crate) enum Answer {
    Issued {
        key: Redacted<String>,
        key_id: String,
    },
    Confirm {
        link_request_id: String,
        code: String,
        expires_at: String,
        email_hint: Option<String>,
    },
    Pending,
    Replayed,
    /// The assertion was signed in the very second Carpe Diem cut the
    /// account's keys off (its cutoff counts whole seconds). Carpe Diem asks
    /// for a fresh one, signed after that second.
    Revoked,
}

pub(crate) fn interpret(status: u16, body: &Value) -> Result<Answer, AppError> {
    let code = body["code"].as_str().unwrap_or("");
    match status {
        201 => {
            let key = body["key"].as_str().unwrap_or("");
            let key_id = body["keyId"].as_str().unwrap_or("");
            if !key.starts_with("cdm_")
                || key.len() > 256
                || key.chars().any(|c| !c.is_ascii_alphanumeric() && c != '_')
                || key_id.is_empty()
                || key_id.len() > 100
            {
                return Err(rejected_error());
            }
            Ok(Answer::Issued {
                key: Redacted::new(key.to_string()),
                key_id: key_id.to_string(),
            })
        }
        202 if body["status"] == "pending" => Ok(Answer::Pending),
        202 => {
            let id = body["linkRequestId"].as_str().unwrap_or("");
            let code = body["code"].as_str().unwrap_or("");
            let expires_at = body["expiresAt"].as_str().unwrap_or("");
            if uuid::Uuid::parse_str(id).is_err()
                || code.len() != 6
                || !code.chars().all(|c| c.is_ascii_alphanumeric())
                || chrono::DateTime::parse_from_rfc3339(expires_at).is_err()
            {
                return Err(rejected_error());
            }
            Ok(Answer::Confirm {
                link_request_id: id.to_string(),
                code: code.to_ascii_uppercase(),
                expires_at: expires_at.to_string(),
                email_hint: body["emailHint"]
                    .as_str()
                    .filter(|hint| hint.len() <= 320)
                    .map(str::to_string),
            })
        }
        404 => Err(unavailable_error()),
        409 if code == "ASSERTION_REPLAYED" => Ok(Answer::Replayed),
        403 if code == "ASSERTION_REVOKED" => Ok(Answer::Revoked),
        429 => Err(AppError::new(
            "carpe_diem_issue_limited",
            "Your account created several keys recently. Try again tomorrow, or revoke a device you no longer use.",
        )),
        503 => Err(AppError::new(
            "carpe_diem_issue_paused",
            "Carpe Diem has paused creating keys for a moment. Try again later.",
        )),
        403 if code == "LINK_DECLINED" => Err(AppError::new(
            "carpe_diem_link_declined",
            "The link was declined from the confirmation page. Nothing was created.",
        )),
        410 => Err(expired_error()),
        _ => Err(rejected_error()),
    }
}

// --- The one attempt held across a confirmation --------------------------------

struct Pending {
    base: String,
    ephemeral: Ephemeral,
    link_request_id: String,
    code: String,
    expires_at: String,
    email_hint: Option<String>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn pending_lock() -> std::sync::MutexGuard<'static, Option<Pending>> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner())
}

/// What the screen is told. The key never appears in it.
#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IssueOutcome {
    /// `"issued"` or `"confirmation_required"`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_hint: Option<String>,
}

impl IssueOutcome {
    fn issued() -> Self {
        Self {
            status: "issued",
            code: None,
            expires_at: None,
            email_hint: None,
        }
    }
    fn waiting(pending: &Pending) -> Self {
        Self {
            status: "confirmation_required",
            code: Some(pending.code.clone()),
            expires_at: Some(pending.expires_at.clone()),
            email_hint: pending.email_hint.clone(),
        }
    }
}

// --- Capabilities -------------------------------------------------------------

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssuanceStatus {
    /// Carpe Diem says it can create keys for Sub Rosa accounts.
    pub key_issuance: bool,
    /// Carpe Diem sells credits by card.
    pub fiat: bool,
    /// The stored key was issued for this device.
    pub issued: bool,
    /// A confirmation is waiting on the person's mail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<IssueOutcome>,
    /// Countries where Carpe Diem sells nothing (ISO 3166-1 alpha-2). A pay
    /// link shown there would only land on a refusal, so the app does not
    /// offer one. The published list when Carpe Diem cannot be asked.
    pub blocked_countries: Vec<String>,
}

/// What Carpe Diem says it can do here.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Capabilities {
    pub key_issuance: bool,
    pub fiat: bool,
    pub blocked_countries: Vec<String>,
}

/// Carpe Diem's purchase refusals as published, used only when it cannot be
/// asked: sanctioned jurisdictions and the United States.
pub(crate) const DEFAULT_BLOCKED_COUNTRIES: &[&str] =
    &["IR", "KP", "CU", "SY", "SD", "SS", "MM", "RU", "BY", "US"];

impl Capabilities {
    fn none() -> Self {
        Self {
            key_issuance: false,
            fiat: false,
            blocked_countries: DEFAULT_BLOCKED_COUNTRIES
                .iter()
                .map(|c| (*c).to_string())
                .collect(),
        }
    }
}

/// Parses `/partner/capabilities`. Anything but a clear yes is a no, so a
/// Carpe Diem that has not shipped the routes yet hides the new paths instead
/// of offering a button that fails.
pub(crate) fn parse_capabilities(status: u16, body: &Value) -> Capabilities {
    if status != 200 {
        return Capabilities::none();
    }
    let blocked = body["blockedCountries"].as_array().map(|list| {
        list.iter()
            .filter_map(Value::as_str)
            .map(|c| c.trim().to_ascii_uppercase())
            .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()))
            .take(300)
            .collect::<Vec<_>>()
    });
    Capabilities {
        key_issuance: body["keyIssuance"] == true,
        fiat: body["fiat"] == true,
        blocked_countries: blocked.unwrap_or_else(|| Capabilities::none().blocked_countries),
    }
}

pub(crate) async fn capabilities(base: &str) -> Capabilities {
    let Ok(client) = crate::http_client::anonymous(Duration::from_secs(8)).build() else {
        return Capabilities::none();
    };
    let url = format!("{}/partner/capabilities", partner_root(base));
    let Ok(response) = client.get(url).send().await else {
        return Capabilities::none();
    };
    match read_json(response).await {
        Ok((status, body)) => parse_capabilities(status, &body),
        Err(_) => Capabilities::none(),
    }
}

#[tauri::command]
pub async fn carpe_diem_issuance_status() -> Result<IssuanceStatus, AppError> {
    let base = settings::base_url();
    let caps = capabilities(&base).await;
    let pending = {
        let mut guard = pending_lock();
        if guard.as_ref().is_some_and(|p| !alive(&p.expires_at)) {
            *guard = None;
        }
        guard.as_ref().map(IssueOutcome::waiting)
    };
    Ok(IssuanceStatus {
        key_issuance: caps.key_issuance,
        fiat: caps.fiat,
        blocked_countries: caps.blocked_countries,
        issued: settings::issued_meta().is_some() && settings::api_key().is_some(),
        pending,
    })
}

fn alive(at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(at).is_ok_and(|at| at > chrono::Utc::now())
}

// --- Issuing ------------------------------------------------------------------

async fn post_keys(
    base: &str,
    ephemeral: &Ephemeral,
    assertion: &Redacted<String>,
) -> Result<Answer, AppError> {
    let htu = format!("{}/partner/keys", partner_root(base));
    let proof = ephemeral.proof(&htu, assertion.expose_str(), chrono::Utc::now().timestamp());
    let started = Instant::now();
    let response = client()?
        .post(&htu)
        .header(
            "Authorization",
            format!("PartnerAssertion {}", assertion.expose_str()),
        )
        .header("DPoP", proof)
        .json(&json!({}))
        .send()
        .await
        .map_err(|_| unreachable_error())?;
    let (status, body) = read_json(response).await?;
    record(&htu, started, status);
    interpret(status, &body)
}

async fn post_poll(base: &str, pending: &Pending) -> Result<Answer, AppError> {
    let htu = format!("{}/partner/keys/poll", partner_root(base));
    let proof = pending.ephemeral.proof(
        &htu,
        &pending.link_request_id,
        chrono::Utc::now().timestamp(),
    );
    let started = Instant::now();
    let response = client()?
        .post(&htu)
        .header("DPoP", proof)
        .json(&json!({"linkRequestId": pending.link_request_id}))
        .send()
        .await
        .map_err(|_| unreachable_error())?;
    let (status, body) = read_json(response).await?;
    record(&htu, started, status);
    interpret(status, &body)
}

async fn activate(
    app: &AppHandle,
    base: &str,
    key: Redacted<String>,
    key_id: String,
) -> Result<(), AppError> {
    settings::activate_verified_credential(
        app,
        base,
        key.expose_str(),
        Some(&settings::IssuedMeta { key_id }),
    )
    .await
}

/// Creates this device's key. Needs a sign-in less than five minutes old: the
/// account service refuses an older one, and the screen then asks for a fresh
/// sign-in and calls this again.
#[tauri::command]
pub async fn carpe_diem_issue_key(app: AppHandle) -> Result<IssueOutcome, AppError> {
    let base = settings::base_url();
    // Two tries at most: a replayed assertion (a retried request that already
    // landed), or one signed in the second Carpe Diem revoked the account's
    // keys, is answered with a fresh one, never looped on.
    for _ in 0..2 {
        let ephemeral = Ephemeral::generate();
        let assertion = crate::account::carpe_diem_link::assertion(&app, &ephemeral.jkt()).await?;
        match post_keys(&base, &ephemeral, &assertion).await? {
            Answer::Issued { key, key_id } => {
                *pending_lock() = None;
                activate(&app, &base, key, key_id).await?;
                return Ok(IssueOutcome::issued());
            }
            Answer::Confirm {
                link_request_id,
                code,
                expires_at,
                email_hint,
            } => {
                let pending = Pending {
                    base: base.clone(),
                    ephemeral,
                    link_request_id,
                    code,
                    expires_at,
                    email_hint,
                };
                let outcome = IssueOutcome::waiting(&pending);
                *pending_lock() = Some(pending);
                return Ok(outcome);
            }
            Answer::Pending => return Err(rejected_error()),
            Answer::Replayed => continue,
            Answer::Revoked => {
                tokio::time::sleep(REVOKED_RETRY_AFTER).await;
                continue;
            }
        }
    }
    Err(rejected_error())
}

/// Asks whether the person confirmed by mail. The screen calls it while it is
/// visible; nothing here runs in the background (ADR-0018: a suspended phone
/// simply resumes the question when it comes back).
#[tauri::command]
pub async fn carpe_diem_issue_poll(app: AppHandle) -> Result<IssueOutcome, AppError> {
    // The attempt is taken out while the request is in flight so two polls
    // cannot both activate a key; it is put back if the answer is "not yet".
    let Some(pending) = pending_lock().take() else {
        return Err(expired_error());
    };
    if !alive(&pending.expires_at) {
        return Err(expired_error());
    }
    let answer = post_poll(&pending.base, &pending).await;
    match answer {
        Ok(Answer::Issued { key, key_id }) => {
            let base = pending.base.clone();
            drop(pending);
            activate(&app, &base, key, key_id).await?;
            Ok(IssueOutcome::issued())
        }
        Ok(Answer::Pending) | Ok(Answer::Confirm { .. }) => {
            let outcome = IssueOutcome::waiting(&pending);
            *pending_lock() = Some(pending);
            Ok(outcome)
        }
        // A network blip keeps the attempt: the person may be mid-click.
        Err(failure) if failure.code == "carpe_diem_issue_unreachable" => {
            *pending_lock() = Some(pending);
            Err(failure)
        }
        Ok(Answer::Replayed) | Ok(Answer::Revoked) => Err(rejected_error()),
        Err(failure) => Err(failure),
    }
}

#[tauri::command]
pub fn carpe_diem_issue_cancel() {
    *pending_lock() = None;
}

/// Revokes this device's issued key at Carpe Diem, then forgets it here.
/// Revocation is best effort (the account service also revokes it when the
/// device is signed out), the local clear is not.
#[tauri::command]
pub async fn carpe_diem_revoke_issued_key(app: AppHandle) -> Result<(), AppError> {
    forget_issued_key(&app).await
}

/// Called on sign-out, device revocation and account deletion: an issued key
/// belongs to the account, so it does not outlive this device's place in it.
/// A pasted or restored key is left alone.
pub(crate) async fn forget_issued_key(app: &AppHandle) -> Result<(), AppError> {
    *pending_lock() = None;
    if settings::issued_meta().is_none() {
        return Ok(());
    }
    if let Some((base, key)) = settings::credentials() {
        self_revoke(&base, &key).await;
    }
    settings::carpe_diem_clear_api_key(app.clone())
        .await
        .map(|_| ())
}

async fn self_revoke(base: &str, key: &Redacted<String>) {
    let url = format!("{}/v1/keys/self/revoke", partner_root(base));
    let Ok(client) = client() else {
        return;
    };
    let started = Instant::now();
    match client
        .post(&url)
        .bearer_auth(key.expose_str())
        .json(&json!({}))
        .send()
        .await
    {
        Ok(response) => record(&url, started, response.status().as_u16()),
        Err(_) => tracing::warn!("issued key self revocation deferred to the account service"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    /// RFC 9449 §6.1 publishes this key's thumbprint; matching it proves the
    /// member order and encoding, which is the part that is easy to get
    /// silently wrong.
    #[test]
    fn thumbprint_matches_the_rfc_vector() {
        assert_eq!(
            jkt_of(
                "l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs",
                "9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA"
            ),
            "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
        );
    }

    fn decode(part: &str) -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
    }

    #[test]
    fn a_proof_verifies_under_the_key_it_carries() {
        let ephemeral = Ephemeral::generate();
        assert_eq!(ephemeral.jkt().len(), 43);
        let proof = ephemeral.proof("https://op.test/partner/keys", "assertion", 1_790_000_000);
        let parts: Vec<&str> = proof.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header = decode(parts[0]);
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["typ"], "dpop+jwt");
        assert!(header["jwk"].get("d").is_none(), "no private member");
        let claims = decode(parts[1]);
        assert_eq!(claims["htm"], "POST");
        assert_eq!(claims["htu"], "https://op.test/partner/keys");
        assert_eq!(claims["iat"], 1_790_000_000);
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(b"assertion"))
        );
        // Rebuild the public key from the JWK alone, as Carpe Diem does.
        let x = URL_SAFE_NO_PAD
            .decode(header["jwk"]["x"].as_str().unwrap())
            .unwrap();
        let y = URL_SAFE_NO_PAD
            .decode(header["jwk"]["y"].as_str().unwrap())
            .unwrap();
        let mut sec1 = vec![4u8];
        sec1.extend_from_slice(&x);
        sec1.extend_from_slice(&y);
        let verifying = VerifyingKey::from_sec1_bytes(&sec1).unwrap();
        let signature_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(signature_bytes.len(), 64, "raw r||s, not DER");
        let signature = Signature::from_slice(&signature_bytes).unwrap();
        verifying
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
        assert_eq!(
            jkt_of(
                header["jwk"]["x"].as_str().unwrap(),
                header["jwk"]["y"].as_str().unwrap()
            ),
            ephemeral.jkt()
        );
    }

    #[test]
    fn two_attempts_never_share_a_key() {
        assert_ne!(Ephemeral::generate().jkt(), Ephemeral::generate().jkt());
    }

    #[test]
    fn the_partner_root_drops_either_rail() {
        for base in [
            "https://carpe-diem.xyz/api/operator/router",
            "https://carpe-diem.xyz/api/operator/v1",
            "https://carpe-diem.xyz/api/operator/v1/",
            "https://carpe-diem.xyz/api/operator",
        ] {
            assert_eq!(partner_root(base), "https://carpe-diem.xyz/api/operator");
        }
        assert_eq!(
            partner_root("http://127.0.0.1:3001/v1"),
            "http://127.0.0.1:3001"
        );
    }

    #[test]
    fn an_issued_answer_needs_a_key_that_looks_like_one() {
        let ok = interpret(
            201,
            &json!({"status":"issued","key":"cdm_abc123","keyId":"k-1"}),
        )
        .unwrap();
        assert!(matches!(ok, Answer::Issued { ref key_id, .. } if key_id == "k-1"));
        for bad in [
            json!({"key":"sk_abc","keyId":"k"}),
            json!({"key":"cdm_abc"}),
            json!({"key":"cdm_a b","keyId":"k"}),
        ] {
            assert_eq!(
                interpret(201, &bad).unwrap_err().code,
                "carpe_diem_issue_rejected"
            );
        }
    }

    #[test]
    fn a_confirmation_carries_a_code_and_a_deadline() {
        let answer = interpret(
            202,
            &json!({
                "status":"confirmation_required",
                "linkRequestId":"0192f3c4-5d6e-7f80-9123-456789abcdef",
                "code":"k7q2mx",
                "expiresAt":"2030-01-01T00:00:00Z",
                "emailHint":"m***@zssa.ch"
            }),
        )
        .unwrap();
        assert!(matches!(answer, Answer::Confirm { ref code, .. } if code == "K7Q2MX"));
        assert_eq!(
            interpret(202, &json!({"status":"pending"})).unwrap(),
            Answer::Pending
        );
        assert!(interpret(202, &json!({"linkRequestId":"x","code":"ABCDEF"})).is_err());
    }

    #[test]
    fn refusals_map_to_words_a_person_can_act_on() {
        let code = |status, body: Value| interpret(status, &body).unwrap_err().code;
        assert_eq!(code(404, json!({})), "carpe_diem_issue_unavailable");
        assert_eq!(
            code(429, json!({"code":"ISSUANCE_LIMITED"})),
            "carpe_diem_issue_limited"
        );
        assert_eq!(
            code(503, json!({"code":"PARTNER_SUSPENDED"})),
            "carpe_diem_issue_paused"
        );
        assert_eq!(
            code(403, json!({"code":"LINK_DECLINED"})),
            "carpe_diem_link_declined"
        );
        assert_eq!(code(410, json!({})), "carpe_diem_link_expired");
        assert_eq!(
            code(401, json!({"code":"PROOF_INVALID"})),
            "carpe_diem_issue_rejected"
        );
        assert_eq!(
            interpret(409, &json!({"code":"ASSERTION_REPLAYED"})).unwrap(),
            Answer::Replayed
        );
        assert_eq!(
            interpret(403, &json!({"code":"ASSERTION_REVOKED"})).unwrap(),
            Answer::Revoked
        );
        // A revoked device is not one more try away from a key.
        assert_eq!(
            code(403, json!({"code":"DEVICE_REVOKED"})),
            "carpe_diem_issue_rejected"
        );
    }

    #[test]
    fn capabilities_are_a_no_unless_clearly_yes() {
        let yes = parse_capabilities(
            200,
            &json!({"keyIssuance":true,"fiat":true,"blockedCountries":["us","IR","bad1"]}),
        );
        assert!(yes.key_issuance && yes.fiat);
        assert_eq!(yes.blocked_countries, vec!["US", "IR"]);
        let vague = parse_capabilities(200, &json!({"keyIssuance":"yes"}));
        assert!(!vague.key_issuance && !vague.fiat);
        // Silent on the list: the published one, never an empty "sell anywhere".
        assert!(vague.blocked_countries.contains(&"US".to_string()));
        let down = parse_capabilities(404, &json!({"keyIssuance":true}));
        assert!(!down.key_issuance);
        assert_eq!(
            down.blocked_countries.len(),
            DEFAULT_BLOCKED_COUNTRIES.len()
        );
    }

    #[test]
    fn the_outcome_never_serializes_a_key() {
        let json = serde_json::to_string(&IssueOutcome::issued()).unwrap();
        assert_eq!(json, r#"{"status":"issued"}"#);
    }
}

#[cfg(test)]
#[path = "issued_live_tests.rs"]
mod live_tests;
