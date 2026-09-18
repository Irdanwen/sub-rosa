//! Pure account and encrypted synchronization contracts. Secrets deliberately have no Display.
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(transparent)]
pub struct Secret(pub String);
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}
impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Please sign in again.")]
    Unauthorized,
    #[error("This action is not allowed.")]
    Forbidden,
    #[error("The requested item was not found.")]
    NotFound,
    #[error("The request is invalid.")]
    Invalid,
    #[error("Another change was saved. Refresh and try again.")]
    Conflict,
    #[error("The signed-in account changed. Unlock this account again.")]
    AccountMismatch,
    #[error("Your storage quota has been reached.")]
    Quota,
    #[error("Please wait before trying again.")]
    RateLimited,
    #[error("Approve the request in your browser.")]
    Pending,
    #[error("Please sign in again to confirm this action.")]
    RecentAuth,
    #[error("The service is temporarily unavailable.")]
    Unavailable,
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Account {
    pub id: Uuid,
    pub email: String,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug)]
pub struct Identity {
    pub issuer: String,
    pub subject: String,
    pub email: String,
    pub authenticated_at: DateTime<Utc>,
}
#[derive(Clone, Debug)]
pub struct Session {
    pub account: Account,
    pub device_id: Option<Uuid>,
    pub authenticated_at: DateTime<Utc>,
    pub browser: bool,
    pub token_hash: Vec<u8>,
}
#[derive(Debug, Serialize)]
pub struct Device {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Operation {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved_revisions: Vec<Uuid>,
    pub operation_id: Uuid,
    pub object_id: Uuid,
    pub parent_revision: Option<Uuid>,
    pub kind: String,
    pub ciphertext: String,
    pub deleted: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Change {
    #[serde(default)]
    pub resolved_revisions: Vec<Uuid>,
    pub sequence: i64,
    pub operation_id: Uuid,
    pub object_id: Uuid,
    pub revision: Uuid,
    pub parent_revision: Option<Uuid>,
    pub kind: String,
    pub ciphertext: String,
    pub deleted: bool,
    pub device_id: Option<Uuid>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperationResult {
    pub operation_id: Uuid,
    pub revision: Uuid,
    pub sequence: i64,
    pub conflict: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct JournalPage {
    pub changes: Vec<Change>,
    pub cursor: i64,
    pub has_more: bool,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Vault {
    pub version: i64,
    pub envelope: serde_json::Value,
}
#[derive(Clone, Debug)]
pub struct LoginAttempt {
    pub state_hash: Vec<u8>,
    pub browser_hash: Vec<u8>,
    pub verifier: Secret,
    pub nonce: Secret,
    pub return_to: String,
}
#[derive(Debug, Serialize)]
pub struct DeviceLogin {
    pub request_id: Uuid,
    pub verification_uri: String,
    pub user_code: String,
    pub expires_at: DateTime<Utc>,
    pub interval_seconds: u32,
}
#[derive(Debug)]
pub struct DeviceRequest {
    pub request_id: Uuid,
    pub challenge: Vec<u8>,
    pub code_hash: Vec<u8>,
    pub name: String,
}
#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: Secret,
    pub refresh_token: Secret,
    pub refresh_expires_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub device_id: Uuid,
    pub account: Account,
}
#[async_trait]
pub trait IdentityProvider: Send + Sync {
    /// `register` sends the browser to the provider's sign-up surface instead of
    /// its sign-in one. Same client, same PKCE, same redirect.
    fn authorization_url(
        &self,
        attempt: &LoginAttempt,
        state: &str,
        register: bool,
    ) -> Result<String>;
    async fn exchange(&self, attempt: &LoginAttempt, code: &str) -> Result<Identity>;
}
#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn put(&self, key: &str, content: Vec<u8>) -> Result<()>;
    async fn get(&self, key: &str) -> Result<Vec<u8>>;
    async fn delete(&self, key: &str) -> Result<()>;
}
pub const KINDS: &[&str] = &[
    "note",
    "folder",
    "transcript",
    "memory",
    "conversation",
    "settings",
    "usage",
    "artifact",
    "tombstone",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeletionRecord {
    pub version: u32,
    pub account_id: Uuid,
    pub deleted_at: DateTime<Utc>,
}
pub struct DeletionPage {
    pub records: Vec<DeletionRecord>,
    pub cursor: Option<String>,
}
#[async_trait]
pub trait DeletionLedger: Send + Sync {
    async fn record(&self, record: &DeletionRecord) -> Result<()>;
    async fn page(&self, after: Option<&str>) -> Result<DeletionPage>;
}
