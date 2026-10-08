//! Talking to the service about spaces, and every rule that needs both the
//! network and the protocol: the identity is fetched or born, heads are
//! verified against what this device already trusts, keys are unwrapped and
//! checked against their commitment, objects are opened and kept, the
//! outbox is sealed and sent, and a departure is rotated out.
use super::protocol::{
    self, b64, Departure, EpochHead, HeadDraft, HeadMember, IdentityBundle, IdentitySecret,
    InvitePayload, ObjectBody, WireObject, ROLE_MEMBER, ROLE_OWNER,
};
use super::store::{self, SpaceRow};
use crate::account::{call, get_secret, put_secret, vault_key, Session};
use crate::domain::types::AppError;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_sqlite::SqlitePool;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

const IDENTITY_SLOT: &str = "space-identity";
/// Seven days, the longest the service keeps an invitation.
const INVITATION_DAYS: i64 = 7;

pub struct Ctx {
    pub s: Session,
    pub identity: IdentitySecret,
    pub bundle: IdentityBundle,
}
impl Ctx {
    pub fn me(&self) -> &str {
        &self.s.account.id
    }
}

pub async fn context(pool: &SqlitePool) -> Result<Ctx, AppError> {
    let s = crate::account::session(pool).await?;
    let vault = vault_key(&s)?;
    let (identity, bundle) = identity(pool, &s, &vault).await?;
    Ok(Ctx {
        s,
        identity,
        bundle,
    })
}

fn matches(identity: &IdentitySecret, bundle: &IdentityBundle) -> bool {
    b64(&identity.x25519_public()) == bundle.x25519
        && b64(&identity.ed25519_public()) == bundle.ed25519
}

/// The account's identity: from the keyring when this device already has
/// it, from the service (sealed under the vault key) when another device
/// made it, and born here when nobody has. Two devices racing to create it
/// meet at the service's compare-and-swap, and the loser takes the winner's.
async fn identity(
    pool: &SqlitePool,
    s: &Session,
    vault: &[u8; 32],
) -> Result<(IdentitySecret, IdentityBundle), AppError> {
    let account = &s.account.id;
    if let (Some(secret), Some(json)) = (
        get_secret(&s.base, account, IDENTITY_SLOT)?,
        store::settings(pool).await?.identity_json,
    ) {
        if let (Ok(identity), Ok(bundle)) = (
            IdentitySecret::from_body(secret.expose_str().as_bytes()),
            serde_json::from_str::<IdentityBundle>(&json),
        ) {
            if bundle.account_id == *account && matches(&identity, &bundle) {
                return Ok((identity, bundle));
            }
        }
    }
    for _ in 0..2 {
        match call(s, Method::GET, "/api/v1/identity", None).await {
            Ok(record) => {
                let bundle: IdentityBundle = serde_json::from_value(record["public"].clone())
                    .map_err(|_| protocol::invalid())?;
                bundle.verify()?;
                let sealed = record["sealed_private"]
                    .as_str()
                    .ok_or_else(protocol::invalid)?;
                let identity = IdentitySecret::open(vault, account, sealed)?;
                if bundle.account_id != *account || !matches(&identity, &bundle) {
                    return Err(protocol::invalid());
                }
                put_secret(&s.base, account, IDENTITY_SLOT, &identity.keyring_value())?;
                store::cache_identity(pool, &bundle).await?;
                return Ok((identity, bundle));
            }
            Err(e) if e.code == "vault_not_found" => {
                let identity = IdentitySecret::generate();
                let bundle = identity.bundle(account, &chrono::Utc::now().to_rfc3339());
                let sealed = identity.seal(vault, account)?;
                match call(
                    s,
                    Method::PUT,
                    "/api/v1/identity",
                    Some(json!({"expected_version":0,"public":bundle,"sealed_private":sealed})),
                )
                .await
                {
                    Ok(_) => {
                        put_secret(&s.base, account, IDENTITY_SLOT, &identity.keyring_value())?;
                        store::cache_identity(pool, &bundle).await?;
                        return Ok((identity, bundle));
                    }
                    Err(e) if e.code == "account_conflict" => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err(protocol::invalid())
}

// --- What the service returns ----------------------------------------------

#[derive(Deserialize)]
pub struct Detail {
    pub current_epoch: u64,
    pub members: Vec<DetailMember>,
    pub heads: Vec<DetailHead>,
    pub keys: Vec<DetailKey>,
    pub invitations: Vec<DetailInvitation>,
    pub departures: Vec<DetailDeparture>,
}
#[derive(Deserialize)]
pub struct DetailMember {
    pub account_id: String,
    pub identity: Option<Value>,
}
#[derive(Deserialize)]
pub struct DetailHead {
    pub head: Value,
}
#[derive(Deserialize)]
pub struct DetailKey {
    pub epoch: u64,
    pub sealed: String,
}
#[derive(Deserialize, Clone)]
pub struct DetailInvitation {
    pub id: String,
    pub expires_at: String,
    pub claimed_by: Option<String>,
    pub acceptance: Option<Value>,
}
#[derive(Deserialize)]
pub struct DetailDeparture {
    pub account_id: String,
    pub epoch: u64,
    pub statement: String,
}
#[derive(Deserialize)]
struct ObjectPage {
    objects: Vec<PagedObject>,
    cursor: i64,
    has_more: bool,
}
#[derive(Deserialize)]
struct PagedObject {
    sequence: i64,
    #[serde(flatten)]
    wire: WireObject,
}

/// A space as this device has just verified it.
pub struct Verified {
    pub latest: EpochHead,
    pub heads: BTreeMap<u64, EpochHead>,
    pub keys: BTreeMap<u64, Zeroizing<[u8; 32]>>,
    pub detail: Detail,
}
impl Verified {
    pub fn current_key(&self) -> Result<&[u8; 32], AppError> {
        self.keys
            .get(&self.latest.epoch)
            .map(|key| &**key)
            .ok_or_else(protocol::invalid)
    }
}

pub enum Fetched {
    Verified(Box<Verified>),
    /// Not a member (yet, or any more).
    Gone,
}

/// Reads a space and verifies everything the service said about it.
pub async fn fetch(pool: &SqlitePool, ctx: &Ctx, row: &SpaceRow) -> Result<Fetched, AppError> {
    let detail: Detail = match call(
        &ctx.s,
        Method::GET,
        &format!("/api/v1/spaces/{}", row.id),
        None,
    )
    .await
    {
        Ok(value) => serde_json::from_value(value).map_err(|_| protocol::invalid())?,
        Err(e) if e.code == "vault_not_found" => return Ok(Fetched::Gone),
        Err(e) => return Err(e),
    };
    let heads: Vec<EpochHead> = detail
        .heads
        .iter()
        .map(|h| serde_json::from_value(h.head.clone()))
        .collect::<Result<_, _>>()
        .map_err(|_| protocol::invalid())?;
    let trusted = store::latest_head(pool, &row.id).await?;
    let anchor: IdentityBundle =
        serde_json::from_str(&row.anchor_json).map_err(|_| protocol::invalid())?;
    let latest = protocol::verify_chain(
        trusted.as_ref(),
        &heads,
        trusted.is_none().then_some(&anchor),
    )?
    .clone();
    if latest.space_id != row.id || detail.current_epoch != latest.epoch {
        return Err(protocol::invalid());
    }
    if latest.member(ctx.me()).is_none() {
        return Ok(Fetched::Gone);
    }
    let floor = trusted.as_ref().map_or(0, |head| head.epoch);
    let fresh: Vec<&EpochHead> = heads.iter().filter(|h| h.epoch > floor).collect();
    store::save_heads(pool, &row.id, &fresh).await?;
    // The service's copy of each member's identity must be the keys the
    // signed head names: a substituted key is refused, not shown.
    let mut members = Vec::new();
    for member in &latest.members {
        let bundle = if member.account_id == ctx.me() {
            ctx.bundle.clone()
        } else {
            let published = detail
                .members
                .iter()
                .find(|m| m.account_id == member.account_id)
                .and_then(|m| m.identity.clone())
                .and_then(|v| serde_json::from_value::<IdentityBundle>(v).ok());
            match published {
                Some(bundle) => {
                    bundle.verify()?;
                    if !bundle.matches(member) {
                        return Err(protocol::invalid());
                    }
                    bundle
                }
                // Gone from the service (an account deleted): kept as the
                // head names it, until the rotation that removes it.
                None => continue,
            }
        };
        members.push((member.account_id.clone(), member.role.clone(), bundle));
    }
    store::replace_members(pool, &row.id, &members).await?;
    let by_epoch: BTreeMap<u64, EpochHead> =
        heads.into_iter().map(|head| (head.epoch, head)).collect();
    let mut keys = BTreeMap::new();
    for wrapped in &detail.keys {
        let head = by_epoch.get(&wrapped.epoch).ok_or_else(protocol::invalid)?;
        keys.insert(
            wrapped.epoch,
            protocol::unwrap_key(&ctx.identity, &wrapped.sealed, head, ctx.me())?,
        );
    }
    let verified = Verified {
        latest,
        heads: by_epoch,
        keys,
        detail,
    };
    verified.current_key()?;
    Ok(Fetched::Verified(Box::new(verified)))
}

/// Pulls every object after the cursor, opens it and keeps it. Returns how
/// many messages from other members arrived.
pub async fn pull(
    pool: &SqlitePool,
    ctx: &Ctx,
    row: &SpaceRow,
    v: &Verified,
) -> Result<i64, AppError> {
    let mut cursor = row.cursor;
    let mut new_messages = 0;
    loop {
        let page: ObjectPage = serde_json::from_value(
            call(
                &ctx.s,
                Method::GET,
                &format!("/api/v1/spaces/{}/objects?after={cursor}&limit=200", row.id),
                None,
            )
            .await?,
        )
        .map_err(|_| protocol::invalid())?;
        for object in &page.objects {
            // An object from an epoch this member holds no key for (written
            // before they joined, with no history shared) stays unread.
            let (Some(head), Some(key)) = (
                v.heads.get(&object.wire.epoch),
                v.keys.get(&object.wire.epoch),
            ) else {
                continue;
            };
            let Some(author) = head.member(&object.wire.author_account_id) else {
                tracing::warn!("space object from a non-member skipped");
                continue;
            };
            let body = match protocol::open_object(key, &row.id, &object.wire, author) {
                Ok(body) => body,
                Err(_) => {
                    tracing::warn!("space object failed verification and was skipped");
                    continue;
                }
            };
            let fresh =
                store::accept_object(pool, &row.id, &body, object.wire.epoch, object.sequence)
                    .await?;
            if fresh && body.kind == "message" && body.author != ctx.me() {
                new_messages += 1;
            }
            if body.kind == "project" && !body.deleted {
                if let Some(name) = body.data["name"].as_str() {
                    store::set_name(pool, &row.id, name).await?;
                }
            }
        }
        cursor = page.cursor;
        if !page.has_more {
            break;
        }
    }
    store::finish_pull(pool, &row.id, cursor, new_messages).await?;
    Ok(new_messages)
}

/// Seals what waits in the outbox under the current epoch and sends it.
pub async fn flush(
    pool: &SqlitePool,
    ctx: &Ctx,
    row: &SpaceRow,
    v: &Verified,
) -> Result<(), AppError> {
    let rows = store::outbox(pool, &row.id).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let epoch = v.latest.epoch;
    let epoch_i64 = i64::try_from(epoch).unwrap_or(i64::MAX);
    let key = v.current_key()?;
    let mut objects = Vec::new();
    let mut sealed_rows = Vec::new();
    for out in &rows {
        let (revision, ciphertext, signature) = match (&out.ciphertext, &out.signature, out.epoch) {
            (Some(c), Some(s), Some(e)) if e == epoch_i64 => {
                (out.revision.clone(), c.clone(), s.clone())
            }
            (frozen, _, _) => {
                // Sealed under an epoch that has passed: a new revision, so the
                // service never sees two bodies under one revision.
                let revision = if frozen.is_some() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    out.revision.clone()
                };
                let body = ObjectBody {
                    v: 1,
                    kind: out.kind.clone(),
                    object_id: out.object_id.clone(),
                    revision: revision.clone(),
                    parent_revision: out.parent_revision.clone(),
                    author: ctx.me().to_string(),
                    created_at: out.created_at.clone(),
                    deleted: out.deleted,
                    data: out.data.clone(),
                };
                let parts = protocol::seal_object(key, &row.id, epoch, &body, &ctx.identity)?;
                store::freeze(
                    pool,
                    &out.id,
                    &revision,
                    epoch_i64,
                    &parts.ciphertext,
                    &parts.signature,
                )
                .await?;
                (revision, parts.ciphertext, parts.signature)
            }
        };
        objects.push(json!({
            "object_id": out.object_id,
            "revision": revision,
            "parent_revision": out.parent_revision,
            "kind": out.kind,
            "epoch": epoch,
            "ciphertext": ciphertext,
            "signature": signature,
            "deleted": out.deleted,
        }));
        sealed_rows.push((out, revision));
    }
    let result = call(
        &ctx.s,
        Method::POST,
        &format!("/api/v1/spaces/{}/objects", row.id),
        Some(json!({ "objects": objects })),
    )
    .await?;
    let results = result["results"].as_array().ok_or_else(protocol::invalid)?;
    if results.len() != sealed_rows.len() {
        return Err(protocol::invalid());
    }
    for ((out, revision), answer) in sealed_rows.iter().zip(results) {
        let sequence = answer["sequence"].as_i64().ok_or_else(protocol::invalid)?;
        if answer["revision"].as_str() != Some(revision.as_str()) {
            return Err(protocol::invalid());
        }
        let body = ObjectBody {
            v: 1,
            kind: out.kind.clone(),
            object_id: out.object_id.clone(),
            revision: revision.clone(),
            parent_revision: out.parent_revision.clone(),
            author: ctx.me().to_string(),
            created_at: out.created_at.clone(),
            deleted: out.deleted,
            data: out.data.clone(),
        };
        store::accept_object(pool, &row.id, &body, epoch, sequence).await?;
        store::sent(pool, &out.id).await?;
    }
    Ok(())
}

// --- Epochs ----------------------------------------------------------------

pub struct Admission<'a> {
    pub invitation_id: &'a str,
    pub member: &'a IdentityBundle,
}

/// One new epoch: a fresh key, a head this account signs, the key sealed to
/// every member, and for a newcomer the earlier keys too, so a project's
/// history is theirs to read. Every membership change goes through here.
pub async fn rotate(
    ctx: &Ctx,
    space_id: &str,
    v: &Verified,
    members: Vec<HeadMember>,
    departures: Vec<Departure>,
    admission: Option<Admission<'_>>,
) -> Result<(), AppError> {
    let key = protocol::random_space_key();
    let epoch = v.latest.epoch + 1;
    let head = EpochHead::sign(
        HeadDraft {
            space_id,
            epoch,
            prev: Some(&v.latest),
            owner: &v.latest.owner,
            members,
            key: &key,
            author: ctx.me(),
            departures,
            created_at: &chrono::Utc::now().to_rfc3339(),
        },
        &ctx.identity,
    );
    // The same rules every member will apply, applied first by the author.
    protocol::verify_next(Some(&v.latest), &head)?;
    let mut wrapped = Vec::new();
    for member in &head.members {
        wrapped.push(json!({
            "account_id": member.account_id,
            "epoch": epoch,
            "sealed": protocol::wrap_key(&key, &member.x25519, space_id, epoch, &member.account_id)?,
        }));
    }
    let mut admit = Vec::new();
    if let Some(admission) = &admission {
        for (old_epoch, old_key) in &v.keys {
            wrapped.push(json!({
                "account_id": admission.member.account_id,
                "epoch": old_epoch,
                "sealed": protocol::wrap_key(old_key, &admission.member.x25519, space_id, *old_epoch, &admission.member.account_id)?,
            }));
        }
        admit.push(admission.invitation_id.to_string());
    }
    call(
        &ctx.s,
        Method::POST,
        &format!("/api/v1/spaces/{space_id}/epochs"),
        Some(json!({"head": head, "wrapped_keys": wrapped, "admit": admit})),
    )
    .await?;
    Ok(())
}

/// The rotation a departure, or an account that vanished, calls for. The
/// owner rotates anyone out; another member only those who signed
/// themselves out. Returns whether a new epoch was made.
pub async fn rotate_if_due(ctx: &Ctx, space_id: &str, v: &Verified) -> Result<bool, AppError> {
    let on_service: Vec<&str> = v
        .detail
        .members
        .iter()
        .map(|m| m.account_id.as_str())
        .collect();
    let departures: Vec<Departure> = v
        .detail
        .departures
        .iter()
        .filter(|d| d.epoch == v.latest.epoch && v.latest.member(&d.account_id).is_some())
        .map(|d| Departure {
            account_id: d.account_id.clone(),
            signature: d.statement.clone(),
        })
        .collect();
    let leaving = |id: &str| departures.iter().any(|d| d.account_id == id);
    let stays: Vec<HeadMember> = v
        .latest
        .members
        .iter()
        .filter(|m| on_service.contains(&m.account_id.as_str()) && !leaving(&m.account_id))
        .cloned()
        .collect();
    if stays.len() == v.latest.members.len() {
        return Ok(false);
    }
    let owner = v.latest.owner == ctx.me();
    let only_departures = v.latest.members.len() - stays.len() == departures.len();
    if !owner && (departures.is_empty() || !only_departures) {
        return Ok(false);
    }
    match rotate(ctx, space_id, v, stays, departures, None).await {
        Ok(()) => Ok(true),
        // Someone else rotated first; the next pass reads their epoch.
        Err(e) if e.code == "account_conflict" => Ok(false),
        Err(e) => Err(e),
    }
}

// --- Creating, inviting, joining ---------------------------------------------

pub async fn create(
    pool: &SqlitePool,
    ctx: &Ctx,
    name: &str,
    source_folder_id: Option<&str>,
) -> Result<String, AppError> {
    let space_id = uuid::Uuid::new_v4().to_string();
    let key = protocol::random_space_key();
    let head = EpochHead::sign(
        HeadDraft {
            space_id: &space_id,
            epoch: 1,
            prev: None,
            owner: ctx.me(),
            members: vec![HeadMember::from_bundle(&ctx.bundle, ROLE_OWNER)],
            key: &key,
            author: ctx.me(),
            departures: vec![],
            created_at: &chrono::Utc::now().to_rfc3339(),
        },
        &ctx.identity,
    );
    let wrapped = protocol::wrap_key(&key, &ctx.bundle.x25519, &space_id, 1, ctx.me())?;
    call(
        &ctx.s,
        Method::POST,
        "/api/v1/spaces",
        Some(json!({"head": head, "wrapped_key": wrapped})),
    )
    .await?;
    store::insert_space(
        pool,
        store::NewSpace {
            id: &space_id,
            name,
            owner: ctx.me(),
            role: ROLE_OWNER,
            state: "active",
            source_folder_id,
            anchor: &ctx.bundle,
        },
    )
    .await?;
    store::save_heads(pool, &space_id, &[&head]).await?;
    store::replace_members(
        pool,
        &space_id,
        &[(ctx.me().to_string(), ROLE_OWNER.into(), ctx.bundle.clone())],
    )
    .await?;
    Ok(space_id)
}

pub struct Invitation {
    pub id: String,
    pub code: String,
    pub expires_at: String,
}
pub async fn invite(pool: &SqlitePool, ctx: &Ctx, row: &SpaceRow) -> Result<Invitation, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let secret = Zeroizing::new(rand::random::<[u8; 32]>());
    let expires_at = (chrono::Utc::now() + chrono::Duration::days(INVITATION_DAYS)).to_rfc3339();
    let payload = InvitePayload {
        v: 1,
        space_id: row.id.clone(),
        space_name: row.name.clone(),
        inviter: ctx.bundle.clone(),
        expires_at: expires_at.clone(),
    };
    let sealed = protocol::seal_payload(&secret, &id, &payload)?;
    let token = protocol::invite_token(&secret, &id);
    call(
        &ctx.s,
        Method::POST,
        &format!("/api/v1/spaces/{}/invitations", row.id),
        Some(json!({
            "id": id,
            "token_hash": protocol::token_hash(&token),
            "payload": sealed,
            "expires_at": expires_at,
        })),
    )
    .await?;
    store::save_invitation(pool, &id, &row.id, &b64(secret.as_slice()), &expires_at).await?;
    Ok(Invitation {
        code: protocol::invitation_code(&id, &secret),
        id,
        expires_at,
    })
}

pub struct Opened {
    pub invitation_id: String,
    pub secret: Zeroizing<[u8; 32]>,
    pub payload: InvitePayload,
}
pub async fn open_invitation(ctx: &Ctx, code: &str) -> Result<Opened, AppError> {
    let (invitation_id, secret) = protocol::parse_invitation(code)?;
    let token = protocol::invite_token(&secret, &invitation_id);
    let opened = call(
        &ctx.s,
        Method::POST,
        &format!("/api/v1/space-invitations/{invitation_id}/open"),
        Some(json!({"token_hash": protocol::token_hash(&token)})),
    )
    .await
    .map_err(|e| {
        if e.code == "vault_not_found" {
            super::invitation_unavailable()
        } else {
            e
        }
    })?;
    let sealed = opened["payload"].as_str().ok_or_else(protocol::invalid)?;
    let payload = protocol::open_payload(&secret, &invitation_id, sealed)?;
    if opened["space_id"].as_str() != Some(payload.space_id.as_str()) {
        return Err(super::invitation_unavailable());
    }
    Ok(Opened {
        invitation_id,
        secret,
        payload,
    })
}
pub async fn accept(pool: &SqlitePool, ctx: &Ctx, opened: &Opened) -> Result<(), AppError> {
    if opened.payload.inviter.account_id == ctx.me() {
        return Err(super::invitation_unavailable());
    }
    let token = protocol::invite_token(&opened.secret, &opened.invitation_id);
    let proof = protocol::acceptance_proof(
        &opened.secret,
        &opened.invitation_id,
        &opened.payload.space_id,
        &ctx.bundle,
    );
    call(
        &ctx.s,
        Method::POST,
        &format!("/api/v1/space-invitations/{}/accept", opened.invitation_id),
        Some(json!({
            "token_hash": protocol::token_hash(&token),
            "acceptance": {"member": ctx.bundle, "proof": proof},
        })),
    )
    .await
    .map_err(|e| match e.code.as_str() {
        "vault_not_found" | "account_conflict" => super::invitation_unavailable(),
        _ => e,
    })?;
    store::insert_space(
        pool,
        store::NewSpace {
            id: &opened.payload.space_id,
            name: &opened.payload.space_name,
            owner: &opened.payload.inviter.account_id,
            role: ROLE_MEMBER,
            state: "pending",
            source_folder_id: None,
            anchor: &opened.payload.inviter,
        },
    )
    .await
}

/// An acceptance the owner may admit: its proof checked with the secret
/// this device kept when it made the link.
pub enum Acceptance {
    Verified(IdentityBundle),
    /// The link was made on another device, or the proof does not hold.
    Unverifiable,
}
pub async fn check_acceptance(
    pool: &SqlitePool,
    space_id: &str,
    invitation: &DetailInvitation,
) -> Result<Option<Acceptance>, AppError> {
    let (Some(claimed_by), Some(acceptance)) = (&invitation.claimed_by, &invitation.acceptance)
    else {
        return Ok(None);
    };
    let Some(secret) = store::invitation_secret(pool, &invitation.id).await? else {
        return Ok(Some(Acceptance::Unverifiable));
    };
    let secret = Zeroizing::new(
        <[u8; 32]>::try_from(protocol::unb64(&secret)?.as_slice())
            .map_err(|_| protocol::invalid())?,
    );
    let Ok(member) = serde_json::from_value::<IdentityBundle>(acceptance["member"].clone()) else {
        return Ok(Some(Acceptance::Unverifiable));
    };
    let proof = acceptance["proof"].as_str().unwrap_or_default();
    if member.account_id != *claimed_by
        || protocol::verify_acceptance(&secret, &invitation.id, space_id, &member, proof).is_err()
    {
        return Ok(Some(Acceptance::Unverifiable));
    }
    Ok(Some(Acceptance::Verified(member)))
}

pub async fn leave(ctx: &Ctx, space_id: &str, v: &Verified) -> Result<(), AppError> {
    let statement = protocol::leave_statement(&ctx.identity, space_id, v.latest.epoch, ctx.me());
    call(
        &ctx.s,
        Method::POST,
        &format!("/api/v1/spaces/{space_id}/leave"),
        Some(json!({"epoch": v.latest.epoch, "statement": statement})),
    )
    .await?;
    Ok(())
}
pub async fn delete(ctx: &Ctx, space_id: &str) -> Result<(), AppError> {
    call(
        &ctx.s,
        Method::DELETE,
        &format!("/api/v1/spaces/{space_id}"),
        None,
    )
    .await?;
    Ok(())
}
pub async fn revoke_invitation(
    ctx: &Ctx,
    space_id: &str,
    invitation_id: &str,
) -> Result<(), AppError> {
    call(
        &ctx.s,
        Method::DELETE,
        &format!("/api/v1/spaces/{space_id}/invitations/{invitation_id}"),
        None,
    )
    .await?;
    Ok(())
}
