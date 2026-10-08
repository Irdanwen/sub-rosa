//! Shared projects (ADR 0098). The service reads the parts of a signed epoch
//! head that are membership metadata it holds anyway (who, which role, which
//! public keys, which epoch) so it can keep its own rows consistent with what
//! the members' devices will verify. It verifies no signature: trust is the
//! devices' business, and a service that checked signatures would still be
//! the party the protocol does not trust (docs/security/spaces-protocol.md).
use crate::{Error, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const MAX_MEMBERS: usize = 50;
pub const MAX_MEMBERSHIPS: i64 = 100;
pub const MAX_PENDING_INVITATIONS: i64 = 20;
pub const MAX_INVITATION_DAYS: i64 = 7;
pub const MAX_SPACE_BYTES: i64 = 256 * 1024 * 1024;
pub const MAX_OBJECT_BYTES: usize = 1024 * 1024;
pub const MAX_BATCH_OPERATIONS: usize = 100;
pub const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
pub const KINDS: [&str; 6] = [
    "project",
    "note",
    "file",
    "conversation",
    "message",
    "profile",
];

#[derive(Clone, Debug, Serialize)]
pub struct IdentityRecord {
    pub version: i64,
    pub public: Value,
    pub sealed_private: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct SpaceSummary {
    pub id: Uuid,
    pub owner_account_id: Uuid,
    pub role: String,
    pub current_epoch: i64,
    pub latest_sequence: i64,
    pub member_count: i64,
    pub pending_departures: i64,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize)]
pub struct SpaceMember {
    pub account_id: Uuid,
    pub role: String,
    pub joined_epoch: i64,
    pub identity: Option<Value>,
}
#[derive(Clone, Debug, Serialize)]
pub struct SpaceHead {
    pub epoch: i64,
    pub head: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WrappedKey {
    pub account_id: Uuid,
    pub epoch: i64,
    pub sealed: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct InvitationView {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub claimed_by: Option<Uuid>,
    pub acceptance: Option<Value>,
}
#[derive(Clone, Debug, Serialize)]
pub struct DepartureView {
    pub account_id: Uuid,
    pub epoch: i64,
    pub statement: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct SpaceDetail {
    pub id: Uuid,
    pub owner_account_id: Uuid,
    pub current_epoch: i64,
    pub latest_sequence: i64,
    pub members: Vec<SpaceMember>,
    pub heads: Vec<SpaceHead>,
    pub keys: Vec<WrappedKey>,
    pub invitations: Vec<InvitationView>,
    pub departures: Vec<DepartureView>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewSpaceObject {
    pub object_id: Uuid,
    pub revision: Uuid,
    pub parent_revision: Option<Uuid>,
    pub kind: String,
    pub epoch: i64,
    pub ciphertext: String,
    pub signature: String,
    pub deleted: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct SpaceObject {
    pub sequence: i64,
    pub object_id: Uuid,
    pub revision: Uuid,
    pub parent_revision: Option<Uuid>,
    pub kind: String,
    pub epoch: i64,
    pub author_account_id: Uuid,
    pub ciphertext: String,
    pub signature: String,
    pub deleted: bool,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize)]
pub struct ObjectResult {
    pub revision: Uuid,
    pub sequence: i64,
}
#[derive(Clone, Debug, Serialize)]
pub struct ObjectPage {
    pub objects: Vec<SpaceObject>,
    pub cursor: i64,
    pub has_more: bool,
}

/// The public keys of a bundle or a head member: base64url of 32 bytes.
fn public_key(value: &Value) -> Result<String> {
    let text = value.as_str().ok_or(Error::Invalid)?;
    if text.len() == 43
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Ok(text.to_owned())
    } else {
        Err(Error::Invalid)
    }
}
fn signature(value: &Value) -> Result<()> {
    let text = value.as_str().ok_or(Error::Invalid)?;
    if text.len() == 86
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Ok(())
    } else {
        Err(Error::Invalid)
    }
}
fn uuid_field(value: &Value) -> Result<Uuid> {
    value
        .as_str()
        .and_then(|text| Uuid::parse_str(text).ok())
        .ok_or(Error::Invalid)
}
fn object_keys(value: &Value, expected: &[&str]) -> Result<()> {
    let map = value.as_object().ok_or(Error::Invalid)?;
    if map.len() == expected.len() && expected.iter().all(|key| map.contains_key(*key)) {
        Ok(())
    } else {
        Err(Error::Invalid)
    }
}

/// A published identity: its account and its two public keys, after its
/// shape was checked. The self-signature is the devices' to verify.
pub struct BundleKeys {
    pub account_id: Uuid,
    pub x25519: String,
    pub ed25519: String,
}
pub fn bundle_keys(bundle: &Value) -> Result<BundleKeys> {
    object_keys(
        bundle,
        &[
            "v",
            "account_id",
            "x25519",
            "ed25519",
            "created_at",
            "signature",
        ],
    )?;
    if bundle["v"] != 1 || bundle["created_at"].as_str().is_none_or(|t| t.len() > 64) {
        return Err(Error::Invalid);
    }
    signature(&bundle["signature"])?;
    Ok(BundleKeys {
        account_id: uuid_field(&bundle["account_id"])?,
        x25519: public_key(&bundle["x25519"])?,
        ed25519: public_key(&bundle["ed25519"])?,
    })
}

pub struct HeadMemberInfo {
    pub account_id: Uuid,
    pub owner: bool,
    pub x25519: String,
    pub ed25519: String,
}
/// The membership a head declares.
pub struct HeadInfo {
    pub space_id: Uuid,
    pub epoch: i64,
    pub owner: Uuid,
    pub author: Uuid,
    pub members: Vec<HeadMemberInfo>,
    pub departures: Vec<Uuid>,
}
impl HeadInfo {
    pub fn member(&self, account: Uuid) -> Option<&HeadMemberInfo> {
        self.members.iter().find(|m| m.account_id == account)
    }
}
pub fn head_info(head: &Value) -> Result<HeadInfo> {
    object_keys(
        head,
        &[
            "v",
            "space_id",
            "epoch",
            "prev",
            "owner",
            "members",
            "key_commitment",
            "author",
            "departures",
            "created_at",
            "signature",
        ],
    )?;
    if head["v"] != 1 || head["prev"].as_str().is_none_or(|p| p.len() > 64) {
        return Err(Error::Invalid);
    }
    signature(&head["signature"])?;
    public_key(&head["key_commitment"])?;
    let epoch = head["epoch"]
        .as_i64()
        .filter(|epoch| *epoch > 0)
        .ok_or(Error::Invalid)?;
    let owner = uuid_field(&head["owner"])?;
    let mut members = Vec::new();
    for member in head["members"].as_array().ok_or(Error::Invalid)? {
        object_keys(member, &["account_id", "role", "x25519", "ed25519"])?;
        let role = member["role"].as_str().ok_or(Error::Invalid)?;
        if role != "owner" && role != "member" {
            return Err(Error::Invalid);
        }
        members.push(HeadMemberInfo {
            account_id: uuid_field(&member["account_id"])?,
            owner: role == "owner",
            x25519: public_key(&member["x25519"])?,
            ed25519: public_key(&member["ed25519"])?,
        });
    }
    let mut departures = Vec::new();
    for departure in head["departures"].as_array().ok_or(Error::Invalid)? {
        object_keys(departure, &["account_id", "signature"])?;
        signature(&departure["signature"])?;
        departures.push(uuid_field(&departure["account_id"])?);
    }
    let owners: Vec<_> = members.iter().filter(|m| m.owner).collect();
    let mut ids: Vec<Uuid> = members.iter().map(|m| m.account_id).collect();
    ids.sort_unstable();
    ids.dedup();
    if members.is_empty()
        || members.len() > MAX_MEMBERS
        || ids.len() != members.len()
        || owners.len() != 1
        || owners[0].account_id != owner
    {
        return Err(Error::Invalid);
    }
    Ok(HeadInfo {
        space_id: uuid_field(&head["space_id"])?,
        epoch,
        owner,
        author: uuid_field(&head["author"])?,
        members,
        departures,
    })
}

/// What an invitee sends: their published bundle and the HMAC that proves
/// they hold the link. The service cannot check the HMAC (it lacks the
/// secret); the owner's device does.
pub fn acceptance_keys(acceptance: &Value) -> Result<BundleKeys> {
    object_keys(acceptance, &["member", "proof"])?;
    public_key(&acceptance["proof"])?;
    bundle_keys(&acceptance["member"])
}

pub fn check_object(object: &NewSpaceObject) -> Result<()> {
    if !KINDS.contains(&object.kind.as_str())
        || object.epoch < 1
        || object.ciphertext.is_empty()
        || object.ciphertext.len() > MAX_OBJECT_BYTES
    {
        return Err(Error::Invalid);
    }
    signature(&Value::String(object.signature.clone()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key(c: char) -> String {
        std::iter::repeat_n(c, 43).collect()
    }
    fn head() -> Value {
        json!({
            "v": 1,
            "space_id": "0191d1a4-5a00-7000-8000-00000000a001",
            "epoch": 1,
            "prev": "",
            "owner": "0191d1a4-0000-7000-8000-0000000000a1",
            "members": [{"account_id":"0191d1a4-0000-7000-8000-0000000000a1","role":"owner","x25519":key('x'),"ed25519":key('e')}],
            "key_commitment": key('k'),
            "author": "0191d1a4-0000-7000-8000-0000000000a1",
            "departures": [],
            "created_at": "2026-10-08T12:00:00Z",
            "signature": std::iter::repeat_n('s', 86).collect::<String>(),
        })
    }

    #[test]
    fn a_head_names_one_owner_among_distinct_members() {
        assert!(head_info(&head()).is_ok());
        let mut two_owners = head();
        two_owners["members"]
            .as_array_mut()
            .unwrap()
            .push(json!({"account_id":"0191d1a4-0000-7000-8000-0000000000b2","role":"owner","x25519":key('x'),"ed25519":key('e')}));
        assert!(head_info(&two_owners).is_err());
        let mut extra = head();
        extra["note"] = json!("x");
        assert!(head_info(&extra).is_err());
        let mut short = head();
        short["members"][0]["x25519"] = json!("short");
        assert!(head_info(&short).is_err());
    }
}
