//! Authentication and encrypted synchronization policy; independent of HTTP and storage technology.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subrosa_config::Config;
use subrosa_domain::{
    BlobStore, DeviceLogin, DeviceRequest, Error, IdentityProvider, KINDS, LoginAttempt, Operation,
    OperationResult, Result, Secret, Session, Share, TokenResponse,
};
use subrosa_persistence::{AppendParams, BlobParams, Repository, VaultParams};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub config: Arc<Config>,
    pub repository: Repository,
    identity: Arc<dyn IdentityProvider>,
    storage: Arc<dyn BlobStore>,
    ledger: Option<Arc<dyn subrosa_domain::DeletionLedger>>,
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
    "/account/usage",
];

/// How many shares one account may have answering at once. A bound on the
/// public surface, not a product limit anybody should reach: the links expire.
const MAX_LIVE_SHARES: usize = 200;

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
        }
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
        };
        let url = self
            .identity
            .authorization_url(&attempt, state.expose(), register)?;
        self.repository.save_attempt(&attempt).await?;
        Ok((url, browser))
    }
    pub async fn callback(
        &self,
        state: &str,
        browser: &str,
        code: &str,
    ) -> Result<(String, Secret)> {
        if state.len() > 128 || code.len() > 4096 {
            return Err(Error::Invalid);
        }
        let attempt = self
            .repository
            .consume_attempt(&hash(state), &hash(browser))
            .await?;
        let identity = self.identity.exchange(&attempt, code).await?;
        let token = random_secret();
        self.repository
            .browser_session(&identity, &hash(token.expose()))
            .await?;
        Ok((attempt.return_to, token))
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
    pub async fn start_device(&self, challenge: &str, name: &str) -> Result<DeviceLogin> {
        let challenge = URL_SAFE_NO_PAD
            .decode(challenge)
            .map_err(|_| Error::Invalid)?;
        if challenge.len() != 32
            || name.trim().is_empty()
            || name.len() > 80
            || name.chars().any(char::is_control)
        {
            return Err(Error::Invalid);
        }
        let mut random = [0u8; 8];
        OsRng.fill_bytes(&mut random);
        let code: String = random
            .iter()
            .map(|b| char::from(b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[usize::from(*b) % 32]))
            .collect();
        let id = Uuid::now_v7();
        let expires = self
            .repository
            .create_device_request(&DeviceRequest {
                request_id: id,
                challenge,
                code_hash: hash(&code),
                name: name.into(),
            })
            .await?;
        Ok(DeviceLogin {
            request_id: id,
            verification_uri: format!(
                "{}/account/devices/verify?code={code}",
                self.config.public_url
            ),
            user_code: code,
            expires_at: expires,
            interval_seconds: 5,
        })
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
    pub async fn exchange_device(&self, id: Uuid, verifier: &str) -> Result<TokenResponse> {
        if !(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        {
            return Err(Error::Invalid);
        }
        let access = random_secret();
        let refresh = random_secret();
        let issued = self
            .repository
            .exchange_device(subrosa_persistence::DeviceExchangeParams {
                request_id: id,
                challenge: &hash(verifier),
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
            account: issued.account,
        })
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
        self.repository
            .save_vault(VaultParams {
                owner: session.account.id,
                expected,
                envelope,
                quota: self.config.account_quota_bytes,
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
    pub async fn maintenance(&self) -> Result<()> {
        maintain(
            &self.repository,
            self.storage.as_ref(),
            self.ledger.as_deref(),
        )
        .await
    }
}
fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(char::to_uppercase)
        .collect()
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
    for key in repository.cleanup_keys().await? {
        storage.delete(&key).await?;
        repository.cleaned_key(&key).await?;
    }
    Ok(())
}
