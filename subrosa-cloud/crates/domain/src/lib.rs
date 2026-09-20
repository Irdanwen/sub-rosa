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
    /// A cloned device secret shows up as a renewal war: each renewal revokes
    /// the other's family. These two fields are how the legitimate owner sees
    /// it happening, which is why there is no secret rotation (ADR 0056).
    pub renewed_at: Option<DateTime<Utc>>,
    pub renew_count: i32,
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
    /// Set when this round trip finishes a native sign-in. It is written when
    /// the attempt is created and read back from the row the single-use state
    /// consumes, so nothing an attacker can supply decides the branch.
    pub native_request_id: Option<Uuid>,
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
    /// A code the person reads out of the app and approves in a browser.
    pub code_hash: Option<Vec<u8>>,
    /// A handle the app sends the browser to. Exactly one of the two is set.
    pub start_hash: Option<Vec<u8>>,
    pub name: String,
    /// The device row this login should reuse instead of creating another,
    /// proven by its device secret at start. Signing in again on the same
    /// machine is not a new device.
    pub rebind_device_id: Option<Uuid>,
}
/// What the app gets when it asks for a sign-in that comes back by itself.
/// There is no user code here on purpose: nothing about this flow is meant to
/// be read aloud or retyped.
#[derive(Debug, Serialize)]
pub struct NativeLogin {
    pub request_id: Uuid,
    pub start_url: String,
    pub expires_at: DateTime<Utc>,
}

/// Untagged so the code flow keeps the exact response shape apps 1.63 to 1.68
/// already parse, and a native start is simply a different set of fields.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum StartedDevice {
    Code(DeviceLogin),
    Native(NativeLogin),
}

/// Where the OIDC round trip leaves the browser. A browser sign-in gets a
/// session cookie; a native one gets a page that hands the return code to the
/// app and nothing else. The native branch deliberately leaves no 12 hour
/// session behind in a browser that may not be the person's own.
#[derive(Debug)]
pub enum Landing {
    Browser { return_to: String, token: Secret },
    Native { return_to: String },
}

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: Secret,
    pub refresh_token: Secret,
    pub refresh_expires_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub device_id: Uuid,
    /// Present when this exchange admitted the device. It renews sessions
    /// without a browser until the device is revoked, and it is never rotated:
    /// a lost rotation response would lock the device out for good.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_secret: Option<Secret>,
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
    // The one kind that is an instruction rather than a record: a device asking
    // another of the same account's devices to fetch a link (ADR 0054). Opaque
    // here like every other kind; the service neither reads it nor runs it.
    "errand",
];

/// A share as its owner sees it. Nothing here describes what was shared: the
/// title, the kind and the file name are inside the sealed head, under a key
/// this service never receives.
#[derive(Clone, Debug, Serialize)]
pub struct Share {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub blobs: i32,
    pub bytes: i64,
}

/// What a reader learns before they have the key: how many pieces to ask for,
/// how large they are together, and when the service stops answering.
#[derive(Clone, Debug, Serialize)]
pub struct SharePreview {
    pub v: u8,
    pub blobs: i32,
    pub bytes: i64,
    pub expires_at: DateTime<Utc>,
}

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
