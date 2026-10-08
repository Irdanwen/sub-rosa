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
    #[error("Sign in from the app on this device.")]
    DeviceRequired,
    /// A browser asked to become a device without the out-of-band admission:
    /// a pairing approved by another device, or the recovery key (ADR 0096).
    #[error("Approve this browser from a device, or use your recovery key.")]
    AdmissionRequired,
    /// A browser device's proof was missing, malformed, replayed, or signed by
    /// a key this account does not know as a live browser device.
    #[error("This browser is no longer a device of the account.")]
    DeviceProof,
    /// A public address (a page slug or a profile handle) another account
    /// already holds (ADR 0097).
    #[error("This address is already taken.")]
    SlugTaken,
    /// Public content that one of the documented rules refuses (ADR 0097).
    #[error("This content cannot be published.")]
    ContentPolicy(publication::PolicyRule),
    /// The operator took this down, or an exact copy of something taken down.
    #[error("This content was taken down and cannot be published again.")]
    TakenDown,
    /// The account lost the right to publish after repeated takedowns.
    #[error("Publishing is suspended for this account.")]
    PublishingSuspended,
}
pub type Result<T> = std::result::Result<T, Error>;
pub mod publication;
pub mod space;
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
    /// `native` for an app, `browser` for a browser admitted as a device
    /// (ADR 0096). Both are revoked the same way.
    pub kind: DeviceKind,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Native,
    Browser,
}
impl DeviceKind {
    pub fn parse(value: &str) -> Self {
        if value == "browser" {
            Self::Browser
        } else {
            Self::Native
        }
    }
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

/// Why a Carpe Diem device key has to die. The wire names are the contract
/// (`docs/carpe-diem-partner-contract.md`, section 4), so they are spelled once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevocationReason {
    /// The owner revoked the device from another one, or from the website.
    DeviceRevoked,
    /// The device signed itself out.
    SignedOut,
    /// The whole account was deleted. Carpe Diem also forgets the link.
    AccountDeleted,
}
impl RevocationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeviceRevoked => "device_revoked",
            Self::SignedOut => "signed_out",
            Self::AccountDeleted => "account_deleted",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "device_revoked" => Some(Self::DeviceRevoked),
            "signed_out" => Some(Self::SignedOut),
            "account_deleted" => Some(Self::AccountDeleted),
            _ => None,
        }
    }
}

/// What the service vouches for when a device asks Carpe Diem for a key: who
/// the account is, that its address was verified, which device is asking, and
/// which ephemeral key the answer must be bound to. Nothing here lets the
/// service see or spend the key it helps create (ADR 0069).
#[derive(Clone, Debug)]
pub struct IssuanceClaims {
    pub subject: Uuid,
    pub email: String,
    pub device_id: Uuid,
    pub device_name: String,
    /// RFC 7638 thumbprint of the app's ephemeral P-256 key, base64url.
    pub jkt: String,
    /// Present for a browser device only. Carpe Diem mints the key with this
    /// bound and holds it in its TEE (ADR 0096); an app's key has none.
    pub browser: Option<BrowserBound>,
}
/// What a browser device's key may do at Carpe Diem: spend at most
/// `daily_cap_credits` (hundredths of a dollar) in any 24 hours, and live
/// `valid_seconds` before the browser must ask again while it is still a device.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct BrowserBound {
    pub daily_cap_credits: u32,
    pub valid_seconds: u32,
}
#[derive(Debug, Serialize)]
pub struct IssuanceAssertion {
    pub assertion: Secret,
    pub expires_at: DateTime<Utc>,
}
/// One durable row of the revocation outbox.
#[derive(Clone, Debug)]
pub struct PendingRevocation {
    pub id: Uuid,
    pub subject: Uuid,
    pub device_id: Option<Uuid>,
    pub reason: RevocationReason,
    pub attempts: i32,
}
/// The only two things the service may ask of Carpe Diem: vouch for an
/// identity so a device can obtain its own key, and ask for keys to be
/// revoked. There is deliberately no way to read a key, a balance or to spend.
#[async_trait]
pub trait CarpeDiemPartner: Send + Sync {
    fn issuance_assertion(&self, claims: &IssuanceClaims) -> Result<IssuanceAssertion>;
    /// The bound this deployment asks Carpe Diem to put on a browser device's
    /// key. An app's key carries none.
    fn browser_bound(&self) -> BrowserBound;
    async fn revoke(&self, revocation: &PendingRevocation) -> Result<()>;
}

/// One line of the account's security history. The wire names are the
/// contract (`docs/accounts-sync-contract.md`) and the SQL constraint of
/// `security_events`, so they are spelled once, here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityEventKind {
    /// A browser session, through the identity provider.
    SignedIn,
    /// A browser session, through a passkey of the account origin.
    SignedInPasskey,
    /// A session ended from where it was used.
    SignedOut,
    /// An app was admitted as a new device.
    DeviceAdded,
    /// An app signed in again on a device the account already knew.
    DeviceSignedIn,
    DeviceRenamed,
    /// The owner revoked a device from another one, or from the website.
    DeviceRevoked,
    /// The device signed itself out.
    DeviceSignedOut,
    /// A spent refresh token came back, so its whole family was revoked.
    RefreshReuseBlocked,
    /// A device sent the vault key to another one through the pairing relay.
    PairingApproved,
    PasskeyAdded,
    PasskeyRemoved,
    VaultCreated,
    /// The vault envelope was replaced, which is what a new recovery key does.
    VaultUpdated,
    /// The service vouched for a device so it could obtain a Carpe Diem key.
    CarpeDiemKeyRequested,
    /// Carpe Diem acknowledged the revocation of a device key.
    CarpeDiemKeyRevoked,
    /// A restored database signed every session out (`restore-sanitize`).
    SessionsReset,
}
impl SecurityEventKind {
    pub const ALL: &[Self] = &[
        Self::SignedIn,
        Self::SignedInPasskey,
        Self::SignedOut,
        Self::DeviceAdded,
        Self::DeviceSignedIn,
        Self::DeviceRenamed,
        Self::DeviceRevoked,
        Self::DeviceSignedOut,
        Self::RefreshReuseBlocked,
        Self::PairingApproved,
        Self::PasskeyAdded,
        Self::PasskeyRemoved,
        Self::VaultCreated,
        Self::VaultUpdated,
        Self::CarpeDiemKeyRequested,
        Self::CarpeDiemKeyRevoked,
        Self::SessionsReset,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SignedIn => "signed_in",
            Self::SignedInPasskey => "signed_in_passkey",
            Self::SignedOut => "signed_out",
            Self::DeviceAdded => "device_added",
            Self::DeviceSignedIn => "device_signed_in",
            Self::DeviceRenamed => "device_renamed",
            Self::DeviceRevoked => "device_revoked",
            Self::DeviceSignedOut => "device_signed_out",
            Self::RefreshReuseBlocked => "refresh_reuse_blocked",
            Self::PairingApproved => "pairing_approved",
            Self::PasskeyAdded => "passkey_added",
            Self::PasskeyRemoved => "passkey_removed",
            Self::VaultCreated => "vault_created",
            Self::VaultUpdated => "vault_updated",
            Self::CarpeDiemKeyRequested => "carpe_diem_key_requested",
            Self::CarpeDiemKeyRevoked => "carpe_diem_key_revoked",
            Self::SessionsReset => "sessions_reset",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|kind| kind.as_str() == value)
    }
}
/// What the owner reads back: what happened, when, and on which device when
/// one was involved. Never an address, a user agent or a place.
#[derive(Clone, Debug, Serialize)]
pub struct SecurityEvent {
    pub id: Uuid,
    pub kind: SecurityEventKind,
    pub occurred_at: DateTime<Utc>,
    pub device_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::SecurityEventKind;

    /// The Rust list, the serialized names, the SQL constraint and the
    /// published schema are four spellings of one contract. A kind missing from the constraint would
    /// make the action it describes fail inside its own transaction.
    #[test]
    fn every_security_event_kind_is_allowed_by_the_table_and_serializes_as_named() {
        let migration = include_str!("../../../migrations/0010_security_events.sql");
        let check = migration
            .split("CHECK(kind IN (")
            .nth(1)
            .and_then(|rest| rest.split("))").next())
            .unwrap_or_default();
        let allowed: Vec<&str> = check
            .split(',')
            .map(|value| value.trim().trim_matches('\''))
            .collect();
        let named: Vec<&str> = SecurityEventKind::ALL
            .iter()
            .map(|kind| kind.as_str())
            .collect();
        assert_eq!(allowed, named);
        for kind in SecurityEventKind::ALL {
            assert_eq!(
                serde_json::to_value(kind).ok(),
                Some(serde_json::Value::from(kind.as_str()))
            );
            assert_eq!(SecurityEventKind::parse(kind.as_str()), Some(*kind));
        }
        assert_eq!(SecurityEventKind::parse("ip_address"), None);
        let openapi: serde_json::Value =
            serde_json::from_str(include_str!("../../../openapi.json")).unwrap_or_default();
        let documented: Vec<&str> = openapi["components"]["schemas"]["SecurityEvent"]["properties"]
            ["kind"]["enum"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(documented, named, "openapi.json lists the same kinds");
    }
}
