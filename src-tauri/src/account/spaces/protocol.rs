//! The spaces protocol, version 1, without any I/O: identity keys, signed
//! epoch heads, wrapped space keys, encrypted and signed objects,
//! invitations, leave statements and safety numbers. Every rule here is
//! stated in docs/security/spaces-protocol.md, and the browser implements the
//! same rules in `website/src/client/spaces/protocol.ts`; the shared vectors
//! in `tests/fixtures/spaces-v1.json` hold the two together.
//!
//! Signed and hashed values are never JSON: they are a transcript of
//! length-prefixed UTF-8 strings (`u32` big-endian length, then the bytes),
//! starting with a label naming the purpose, so no two purposes can produce
//! the same bytes and no canonical-JSON question arises.
use super::hpke;
use crate::account::crypto;
use crate::domain::types::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

pub const MAX_MEMBERS: usize = 50;
/// The object kinds a space carries. Anything else is refused on both sides.
pub const KINDS: [&str; 6] = [
    "project",
    "note",
    "file",
    "conversation",
    "message",
    "profile",
];
pub const ROLE_OWNER: &str = "owner";
pub const ROLE_MEMBER: &str = "member";
const SAFETY_ITERATIONS: usize = 1024;
pub const INVITATION_PREFIX: &str = "srspace1";

pub fn invalid() -> AppError {
    AppError::new(
        "space_invalid",
        "This shared project's data could not be verified. Nothing was changed.",
    )
}
pub fn rollback() -> AppError {
    AppError::new(
        "space_rollback",
        "The service showed an older state of this shared project than this device has already seen. Nothing was changed.",
    )
}
fn invitation_invalid() -> AppError {
    AppError::new(
        "space_invitation_invalid",
        "This invitation could not be verified. Ask for a new link.",
    )
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn unb64(value: &str) -> Result<Vec<u8>, AppError> {
    URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())
}
fn key32(value: &str) -> Result<[u8; 32], AppError> {
    unb64(value)?.as_slice().try_into().map_err(|_| invalid())
}
fn sig64(value: &str) -> Result<[u8; 64], AppError> {
    unb64(value)?.as_slice().try_into().map_err(|_| invalid())
}
fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|parsed| parsed.hyphenated().to_string() == value)
        .unwrap_or(false)
}

/// A labelled, length-prefixed transcript.
pub struct Transcript(Vec<u8>);
impl Transcript {
    pub fn new(label: &str) -> Self {
        let mut transcript = Self(Vec::new());
        transcript.push(label);
        transcript
    }
    pub fn push(&mut self, field: &str) -> &mut Self {
        let len = u32::try_from(field.len()).unwrap_or(u32::MAX);
        self.0.extend_from_slice(&len.to_be_bytes());
        self.0.extend_from_slice(field.as_bytes());
        self
    }
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

fn verify_signature(public: &[u8; 32], message: &[u8], signature: &str) -> Result<(), AppError> {
    let key = VerifyingKey::from_bytes(public).map_err(|_| invalid())?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig64(signature)?);
    key.verify_strict(message, &signature)
        .map_err(|_| invalid())
}

// --- Identity -------------------------------------------------------------

/// An account's published identity: two public keys, self-signed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityBundle {
    pub v: u8,
    pub account_id: String,
    pub x25519: String,
    pub ed25519: String,
    pub created_at: String,
    pub signature: String,
}
impl IdentityBundle {
    fn transcript(&self) -> Transcript {
        let mut t = Transcript::new("subrosa:identity:v1");
        t.push(&self.account_id)
            .push(&self.x25519)
            .push(&self.ed25519)
            .push(&self.created_at);
        t
    }
    pub fn verify(&self) -> Result<(), AppError> {
        if self.v != 1 || !is_uuid(&self.account_id) || self.created_at.len() > 64 {
            return Err(invalid());
        }
        key32(&self.x25519)?;
        verify_signature(
            &key32(&self.ed25519)?,
            self.transcript().bytes(),
            &self.signature,
        )
    }
    pub fn x25519_key(&self) -> Result<[u8; 32], AppError> {
        key32(&self.x25519)
    }
    pub fn ed25519_key(&self) -> Result<[u8; 32], AppError> {
        key32(&self.ed25519)
    }
    /// Whether a head's member entry names exactly these keys.
    pub fn matches(&self, member: &HeadMember) -> bool {
        member.account_id == self.account_id
            && member.x25519 == self.x25519
            && member.ed25519 == self.ed25519
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentitySecretBody {
    v: u8,
    x25519_secret: String,
    ed25519_seed: String,
}

/// The two private keys of an account. They live sealed under the vault key
/// on the service and in this device's keyring, never anywhere else.
pub struct IdentitySecret {
    x25519: Zeroizing<[u8; 32]>,
    ed25519: Zeroizing<[u8; 32]>,
}
impl IdentitySecret {
    pub fn generate() -> Self {
        Self::from_seeds(rand::random(), rand::random())
    }
    pub fn from_seeds(x25519: [u8; 32], ed25519: [u8; 32]) -> Self {
        Self {
            x25519: Zeroizing::new(x25519),
            ed25519: Zeroizing::new(ed25519),
        }
    }
    fn signing(&self) -> SigningKey {
        SigningKey::from_bytes(&self.ed25519)
    }
    pub fn x25519_public(&self) -> [u8; 32] {
        hpke::public_key(&self.x25519)
    }
    pub fn ed25519_public(&self) -> [u8; 32] {
        self.signing().verifying_key().to_bytes()
    }
    pub fn sign(&self, message: &[u8]) -> String {
        b64(&self.signing().sign(message).to_bytes())
    }
    pub fn bundle(&self, account_id: &str, created_at: &str) -> IdentityBundle {
        let mut bundle = IdentityBundle {
            v: 1,
            account_id: account_id.to_string(),
            x25519: b64(&self.x25519_public()),
            ed25519: b64(&self.ed25519_public()),
            created_at: created_at.to_string(),
            signature: String::new(),
        };
        bundle.signature = self.sign(bundle.transcript().bytes());
        bundle
    }
    pub fn x25519_secret(&self) -> &[u8; 32] {
        &self.x25519
    }
    fn body(&self) -> Zeroizing<String> {
        Zeroizing::new(
            serde_json::to_string(&IdentitySecretBody {
                v: 1,
                x25519_secret: b64(self.x25519.as_slice()),
                ed25519_seed: b64(self.ed25519.as_slice()),
            })
            .unwrap_or_default(),
        )
    }
    /// Sealed under the vault key, the way every account object is.
    pub fn seal(&self, vault_key: &[u8; 32], account_id: &str) -> Result<String, AppError> {
        crypto::seal(vault_key, &identity_aad(account_id), self.body().as_bytes())
    }
    pub fn seal_with_nonce(
        &self,
        vault_key: &[u8; 32],
        account_id: &str,
        nonce: [u8; 12],
    ) -> Result<String, AppError> {
        seal_envelope(
            vault_key,
            &identity_aad(account_id),
            self.body().as_bytes(),
            nonce,
        )
    }
    pub fn open(vault_key: &[u8; 32], account_id: &str, envelope: &str) -> Result<Self, AppError> {
        let clear = crypto::open(vault_key, &identity_aad(account_id), envelope)?;
        Self::from_body(&clear)
    }
    /// What this device keeps in its keyring: the same body, not sealed
    /// again, because the keyring is the protection there.
    pub fn keyring_value(&self) -> Zeroizing<String> {
        self.body()
    }
    pub fn from_body(body: &[u8]) -> Result<Self, AppError> {
        let body: IdentitySecretBody = serde_json::from_slice(body).map_err(|_| invalid())?;
        if body.v != 1 {
            return Err(invalid());
        }
        let x = Zeroizing::new(key32(&body.x25519_secret)?);
        let e = Zeroizing::new(key32(&body.ed25519_seed)?);
        Ok(Self::from_seeds(*x, *e))
    }
}
fn identity_aad(account_id: &str) -> String {
    format!("subrosa:identity:v1:{account_id}")
}

/// AES-256-GCM in the account's envelope format with a chosen nonce. Only the
/// vectors use it: a nonce must never repeat under one key.
pub fn seal_envelope(
    key: &[u8; 32],
    aad: &str,
    plaintext: &[u8],
    nonce: [u8; 12],
) -> Result<String, AppError> {
    use aes_gcm::{
        aead::{Aead, Payload},
        Aes256Gcm, KeyInit, Nonce,
    };
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| invalid())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| invalid())?;
    serde_json::to_string(&crypto::Envelope {
        v: 1,
        nonce: b64(&nonce),
        ciphertext: b64(&ciphertext),
    })
    .map_err(|_| invalid())
}

/// Thirty digits naming one identity: SHA-256 of its transcript, hashed again
/// 1024 times, read as six 40-bit numbers modulo 100000.
pub fn fingerprint_digits(bundle: &IdentityBundle) -> String {
    let mut t = Transcript::new("subrosa:safety:v1");
    t.push(&bundle.account_id)
        .push(&bundle.ed25519)
        .push(&bundle.x25519);
    let mut digest: [u8; 32] = Sha256::digest(t.bytes()).into();
    for _ in 0..SAFETY_ITERATIONS {
        digest = Sha256::digest(digest).into();
    }
    let mut digits = String::with_capacity(30);
    for chunk in digest[..30].chunks(5) {
        let mut value = 0u64;
        for byte in chunk {
            value = (value << 8) | u64::from(*byte);
        }
        digits.push_str(&format!("{:05}", value % 100_000));
    }
    digits
}

/// The safety number two people compare out of band: both fingerprints,
/// the smaller first, so each side computes the same sixty digits.
pub fn safety_number(a: &IdentityBundle, b: &IdentityBundle) -> String {
    let (first, second) = (fingerprint_digits(a), fingerprint_digits(b));
    if first <= second {
        format!("{first}{second}")
    } else {
        format!("{second}{first}")
    }
}

/// Twelve groups of five, the way the screen shows it.
pub fn grouped(number: &str) -> Vec<String> {
    number
        .as_bytes()
        .chunks(5)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect()
}

// --- Epoch heads ----------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeadMember {
    pub account_id: String,
    pub role: String,
    pub x25519: String,
    pub ed25519: String,
}
impl HeadMember {
    pub fn from_bundle(bundle: &IdentityBundle, role: &str) -> Self {
        Self {
            account_id: bundle.account_id.clone(),
            role: role.to_string(),
            x25519: bundle.x25519.clone(),
            ed25519: bundle.ed25519.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Departure {
    pub account_id: String,
    pub signature: String,
}

/// One epoch of a space: who is in it, a commitment to its key, signed by
/// whoever made it, chained to the previous one by hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EpochHead {
    pub v: u8,
    pub space_id: String,
    pub epoch: u64,
    pub prev: String,
    pub owner: String,
    pub members: Vec<HeadMember>,
    pub key_commitment: String,
    pub author: String,
    pub departures: Vec<Departure>,
    pub created_at: String,
    pub signature: String,
}

pub struct HeadDraft<'a> {
    pub space_id: &'a str,
    pub epoch: u64,
    pub prev: Option<&'a EpochHead>,
    pub owner: &'a str,
    pub members: Vec<HeadMember>,
    pub key: &'a [u8; 32],
    pub author: &'a str,
    pub departures: Vec<Departure>,
    pub created_at: &'a str,
}

impl EpochHead {
    fn transcript(&self) -> Transcript {
        let mut t = Transcript::new("subrosa:space-head:v1");
        t.push(&self.space_id)
            .push(&self.epoch.to_string())
            .push(&self.prev)
            .push(&self.owner)
            .push(&self.members.len().to_string());
        for member in &self.members {
            t.push(&member.account_id)
                .push(&member.role)
                .push(&member.x25519)
                .push(&member.ed25519);
        }
        t.push(&self.key_commitment)
            .push(&self.author)
            .push(&self.departures.len().to_string());
        for departure in &self.departures {
            t.push(&departure.account_id).push(&departure.signature);
        }
        t.push(&self.created_at);
        t
    }
    /// The hash the next head names as `prev`: the transcript and its
    /// signature, so two different signatures over one transcript differ.
    pub fn hash(&self) -> String {
        let mut t = self.transcript();
        t.push(&self.signature);
        b64(&Sha256::digest(t.bytes()))
    }
    pub fn sign(draft: HeadDraft<'_>, identity: &IdentitySecret) -> Self {
        let mut members = draft.members;
        members.sort_by(|a, b| a.account_id.cmp(&b.account_id));
        let mut departures = draft.departures;
        departures.sort_by(|a, b| a.account_id.cmp(&b.account_id));
        let mut head = Self {
            v: 1,
            space_id: draft.space_id.to_string(),
            epoch: draft.epoch,
            prev: draft.prev.map(Self::hash).unwrap_or_default(),
            owner: draft.owner.to_string(),
            members,
            key_commitment: key_commitment(draft.key, draft.space_id, draft.epoch),
            author: draft.author.to_string(),
            departures,
            created_at: draft.created_at.to_string(),
            signature: String::new(),
        };
        head.signature = identity.sign(head.transcript().bytes());
        head
    }
    pub fn member(&self, account_id: &str) -> Option<&HeadMember> {
        self.members.iter().find(|m| m.account_id == account_id)
    }
    fn shape(&self) -> Result<(), AppError> {
        let sorted = self
            .members
            .windows(2)
            .all(|pair| pair[0].account_id < pair[1].account_id);
        let departures_sorted = self
            .departures
            .windows(2)
            .all(|pair| pair[0].account_id < pair[1].account_id);
        let owners: Vec<_> = self
            .members
            .iter()
            .filter(|m| m.role == ROLE_OWNER)
            .collect();
        if self.v != 1
            || !is_uuid(&self.space_id)
            || self.epoch == 0
            || !sorted
            || !departures_sorted
            || self.members.is_empty()
            || self.members.len() > MAX_MEMBERS
            || owners.len() != 1
            || owners[0].account_id != self.owner
            || self.created_at.len() > 64
            || unb64(&self.key_commitment)?.len() != 32
        {
            return Err(invalid());
        }
        for member in &self.members {
            if !is_uuid(&member.account_id)
                || !(member.role == ROLE_OWNER || member.role == ROLE_MEMBER)
            {
                return Err(invalid());
            }
            key32(&member.x25519)?;
            key32(&member.ed25519)?;
        }
        Ok(())
    }
}

/// A fresh space key for a new epoch.
pub fn random_space_key() -> Zeroizing<[u8; 32]> {
    Zeroizing::new(rand::random())
}

pub fn key_commitment(key: &[u8; 32], space_id: &str, epoch: u64) -> String {
    b64(&hpke::hmac_sha256(
        key,
        format!("subrosa:space-key-commit:v1:{space_id}:{epoch}").as_bytes(),
    ))
}

fn leave_transcript(space_id: &str, epoch: u64, account_id: &str) -> Transcript {
    let mut t = Transcript::new("subrosa:space-leave:v1");
    t.push(space_id).push(&epoch.to_string()).push(account_id);
    t
}
/// What a member signs to leave: this space, the epoch they leave from, and
/// themselves. A remaining member may then rotate without the owner.
pub fn leave_statement(
    identity: &IdentitySecret,
    space_id: &str,
    epoch: u64,
    account_id: &str,
) -> String {
    identity.sign(leave_transcript(space_id, epoch, account_id).bytes())
}

/// Checks one head against the one before it. `prev` is `None` only for the
/// first epoch. The rules are the protocol document's "Head validity".
pub fn verify_next(prev: Option<&EpochHead>, head: &EpochHead) -> Result<(), AppError> {
    head.shape()?;
    let Some(prev) = prev else {
        let owner = head.member(&head.owner).ok_or_else(invalid)?;
        if head.epoch != 1
            || !head.prev.is_empty()
            || head.author != head.owner
            || !head.departures.is_empty()
        {
            return Err(invalid());
        }
        return verify_signature(
            &key32(&owner.ed25519)?,
            head.transcript().bytes(),
            &head.signature,
        );
    };
    if head.space_id != prev.space_id
        || head.epoch != prev.epoch + 1
        || head.prev != prev.hash()
        || head.owner != prev.owner
    {
        return Err(invalid());
    }
    // The author must have been a member of the epoch being replaced, and
    // signs with the key that epoch named.
    let author = prev.member(&head.author).ok_or_else(invalid)?;
    verify_signature(
        &key32(&author.ed25519)?,
        head.transcript().bytes(),
        &head.signature,
    )?;
    for departure in &head.departures {
        let leaving = prev.member(&departure.account_id).ok_or_else(invalid)?;
        if departure.account_id == head.owner || head.member(&departure.account_id).is_some() {
            return Err(invalid());
        }
        verify_signature(
            &key32(&leaving.ed25519)?,
            leave_transcript(&head.space_id, prev.epoch, &departure.account_id).bytes(),
            &departure.signature,
        )?;
    }
    if head.author == head.owner {
        return Ok(());
    }
    // Anyone else may only take out the members who signed themselves out,
    // and changes nothing else.
    let expected: Vec<&HeadMember> = prev
        .members
        .iter()
        .filter(|m| !head.departures.iter().any(|d| d.account_id == m.account_id))
        .collect();
    if head.departures.is_empty()
        || head.departures.iter().any(|d| d.account_id == head.author)
        || expected.len() != head.members.len()
        || expected.iter().zip(&head.members).any(|(a, b)| *a != b)
    {
        return Err(invalid());
    }
    Ok(())
}

/// What a chain check leaves a device to rely on: the latest head, and every
/// head it may use for a key's commitment, a membership or an author's
/// signing key, by epoch. A head the service returned that is not in `heads`
/// was refused, never merely skipped.
#[derive(Debug)]
pub struct VerifiedChain {
    pub latest: EpochHead,
    pub heads: BTreeMap<u64, EpochHead>,
}

/// Verifies the heads a service returned against what this device already
/// trusts. With nothing trusted yet, the chain must start at epoch 1 and its
/// owner must be `anchor` (the inviter named in the link, or this account
/// for a space it created).
///
/// With a trusted head, a later head must verify forward from it, and an
/// earlier one must be the head it names, link by link
/// (`hash(head_e) == head_{e+1}.prev`): an older head is history this
/// device already accepted, so it is matched, not re-judged. A returned head
/// below a missing epoch, or one that does not link, is another history and
/// a rollback. Omitting old heads is not: they are simply not in `heads`.
pub fn verify_chain(
    trusted: Option<&EpochHead>,
    heads: &[EpochHead],
    anchor: Option<&IdentityBundle>,
) -> Result<VerifiedChain, AppError> {
    let mut ordered: Vec<&EpochHead> = heads.iter().collect();
    ordered.sort_by_key(|head| head.epoch);
    if ordered
        .windows(2)
        .any(|pair| pair[0].epoch == pair[1].epoch)
    {
        return Err(invalid());
    }
    let latest = *ordered.last().ok_or_else(invalid)?;
    let mut verified = BTreeMap::new();
    match trusted {
        Some(trusted) => {
            if latest.epoch < trusted.epoch {
                return Err(rollback());
            }
            if let Some(same) = ordered.iter().find(|head| head.epoch == trusted.epoch) {
                if same.hash() != trusted.hash() {
                    return Err(rollback());
                }
            }
            let mut previous = trusted;
            for head in ordered.iter().filter(|head| head.epoch > trusted.epoch) {
                verify_next(Some(previous), head)?;
                verified.insert(head.epoch, (*head).clone());
                previous = head;
            }
            verified.insert(trusted.epoch, trusted.clone());
            let mut link = trusted;
            for head in ordered
                .iter()
                .rev()
                .filter(|head| head.epoch < trusted.epoch)
            {
                if head.epoch + 1 != link.epoch || head.hash() != link.prev {
                    return Err(rollback());
                }
                head.shape()?;
                verified.insert(head.epoch, (*head).clone());
                link = head;
            }
        }
        None => {
            let first = ordered.first().ok_or_else(invalid)?;
            verify_next(None, first)?;
            if let Some(anchor) = anchor {
                let owner = first.member(&first.owner).ok_or_else(invalid)?;
                if !anchor.matches(owner) {
                    return Err(invalid());
                }
            }
            for pair in ordered.windows(2) {
                verify_next(Some(pair[0]), pair[1])?;
            }
            verified.extend(ordered.iter().map(|head| (head.epoch, (*head).clone())));
        }
    }
    Ok(VerifiedChain {
        latest: latest.clone(),
        heads: verified,
    })
}

// --- Wrapped keys ---------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    v: u8,
    enc: String,
    ct: String,
}
fn wrap_info(space_id: &str, epoch: u64, account_id: &str) -> String {
    format!("subrosa:space-key:v1:{space_id}:{epoch}:{account_id}")
}
pub fn wrap_key(
    key: &[u8; 32],
    recipient_x25519: &str,
    space_id: &str,
    epoch: u64,
    account_id: &str,
) -> Result<String, AppError> {
    wrap_key_with(
        &Zeroizing::new(rand::random()),
        key,
        recipient_x25519,
        space_id,
        epoch,
        account_id,
    )
}
pub fn wrap_key_with(
    ephemeral: &[u8; 32],
    key: &[u8; 32],
    recipient_x25519: &str,
    space_id: &str,
    epoch: u64,
    account_id: &str,
) -> Result<String, AppError> {
    let (enc, ct) = hpke::seal_with_ephemeral(
        ephemeral,
        &key32(recipient_x25519)?,
        wrap_info(space_id, epoch, account_id).as_bytes(),
        b"",
        key,
    )
    .map_err(|_| invalid())?;
    serde_json::to_string(&Sealed {
        v: 1,
        enc: b64(&enc),
        ct: b64(&ct),
    })
    .map_err(|_| invalid())
}
/// Opens a wrapped key and checks it against the head's commitment: a sealed
/// box says nothing about who sealed it, the signed head does.
pub fn unwrap_key(
    identity: &IdentitySecret,
    sealed: &str,
    head: &EpochHead,
    account_id: &str,
) -> Result<Zeroizing<[u8; 32]>, AppError> {
    let sealed: Sealed = serde_json::from_str(sealed).map_err(|_| invalid())?;
    if sealed.v != 1 {
        return Err(invalid());
    }
    let clear = hpke::open(
        identity.x25519_secret(),
        &key32(&sealed.enc)?,
        wrap_info(&head.space_id, head.epoch, account_id).as_bytes(),
        b"",
        &unb64(&sealed.ct)?,
    )
    .map_err(|_| invalid())?;
    let key: [u8; 32] = clear.as_slice().try_into().map_err(|_| invalid())?;
    let key = Zeroizing::new(key);
    if key_commitment(&key, &head.space_id, head.epoch) != head.key_commitment {
        return Err(invalid());
    }
    Ok(key)
}

// --- Objects --------------------------------------------------------------

/// What an object decrypts to. Every field but `data` is also on the wire or
/// in the authenticated data, and the two are compared after decryption.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectBody {
    pub v: u8,
    pub kind: String,
    pub object_id: String,
    pub revision: String,
    pub parent_revision: Option<String>,
    pub author: String,
    pub created_at: String,
    pub deleted: bool,
    pub data: Value,
}

/// An object as the service stores and returns it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireObject {
    pub object_id: String,
    pub revision: String,
    pub parent_revision: Option<String>,
    pub kind: String,
    pub epoch: u64,
    pub author_account_id: String,
    pub ciphertext: String,
    pub signature: String,
    pub deleted: bool,
}

pub fn object_aad(
    space_id: &str,
    epoch: u64,
    kind: &str,
    object_id: &str,
    revision: &str,
    author: &str,
) -> String {
    format!("subrosa:space-object:v1:{space_id}:{epoch}:{kind}:{object_id}:{revision}:{author}")
}
fn object_signature_transcript(aad: &str, ciphertext: &str) -> Transcript {
    let mut t = Transcript::new("subrosa:space-object-signature:v1");
    t.push(aad)
        .push(&b64(&Sha256::digest(ciphertext.as_bytes())));
    t
}

/// Size bounds a member's device enforces on what it writes and accepts.
pub fn check_data(kind: &str, data: &Value, author: &str) -> Result<(), AppError> {
    let text = |field: &str, max: usize| -> Result<(), AppError> {
        match data.get(field) {
            Some(Value::String(value)) if value.chars().count() <= max => Ok(()),
            _ => Err(invalid()),
        }
    };
    if !data.is_object() {
        return Err(invalid());
    }
    match kind {
        "project" => {
            text("name", 200)?;
            text("instructions", 8000)
        }
        "note" => {
            text("title", 300)?;
            text("body", 200_000)
        }
        "file" => {
            text("name", 300)?;
            text("format", 40)?;
            text("text", 400_000)
        }
        "conversation" => text("title", 300),
        "profile" => text("name", 80),
        "message" => {
            text("conversation_id", 36)?;
            text("text", 100_000)?;
            match data.get("role").and_then(Value::as_str) {
                Some("user") => Ok(()),
                // The member whose device ran the turn is the one who paid,
                // and the signature says who that was.
                Some("assistant") => {
                    text("model", 200)?;
                    if data.get("paid_by").and_then(Value::as_str) == Some(author) {
                        Ok(())
                    } else {
                        Err(invalid())
                    }
                }
                _ => Err(invalid()),
            }
        }
        _ => Err(invalid()),
    }
}

pub struct SealedParts {
    pub ciphertext: String,
    pub signature: String,
}

pub fn seal_object(
    key: &[u8; 32],
    space_id: &str,
    epoch: u64,
    body: &ObjectBody,
    identity: &IdentitySecret,
) -> Result<SealedParts, AppError> {
    seal_object_with_nonce(key, space_id, epoch, body, identity, rand::random())
}
pub fn seal_object_with_nonce(
    key: &[u8; 32],
    space_id: &str,
    epoch: u64,
    body: &ObjectBody,
    identity: &IdentitySecret,
    nonce: [u8; 12],
) -> Result<SealedParts, AppError> {
    if !KINDS.contains(&body.kind.as_str()) || body.v != 1 {
        return Err(invalid());
    }
    if !body.deleted {
        check_data(&body.kind, &body.data, &body.author)?;
    }
    let aad = object_aad(
        space_id,
        epoch,
        &body.kind,
        &body.object_id,
        &body.revision,
        &body.author,
    );
    let plaintext = Zeroizing::new(serde_json::to_vec(body).map_err(|_| invalid())?);
    let ciphertext = seal_envelope(key, &aad, &plaintext, nonce)?;
    let signature = identity.sign(object_signature_transcript(&aad, &ciphertext).bytes());
    Ok(SealedParts {
        ciphertext,
        signature,
    })
}

/// Verifies the author's signature, decrypts, and compares every
/// authenticated field with what the service said. `author` is the author's
/// entry in the head of the object's epoch: someone who was not a member of
/// that epoch cannot have written in it.
pub fn open_object(
    key: &[u8; 32],
    space_id: &str,
    wire: &WireObject,
    author: &HeadMember,
) -> Result<ObjectBody, AppError> {
    if author.account_id != wire.author_account_id || !KINDS.contains(&wire.kind.as_str()) {
        return Err(invalid());
    }
    let aad = object_aad(
        space_id,
        wire.epoch,
        &wire.kind,
        &wire.object_id,
        &wire.revision,
        &wire.author_account_id,
    );
    verify_signature(
        &key32(&author.ed25519)?,
        object_signature_transcript(&aad, &wire.ciphertext).bytes(),
        &wire.signature,
    )?;
    let clear = crypto::open(key, &aad, &wire.ciphertext).map_err(|_| invalid())?;
    let body: ObjectBody = serde_json::from_slice(&clear).map_err(|_| invalid())?;
    if body.v != 1
        || body.kind != wire.kind
        || body.object_id != wire.object_id
        || body.revision != wire.revision
        || body.parent_revision != wire.parent_revision
        || body.author != wire.author_account_id
        || body.deleted != wire.deleted
    {
        return Err(invalid());
    }
    if !body.deleted {
        check_data(&body.kind, &body.data, &body.author)?;
    }
    Ok(body)
}

// --- Invitations ----------------------------------------------------------

/// The payload a link opens: the space, and the inviter's identity, which is
/// what anchors the invitee's trust in the space's owner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvitePayload {
    pub v: u8,
    pub space_id: String,
    pub space_name: String,
    pub inviter: IdentityBundle,
    pub expires_at: String,
}

pub fn invite_token(secret: &[u8; 32], invitation_id: &str) -> Zeroizing<[u8; 32]> {
    hpke::hkdf32(
        secret,
        format!("subrosa:invite-token:v1:{invitation_id}").as_bytes(),
    )
}
/// What the service keeps to recognise the token: its SHA-256.
pub fn token_hash(token: &[u8; 32]) -> String {
    b64(&Sha256::digest(token))
}
fn payload_key(secret: &[u8; 32], invitation_id: &str) -> Zeroizing<[u8; 32]> {
    hpke::hkdf32(
        secret,
        format!("subrosa:invite-payload:v1:{invitation_id}").as_bytes(),
    )
}
fn invite_aad(invitation_id: &str) -> String {
    format!("subrosa:invite:v1:{invitation_id}")
}
pub fn seal_payload_with_nonce(
    secret: &[u8; 32],
    invitation_id: &str,
    payload: &InvitePayload,
    nonce: [u8; 12],
) -> Result<String, AppError> {
    let body = serde_json::to_vec(payload).map_err(|_| invalid())?;
    seal_envelope(
        &payload_key(secret, invitation_id),
        &invite_aad(invitation_id),
        &body,
        nonce,
    )
}
pub fn seal_payload(
    secret: &[u8; 32],
    invitation_id: &str,
    payload: &InvitePayload,
) -> Result<String, AppError> {
    seal_payload_with_nonce(secret, invitation_id, payload, rand::random())
}
pub fn open_payload(
    secret: &[u8; 32],
    invitation_id: &str,
    sealed: &str,
) -> Result<InvitePayload, AppError> {
    let clear = crypto::open(
        &payload_key(secret, invitation_id),
        &invite_aad(invitation_id),
        sealed,
    )
    .map_err(|_| invitation_invalid())?;
    let payload: InvitePayload =
        serde_json::from_slice(&clear).map_err(|_| invitation_invalid())?;
    if payload.v != 1 || !is_uuid(&payload.space_id) {
        return Err(invitation_invalid());
    }
    payload.inviter.verify().map_err(|_| invitation_invalid())?;
    Ok(payload)
}

fn acceptance_transcript(
    invitation_id: &str,
    space_id: &str,
    member: &IdentityBundle,
) -> Transcript {
    let mut t = Transcript::new("subrosa:space-accept:v1");
    t.push(invitation_id)
        .push(space_id)
        .push(&member.account_id)
        .push(&member.x25519)
        .push(&member.ed25519);
    t
}
/// The invitee's proof that they hold the link: an HMAC, under a key only the
/// link derives, over who they are. The service relays it and cannot forge
/// one for somebody else.
pub fn acceptance_proof(
    secret: &[u8; 32],
    invitation_id: &str,
    space_id: &str,
    member: &IdentityBundle,
) -> String {
    let key = hpke::hkdf32(
        secret,
        format!("subrosa:invite-accept:v1:{invitation_id}").as_bytes(),
    );
    b64(&hpke::hmac_sha256(
        key.as_slice(),
        acceptance_transcript(invitation_id, space_id, member).bytes(),
    ))
}
pub fn verify_acceptance(
    secret: &[u8; 32],
    invitation_id: &str,
    space_id: &str,
    member: &IdentityBundle,
    proof: &str,
) -> Result<(), AppError> {
    use subtle::ConstantTimeEq;
    member.verify().map_err(|_| invitation_invalid())?;
    let expected = acceptance_proof(secret, invitation_id, space_id, member);
    if bool::from(expected.as_bytes().ct_eq(proof.as_bytes())) {
        Ok(())
    } else {
        Err(invitation_invalid())
    }
}

/// `srspace1.<invitation id>.<secret>`: what a link carries in its fragment.
pub fn invitation_code(invitation_id: &str, secret: &[u8; 32]) -> String {
    format!("{INVITATION_PREFIX}.{invitation_id}.{}", b64(secret))
}
/// Finds a code in what a person pasted: the code alone or a link with it in
/// the fragment.
pub fn parse_invitation(text: &str) -> Result<(String, Zeroizing<[u8; 32]>), AppError> {
    let start = text
        .find(&format!("{INVITATION_PREFIX}."))
        .ok_or_else(invitation_invalid)?;
    let code: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let mut parts = code.splitn(3, '.');
    let (Some(_), Some(id), Some(secret)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invitation_invalid());
    };
    if !is_uuid(id) {
        return Err(invitation_invalid());
    }
    let secret = Zeroizing::new(key32(secret).map_err(|_| invitation_invalid())?);
    Ok((id.to_string(), secret))
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
pub(crate) mod tests;
