//! Authentication and encrypted synchronization policy; independent of HTTP and storage technology.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subrosa_config::Config;
use subrosa_domain::{
    BlobStore, CarpeDiemPartner, DeviceLogin, DeviceRequest, Error, IdentityProvider,
    IssuanceAssertion, IssuanceClaims, KINDS, Landing, LoginAttempt, NativeLogin, Operation,
    OperationResult, Result, Secret, SecurityEventKind, Session, Share, StartedDevice,
    TokenResponse,
};
use subrosa_persistence::{AppendParams, BlobParams, Repository, VaultParams};
use uuid::Uuid;
mod browser;
pub mod publication;
mod revocations;
/// Shared projects (ADR 0098): the routes call the repository directly, the
/// service has no logic of its own to add over a blind courier.
pub mod space {
    pub use subrosa_persistence::{EpochWrite, InvitationWrite};
}
pub use browser::{
    AdmissionRequest, DEVICE_PROOF_HEADER, DEVICE_PROOF_TYPE, DeviceProof,
    thumbprint as jwk_thumbprint,
};
#[derive(Clone)]
pub struct Service {
    pub config: Arc<Config>,
    pub repository: Repository,
    identity: Arc<dyn IdentityProvider>,
    storage: Arc<dyn BlobStore>,
    ledger: Option<Arc<dyn subrosa_domain::DeletionLedger>>,
    carpe_diem: Option<Arc<dyn CarpeDiemPartner>>,
    /// When the stuck-revocation alarm last went off, in this process.
    revocation_alarm: Arc<std::sync::Mutex<Option<chrono::DateTime<Utc>>>>,
}
/// Where sign-in may send the browser back to. An allowlist rather than a shape
/// test, because the parameter is attacker-supplied and an open redirect on the
/// account origin would be handed a fresh session on arrival.
///
/// Every page the site can show a "sign in again" link from has to be here. It
/// was not, and the link under the account deletion form — the one page where
/// the step-up matters most — answered `invalid_request` instead of signing
/// anybody in.
const RETURN_TO: &[&str] = &[
    "/account",
    "/account/",
    "/account/devices",
    "/account/library",
    "/account/provider",
    "/account/security",
    "/account/top-up",
    "/account/usage",
    // The web client (WP19) offers "sign in" from its own page.
    "/app",
    // An Office add-in signs in from a dialog window, whose session carries
    // the pane's device calls (ADR-0102).
    "/office/session.html",
];

/// How many issuance assertions one account may ask for per minute. A person
/// signs in and asks once per device; anything faster is grinding.
const ASSERTIONS_PER_MINUTE: i32 = 5;

/// How many shares one account may have answering at once. A bound on the
/// public surface, not a product limit anybody should reach: the links expire.
const MAX_LIVE_SHARES: usize = 200;

/// The one page a native sign-in ever lands on. It is a constant, not a
/// parameter: a service that accepts a destination is a service that can be
/// pointed somewhere else.
const NATIVE_RETURN: &str = "/account/devices/return";

/// What the app asks for when it wants a session. `native` picks the sign-in
/// that comes back by itself; the rest is the code flow that still answers.
pub struct StartDevice<'a> {
    pub challenge: &'a str,
    pub name: &'a str,
    pub native: bool,
    pub device_id: Option<Uuid>,
    pub device_secret: Option<&'a str>,
}

/// What the owner asks for. The key is not here, and never will be.
pub struct NewShare {
    pub id: Uuid,
    pub expires_at: chrono::DateTime<Utc>,
    pub blob_ids: Vec<Uuid>,
}

pub fn hash(value: impl AsRef<[u8]>) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}
pub fn random_secret() -> Secret {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    Secret(URL_SAFE_NO_PAD.encode(bytes))
}
impl Service {
    pub fn new(
        config: Config,
        repository: Repository,
        identity: Arc<dyn IdentityProvider>,
        storage: Arc<dyn BlobStore>,
    ) -> Self {
        Self {
            config: Arc::new(config),
            repository,
            identity,
            storage,
            ledger: None,
            carpe_diem: None,
            revocation_alarm: Arc::default(),
        }
    }
    /// Arms the Carpe Diem partner (ADR 0069). Without it the assertion route
    /// answers 404 and revocations wait in the outbox.
    #[must_use]
    pub fn with_carpe_diem(mut self, partner: Option<Arc<dyn CarpeDiemPartner>>) -> Self {
        self.carpe_diem = partner;
        self
    }
    pub fn carpe_diem_enabled(&self) -> bool {
        self.carpe_diem.is_some()
    }
    /// Vouches, to Carpe Diem, that this recently authenticated device of a
    /// verified account may obtain its own key bound to `jkt`. The key itself
    /// is created and delivered by Carpe Diem to the app; it never passes here.
    ///
    /// An app's session on a live device qualifies when it is recent: a
    /// session renewed by the device secret is not (ADR 0056), so a stolen
    /// secret can keep a device signed in but can never mint it a key.
    ///
    /// A browser qualifies only as an admitted browser device (ADR 0096): its
    /// session plus a `proof` signed by its non-extractable device key and
    /// bound to the request body, which holds `jkt`. It need not be recent, which is what lets its short
    /// lived key be renewed while the device stays live, and its assertion
    /// asks Carpe Diem for the browser bound.
    pub async fn carpe_diem_assertion(
        &self,
        session: &Session,
        jkt: &str,
        proof: Option<DeviceProof<'_>>,
    ) -> Result<IssuanceAssertion> {
        let partner = self.carpe_diem.as_ref().ok_or(Error::NotFound)?;
        let browser = match (session.browser, session.device_id, proof) {
            (false, Some(_), _) => {
                Self::recent(session)?;
                None
            }
            (true, None, Some(proof)) => Some(proof),
            _ => return Err(Error::DeviceRequired),
        };
        self.repository
            .rate_limit(
                &hash(format!("carpe-diem-assertion:{}", session.account.id)),
                ASSERTIONS_PER_MINUTE,
            )
            .await?;
        if !valid_thumbprint(jkt) {
            return Err(Error::Invalid);
        }
        let (device_id, bound) = match (browser, session.device_id) {
            (Some(proof), _) => (
                self.browser_device(session, proof, browser::ASSERTION_PATH)
                    .await?,
                Some(partner.browser_bound()),
            ),
            (None, Some(id)) => (id, None),
            (None, None) => return Err(Error::DeviceRequired),
        };
        let name = self
            .repository
            .live_device_name(session.account.id, device_id)
            .await?;
        // Written before signing, and fatal when it fails: a key minted for
        // the account without a line in its history is the one thing this
        // history exists to show.
        self.repository
            .record_security_event(
                session.account.id,
                SecurityEventKind::CarpeDiemKeyRequested,
                Some(device_id),
            )
            .await?;
        partner.issuance_assertion(&IssuanceClaims {
            subject: session.account.id,
            email: session.account.email.clone(),
            device_id,
            device_name: device_name(&name),
            jkt: jkt.into(),
            browser: bound,
        })
    }
    #[must_use]
    pub fn with_deletion_ledger(
        mut self,
        ledger: Option<Arc<dyn subrosa_domain::DeletionLedger>>,
    ) -> Self {
        self.ledger = ledger;
        self
    }
    pub async fn login(&self, return_to: &str, register: bool) -> Result<(String, Secret)> {
        let allowed = RETURN_TO.contains(&return_to);
        let verify = return_to
            .strip_prefix("/account/devices/verify?code=")
            .is_some_and(valid_code);
        if !allowed && !verify {
            return Err(Error::Invalid);
        }
        let state = random_secret();
        let browser = random_secret();
        let attempt = LoginAttempt {
            state_hash: hash(state.expose()),
            browser_hash: hash(browser.expose()),
            verifier: random_secret(),
            nonce: random_secret(),
            return_to: return_to.into(),
            native_request_id: None,
        };
        let url = self
            .identity
            .authorization_url(&attempt, state.expose(), register)?;
        self.repository.save_attempt(&attempt).await?;
        Ok((url, browser))
    }
    pub async fn callback(&self, state: &str, browser: &str, code: &str) -> Result<Landing> {
        if state.len() > 128 || code.len() > 4096 {
            return Err(Error::Invalid);
        }
        let attempt = self
            .repository
            .consume_attempt(&hash(state), &hash(browser))
            .await?;
        let identity = self.identity.exchange(&attempt, code).await?;
        // Which flow is finishing comes from the row this single-use state just
        // consumed. Nothing the caller supplied is consulted.
        if let Some(request_id) = attempt.native_request_id {
            let return_code = random_secret();
            self.repository
                .native_callback(&identity, request_id, &hash(return_code.expose()))
                .await?;
            // Every part the app needs rides in the fragment, which reaches
            // neither this service nor a Referer header, the same discipline the
            // pairing QR already uses.
            return Ok(Landing::Native {
                return_to: format!(
                    "{}{}#c={}&r={request_id}",
                    self.config.public_url,
                    attempt.return_to,
                    return_code.expose()
                ),
            });
        }
        let token = random_secret();
        self.repository
            .browser_session(&identity, &hash(token.expose()))
            .await?;
        Ok(Landing::Browser {
            return_to: attempt.return_to,
            token,
        })
    }
    pub async fn authenticate(&self, token: &str, browser: bool) -> Result<Session> {
        if token.len() != 43 {
            return Err(Error::Unauthorized);
        }
        self.repository.session(&hash(token), browser).await
    }
    pub fn recent(session: &Session) -> Result<()> {
        if (Utc::now() - session.authenticated_at).num_seconds() > 300 {
            Err(Error::RecentAuth)
        } else {
            Ok(())
        }
    }
    pub async fn start_device(&self, p: StartDevice<'_>) -> Result<StartedDevice> {
        let challenge = URL_SAFE_NO_PAD
            .decode(p.challenge)
            .map_err(|_| Error::Invalid)?;
        if challenge.len() != 32
            || p.name.trim().is_empty()
            || p.name.len() > 80
            || p.name.chars().any(char::is_control)
        {
            return Err(Error::Invalid);
        }
        // Naming a device to reuse is proved before the request exists, so an
        // unproved id never reaches the exchange.
        let rebind_device_id = match (p.device_id, p.device_secret) {
            (Some(id), Some(secret)) => {
                Some(self.repository.device_for_secret(id, &hash(secret)).await?)
            }
            _ => None,
        };
        let id = Uuid::now_v7();
        if p.native {
            let handle = random_secret();
            let expires = self
                .repository
                .create_device_request(&DeviceRequest {
                    request_id: id,
                    challenge,
                    code_hash: None,
                    start_hash: Some(hash(handle.expose())),
                    name: p.name.into(),
                    rebind_device_id,
                })
                .await?;
            return Ok(StartedDevice::Native(NativeLogin {
                request_id: id,
                start_url: format!(
                    "{}/auth/native/start?request={}",
                    self.config.public_url,
                    handle.expose()
                ),
                expires_at: expires,
            }));
        }
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let code: String = random
            .iter()
            .map(|b| char::from(b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[usize::from(*b) % 32]))
            .collect();
        let expires = self
            .repository
            .create_device_request(&DeviceRequest {
                request_id: id,
                challenge,
                code_hash: Some(hash(&code)),
                start_hash: None,
                name: p.name.into(),
                rebind_device_id,
            })
            .await?;
        Ok(StartedDevice::Code(DeviceLogin {
            request_id: id,
            verification_uri: format!(
                "{}/account/devices/verify?code={code}",
                self.config.public_url
            ),
            user_code: code,
            expires_at: expires,
            interval_seconds: 5,
        }))
    }
    /// Turns a start link into an authorization redirect. It creates an attempt
    /// and nothing else: no session, no approval, and no return code until the
    /// person has actually authenticated.
    pub async fn native_login(&self, handle: &str, register: bool) -> Result<(String, Secret)> {
        if handle.len() != 43 {
            return Err(Error::Invalid);
        }
        let request_id = self
            .repository
            .device_request_by_start(&hash(handle))
            .await?;
        let state = random_secret();
        let browser = random_secret();
        let attempt = LoginAttempt {
            state_hash: hash(state.expose()),
            browser_hash: hash(browser.expose()),
            verifier: random_secret(),
            nonce: random_secret(),
            return_to: NATIVE_RETURN.into(),
            native_request_id: Some(request_id),
        };
        let url = self
            .identity
            .authorization_url(&attempt, state.expose(), register)?;
        self.repository.save_attempt(&attempt).await?;
        Ok((url, browser))
    }
    pub async fn approve(&self, session: &Session, code: &str) -> Result<()> {
        if !session.browser {
            return Err(Error::Forbidden);
        }
        Self::recent(session)?;
        let code = normalize_code(code);
        if !valid_code(&code) {
            return Err(Error::Invalid);
        }
        self.repository.approve_device(session, &hash(code)).await
    }
    pub async fn exchange_device(
        &self,
        id: Uuid,
        verifier: &str,
        return_code: Option<&str>,
    ) -> Result<TokenResponse> {
        if !(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
            || return_code.is_some_and(|c| c.len() != 43)
        {
            return Err(Error::Invalid);
        }
        let access = random_secret();
        let refresh = random_secret();
        let device_secret = random_secret();
        let return_hash = return_code.map(hash);
        let issued = self
            .repository
            .exchange_device(subrosa_persistence::DeviceExchangeParams {
                request_id: id,
                challenge: &hash(verifier),
                return_hash: return_hash.as_deref(),
                access_hash: &hash(access.expose()),
                refresh_hash: &hash(refresh.expose()),
                device_secret_hash: &hash(device_secret.expose()),
            })
            .await?;
        Ok(TokenResponse {
            access_token: access,
            refresh_token: refresh,
            expires_at: issued.expires_at,
            refresh_expires_at: issued.refresh_expires_at,
            device_id: issued.device_id,
            device_secret: Some(device_secret),
            account: issued.account,
        })
    }
    /// The whole point of the device secret: a session again, without a
    /// browser, for as long as the device is not revoked.
    pub async fn renew_session(&self, device_id: Uuid, secret: &str) -> Result<TokenResponse> {
        if secret.len() != 43 {
            return Err(Error::Unauthorized);
        }
        // Bounded per device as well as per address, so one machine cannot grind
        // at a secret while a shared address keeps working for everybody else.
        self.repository
            .rate_limit(&hash(format!("renew:{device_id}")), 10)
            .await?;
        let access = random_secret();
        let refresh = random_secret();
        let issued = self
            .repository
            .renew_session(subrosa_persistence::RenewParams {
                device_id,
                secret_hash: &hash(secret),
                access_hash: &hash(access.expose()),
                refresh_hash: &hash(refresh.expose()),
            })
            .await?;
        Ok(TokenResponse {
            access_token: access,
            refresh_token: refresh,
            expires_at: issued.expires_at,
            refresh_expires_at: issued.refresh_expires_at,
            device_id: issued.device_id,
            device_secret: None,
            account: issued.account,
        })
    }
    pub async fn renounce(&self, device_id: Uuid, secret: &str) -> Result<()> {
        if secret.len() != 43 {
            return Err(Error::Unauthorized);
        }
        self.repository
            .rate_limit(&hash(format!("renew:{device_id}")), 10)
            .await?;
        self.repository
            .renounce_device(device_id, &hash(secret))
            .await
    }
    pub async fn refresh_session(&self, token: &str) -> Result<TokenResponse> {
        if token.len() != 43 {
            return Err(Error::Unauthorized);
        }
        let access = random_secret();
        let refresh = random_secret();
        let issued = self
            .repository
            .refresh_session(subrosa_persistence::RefreshParams {
                refresh_hash: &hash(token),
                new_access_hash: &hash(access.expose()),
                new_refresh_hash: &hash(refresh.expose()),
            })
            .await?;
        Ok(TokenResponse {
            access_token: access,
            refresh_token: refresh,
            expires_at: issued.expires_at,
            refresh_expires_at: issued.refresh_expires_at,
            device_id: issued.device_id,
            device_secret: None,
            account: issued.account,
        })
    }
    pub async fn changes(
        &self,
        session: &Session,
        after: i64,
        limit: i64,
        kind: Option<&str>,
    ) -> Result<subrosa_domain::JournalPage> {
        if after < 0
            || !(1..=500).contains(&limit)
            || kind.is_some_and(|value| !KINDS.contains(&value))
        {
            return Err(Error::Invalid);
        }
        self.repository
            .changes(subrosa_persistence::PageParams {
                owner: session.account.id,
                after,
                limit,
                kind,
            })
            .await
    }
    pub async fn append(
        &self,
        session: &Session,
        operations: Vec<Operation>,
    ) -> Result<Vec<OperationResult>> {
        if operations.is_empty() || operations.len() > 100 {
            return Err(Error::Invalid);
        }
        let mut checked = Vec::new();
        let mut bytes = 0;
        for op in operations {
            if op.resolved_revisions.len() > 64
                || !KINDS.contains(&op.kind.as_str())
                || op.ciphertext.is_empty()
                || op.ciphertext.len() > 1024 * 1024
            {
                return Err(Error::Invalid);
            }
            // Ciphertexts may use the versioned JSON envelope or base64; contents remain opaque.
            bytes += op.ciphertext.len();
            if bytes > 4 * 1024 * 1024 {
                return Err(Error::Invalid);
            }
            let digest = hash(serde_json::to_vec(&op).map_err(|_| Error::Invalid)?);
            checked.push((op, digest));
        }
        self.repository
            .append(AppendParams {
                session,
                operations: &checked,
                quota: self.config.account_quota_bytes,
            })
            .await
    }
    pub async fn save_vault(
        &self,
        session: &Session,
        expected: i64,
        envelope: &serde_json::Value,
        admission_verifier: Option<&str>,
    ) -> Result<i64> {
        if expected < 0
            || expected == i64::MAX
            || envelope.as_str().is_none_or(str::is_empty)
            || serde_json::to_vec(envelope)
                .map_err(|_| Error::Invalid)?
                .len()
                > 256 * 1024
        {
            return Err(Error::Invalid);
        }
        let verifier = admission_verifier
            .map(|value| {
                URL_SAFE_NO_PAD
                    .decode(value)
                    .ok()
                    .filter(|bytes| bytes.len() == 32)
                    .ok_or(Error::Invalid)
            })
            .transpose()?;
        // A verifier admits browsers as devices (ADR 0096). The one written
        // with a new vault comes from whoever just made its recovery key;
        // replacing it later asks for a sign-in minutes old, the bar every
        // other way of adding a device already has.
        if verifier.is_some() && expected > 0 {
            Self::recent(session)?;
        }
        self.repository
            .save_vault(VaultParams {
                owner: session.account.id,
                expected,
                envelope,
                quota: self.config.account_quota_bytes,
                admission_verifier: verifier.as_deref(),
            })
            .await
    }
    pub async fn upload_blob(
        &self,
        session: &Session,
        id: Uuid,
        content: Vec<u8>,
    ) -> Result<usize> {
        if content.is_empty() || content.len() > 32 * 1024 * 1024 {
            return Err(Error::Invalid);
        }
        let bytes = content.len();
        let digest = hash(&content);
        let reservation = self
            .repository
            .reserve_blob(BlobParams {
                owner: session.account.id,
                id,
                bytes: i64::try_from(bytes).map_err(|_| Error::Invalid)?,
                digest: &digest,
                quota: self.config.account_quota_bytes,
            })
            .await?;
        self.storage
            .put(&format!("{}/{id}", session.account.id), content)
            .await?;
        reservation.commit().await?;
        Ok(bytes)
    }
    pub async fn blob(&self, session: &Session, id: Uuid) -> Result<Vec<u8>> {
        self.repository.blob_exists(session.account.id, id).await?;
        self.storage
            .get(&format!("{}/{id}", session.account.id))
            .await
    }
    /// Publishes blobs the account already uploaded as one readable share.
    ///
    /// The deadline is bounded on both sides. A share that expires immediately
    /// is a mistake; one that never expires is the thing ADR 0050 says cannot
    /// be taken back, left running forever. Thirty days is the longest the
    /// surface offers, so the longest the API accepts.
    pub async fn create_share(&self, session: &Session, p: NewShare) -> Result<Share> {
        let live = self.repository.shares(session.account.id).await?.len();
        if p.blob_ids.is_empty() || p.blob_ids.len() > 2049 || live >= MAX_LIVE_SHARES {
            return Err(Error::Invalid);
        }
        let window = p.expires_at - Utc::now();
        if window < chrono::TimeDelta::minutes(1) || window > chrono::TimeDelta::days(30) {
            return Err(Error::Invalid);
        }
        self.repository
            .create_share(subrosa_persistence::ShareParams {
                owner: session.account.id,
                id: p.id,
                expires_at: p.expires_at,
                blob_ids: &p.blob_ids,
            })
            .await
    }
    /// Reads one piece of a share for whoever holds the link.
    ///
    /// There is no session here on purpose: a share is opened by a key the
    /// service never had. What it must not become is a way to read arbitrary
    /// bytes, so the position is resolved against this share and the owner it
    /// names, never against a blob id the caller chose.
    pub async fn share_blob(&self, id: Uuid, position: i32) -> Result<Vec<u8>> {
        if position < 0 {
            return Err(Error::Invalid);
        }
        let (owner, blob) = self.repository.share_blob(id, position).await?;
        self.storage.get(&format!("{owner}/{blob}")).await
    }
    pub async fn delete_account(&self, session: &Session) -> Result<()> {
        Self::recent(session)?;
        if let Some(ledger) = &self.ledger {
            ledger
                .record(&subrosa_domain::DeletionRecord {
                    version: 1,
                    account_id: session.account.id,
                    deleted_at: Utc::now(),
                })
                .await?;
        }
        self.repository.delete_account(session.account.id).await
    }
    /// The periodic loop. Deletion replay runs first because a restored account
    /// must be erased before anything else; revocations are delivered even when
    /// replay failed, since a dead link to the ledger is no reason to keep a
    /// Carpe Diem key alive.
    pub async fn maintenance(&self) -> Result<()> {
        let replay = maintain(
            &self.repository,
            self.storage.as_ref(),
            self.ledger.as_deref(),
        )
        .await;
        let delivery = self.deliver_revocations().await;
        replay.and(delivery)
    }
}
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(char::to_uppercase)
        .collect()
}
/// At most 64 Unicode scalar values, the unit Carpe Diem counts in too. A name
/// is a label, so cutting it mid-grapheme costs a stray half of an emoji at
/// worst, never a rejected assertion.
fn device_name(name: &str) -> String {
    name.chars().take(64).collect()
}
/// An RFC 7638 SHA-256 thumbprint, base64url without padding: 43 characters
/// that decode to exactly 32 bytes. Anything else is refused before signing.
fn valid_thumbprint(jkt: &str) -> bool {
    jkt.len() == 43
        && URL_SAFE_NO_PAD
            .decode(jkt)
            .is_ok_and(|bytes| bytes.len() == 32)
}
fn valid_code(code: &str) -> bool {
    code.len() == 8
        && code
            .bytes()
            .all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&b))
}

/// Replays deletion intent without requiring the external identity provider to be online.
pub async fn maintain(
    repository: &Repository,
    storage: &dyn BlobStore,
    ledger: Option<&dyn subrosa_domain::DeletionLedger>,
) -> Result<()> {
    if let Some(ledger) = ledger {
        let mut cursor = None;
        loop {
            let page = ledger.page(cursor.as_deref()).await?;
            if page.records.is_empty() {
                break;
            }
            for record in page.records {
                repository.reapply_deletion(record.account_id).await?;
            }
            cursor = page.cursor;
        }
    }
    // Expired and revoked shares stop answering the moment the clock passes
    // them; this is what hands their bytes back to the quota.
    repository.release_shares().await?;
    repository.prune_auth().await?;
    repository.prune_reports().await?;
    for key in repository.cleanup_keys().await? {
        storage.delete(&key).await?;
        repository.cleaned_key(&key).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{RETURN_TO, device_name, valid_thumbprint};

    /// Emoji, accents and CJK are several bytes each; the limit is in code
    /// points, and nothing longer than 64 of them ever leaves the service.
    #[test]
    fn a_device_name_never_exceeds_sixty_four_code_points() {
        for name in [
            "📱".repeat(80),
            "é".repeat(100),
            "東京のノートパソコン".repeat(10),
            "👩\u{200d}💻 Morgan's MacBook ".repeat(8),
            "a".repeat(64),
        ] {
            let cut = device_name(&name);
            assert!(cut.chars().count() <= 64, "{name}");
            assert!(name.starts_with(&cut), "a prefix, not a rewrite");
        }
        assert_eq!(device_name("Phone 📱"), "Phone 📱");
        assert_eq!(device_name(&"📱".repeat(80)).chars().count(), 64);
    }

    #[test]
    fn a_thumbprint_is_exactly_a_base64url_sha256() {
        assert!(valid_thumbprint(
            "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
        ));
        for bad in [
            "",
            "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4",
            "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I=",
            "0ZcOCORZNYy+DWpqq30jZyJGHTN0d2HglBV3uiguA4I",
            "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I0",
        ] {
            assert!(!valid_thumbprint(bad), "{bad}");
        }
    }

    /// The app opens the top-up page and the page offers "sign in" from it.
    /// Without this entry that link answered `invalid_request`.
    #[test]
    fn the_top_up_page_can_be_returned_to_after_sign_in() {
        assert!(RETURN_TO.contains(&"/account/top-up"));
    }

    /// The web client offers "sign in" from `/app`, and lands back on it.
    #[test]
    fn the_web_client_can_be_returned_to_after_sign_in() {
        assert!(RETURN_TO.contains(&"/app"));
    }

    /// An Office add-in's sign-in window lands back on itself (ADR-0102).
    #[test]
    fn the_office_sign_in_window_can_be_returned_to_after_sign_in() {
        assert!(RETURN_TO.contains(&"/office/session.html"));
    }
}
