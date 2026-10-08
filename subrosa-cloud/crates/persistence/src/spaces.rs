//! Shared projects (ADR 0098): identities, spaces, members, epoch heads,
//! wrapped keys, invitations, departures and objects. Every write that
//! touches a space locks its row, so epochs advance one at a time and object
//! sequences never interleave. Nothing here can read what it stores.
use super::{Repository, db};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use std::collections::{BTreeMap, BTreeSet};
use subrosa_domain::space::{
    BundleKeys, DepartureView, HeadInfo, IdentityRecord, InvitationView, MAX_BATCH_BYTES,
    MAX_BATCH_OPERATIONS, MAX_MEMBERSHIPS, MAX_PAGE_BYTES, MAX_PENDING_INVITATIONS,
    MAX_SPACE_BYTES, NewSpaceObject, ObjectPage, ObjectResult, SpaceDetail, SpaceHead, SpaceMember,
    SpaceObject, SpaceSummary, WrappedKey,
};
use subrosa_domain::{Error, Result};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub struct EpochWrite<'a> {
    pub account: Uuid,
    pub space: Uuid,
    pub head: &'a Value,
    pub info: &'a HeadInfo,
    pub wrapped: &'a [WrappedKey],
    pub admit: &'a [Uuid],
}
pub struct InvitationWrite<'a> {
    pub account: Uuid,
    pub space: Uuid,
    pub id: Uuid,
    pub token_hash: &'a str,
    pub payload: &'a str,
    pub expires_at: DateTime<Utc>,
}

async fn lock_space(tx: &mut Transaction<'_, Postgres>, space: Uuid) -> Result<(Uuid, i64)> {
    let row =
        sqlx::query("SELECT owner_account_id,current_epoch FROM spaces WHERE id=$1 FOR UPDATE")
            .bind(space)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
    Ok((row.get("owner_account_id"), row.get("current_epoch")))
}
/// A space is invisible to anyone who is not in it: `404`, never `403`.
async fn role(tx: &mut Transaction<'_, Postgres>, space: Uuid, account: Uuid) -> Result<String> {
    sqlx::query_scalar("SELECT role FROM space_members WHERE space_id=$1 AND account_id=$2")
        .bind(space)
        .bind(account)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or(Error::NotFound)
}
/// The published keys of accounts, to compare with what a head names.
async fn published(
    tx: &mut Transaction<'_, Postgres>,
    accounts: &[Uuid],
) -> Result<BTreeMap<Uuid, (String, String)>> {
    let rows = sqlx::query(
        "SELECT account_id,x25519,ed25519 FROM identity_keys WHERE account_id = ANY($1)",
    )
    .bind(accounts)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    Ok(rows
        .iter()
        .map(|r| (r.get("account_id"), (r.get("x25519"), r.get("ed25519"))))
        .collect())
}
async fn insert_head(
    tx: &mut Transaction<'_, Postgres>,
    space: Uuid,
    info: &HeadInfo,
    head: &Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO space_epoch_heads(space_id,epoch,head,author_account_id) VALUES($1,$2,$3,$4)",
    )
    .bind(space)
    .bind(info.epoch)
    .bind(head)
    .bind(info.author)
    .execute(&mut **tx)
    .await
    .map_err(db)?;
    Ok(())
}
async fn insert_wraps(
    tx: &mut Transaction<'_, Postgres>,
    space: Uuid,
    wrapped: &[WrappedKey],
) -> Result<()> {
    for wrap in wrapped {
        if wrap.sealed.is_empty() || wrap.sealed.len() > 1024 {
            return Err(Error::Invalid);
        }
        let inserted = sqlx::query("INSERT INTO space_wrapped_keys(space_id,epoch,account_id,sealed) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(space)
            .bind(wrap.epoch)
            .bind(wrap.account_id)
            .bind(&wrap.sealed)
            .execute(&mut **tx)
            .await
            .map_err(db)?
            .rows_affected();
        if inserted == 0 {
            return Err(Error::Conflict);
        }
    }
    Ok(())
}
fn keys_match(info: &HeadInfo, keys: &BTreeMap<Uuid, (String, String)>) -> bool {
    info.members.iter().all(|m| {
        keys.get(&m.account_id)
            .is_some_and(|(x, e)| *x == m.x25519 && *e == m.ed25519)
    })
}
fn object_row(r: &PgRow) -> SpaceObject {
    SpaceObject {
        sequence: r.get("sequence"),
        object_id: r.get("object_id"),
        revision: r.get("revision"),
        parent_revision: r.get("parent_revision"),
        kind: r.get("kind"),
        epoch: r.get("epoch"),
        author_account_id: r.get("author_account_id"),
        ciphertext: r.get("ciphertext"),
        signature: r.get("signature"),
        deleted: r.get("deleted"),
        created_at: r.get("created_at"),
    }
}

/// Who an epoch adds and removes, after checking that the caller may make
/// that change, that each newcomer comes through an invitation they claimed,
/// that the head names the keys every member published, and that every
/// member of the new epoch receives its key.
async fn membership_change(
    tx: &mut Transaction<'_, Postgres>,
    w: &EpochWrite<'_>,
    owner: Uuid,
) -> Result<(BTreeSet<Uuid>, BTreeSet<Uuid>)> {
    let info = w.info;
    let now: BTreeSet<Uuid> =
        sqlx::query_scalar::<_, Uuid>("SELECT account_id FROM space_members WHERE space_id=$1")
            .bind(w.space)
            .fetch_all(&mut **tx)
            .await
            .map_err(db)?
            .into_iter()
            .collect();
    let next: BTreeSet<Uuid> = info.members.iter().map(|m| m.account_id).collect();
    let added: BTreeSet<Uuid> = next.difference(&now).copied().collect();
    let removed: BTreeSet<Uuid> = now.difference(&next).copied().collect();
    let pending: BTreeSet<Uuid> = sqlx::query_scalar::<_, Uuid>(
        "SELECT account_id FROM space_departures WHERE space_id=$1 AND rotated_at IS NULL",
    )
    .bind(w.space)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?
    .into_iter()
    .collect();
    if w.account != owner {
        // Anyone else only rotates the members who left out.
        let named: BTreeSet<Uuid> = info.departures.iter().copied().collect();
        if !added.is_empty() || !removed.is_empty() || pending.is_empty() || named != pending {
            return Err(Error::Forbidden);
        }
    }
    // Each newcomer comes through an invitation they claimed, admitted
    // once.
    let mut admitted = BTreeSet::new();
    for invitation in w.admit {
        let claimed: Option<Uuid> = sqlx::query_scalar("SELECT claimed_by FROM space_invitations WHERE id=$1 AND space_id=$2 AND admitted_at IS NULL AND revoked_at IS NULL")
                .bind(invitation)
                .bind(w.space)
                .fetch_optional(&mut **tx)
                .await
                .map_err(db)?
                .flatten();
        let claimed = claimed.ok_or(Error::Conflict)?;
        if !added.contains(&claimed) || !admitted.insert(claimed) {
            return Err(Error::Invalid);
        }
    }
    if admitted != added {
        return Err(Error::Invalid);
    }
    let accounts: Vec<Uuid> = next.iter().copied().collect();
    if !keys_match(info, &published(tx, &accounts).await?) {
        return Err(Error::Invalid);
    }
    // One key for this epoch per member; older epochs only for the
    // newcomers, who could not have had them.
    let mut current_wraps = BTreeSet::new();
    for wrap in w.wrapped {
        let history =
            wrap.epoch >= 1 && wrap.epoch < info.epoch && added.contains(&wrap.account_id);
        if !(next.contains(&wrap.account_id) && (wrap.epoch == info.epoch || history)) {
            return Err(Error::Invalid);
        }
        if wrap.epoch == info.epoch {
            current_wraps.insert(wrap.account_id);
        }
    }
    if current_wraps != next {
        return Err(Error::Invalid);
    }
    Ok((added, removed))
}

impl Repository {
    pub async fn identity(&self, owner: Uuid) -> Result<IdentityRecord> {
        let r = sqlx::query(
            "SELECT version,public_bundle,sealed_private FROM identity_keys WHERE account_id=$1",
        )
        .bind(owner)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?
        .ok_or(Error::NotFound)?;
        Ok(IdentityRecord {
            version: r.get("version"),
            public: r.get("public_bundle"),
            sealed_private: r.get("sealed_private"),
        })
    }
    /// Compare-and-swap like the vault. Keys an account is known by in a
    /// space cannot change under it: replacing an identity is refused while
    /// the account belongs to any space.
    pub async fn save_identity(
        &self,
        owner: Uuid,
        expected: i64,
        bundle: &Value,
        keys: &BundleKeys,
        sealed_private: &str,
    ) -> Result<i64> {
        if keys.account_id != owner || sealed_private.is_empty() || sealed_private.len() > 4096 {
            return Err(Error::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        super::lock_account(&mut tx, owner).await?;
        let version: i64 =
            sqlx::query_scalar("SELECT version FROM identity_keys WHERE account_id=$1")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .unwrap_or(0);
        if version != expected {
            return Err(Error::Conflict);
        }
        if version > 0 {
            let memberships: i64 =
                sqlx::query_scalar("SELECT count(*) FROM space_members WHERE account_id=$1")
                    .bind(owner)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(db)?;
            if memberships > 0 {
                return Err(Error::Conflict);
            }
        }
        sqlx::query("INSERT INTO identity_keys(account_id,version,public_bundle,x25519,ed25519,sealed_private) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET version=EXCLUDED.version,public_bundle=EXCLUDED.public_bundle,x25519=EXCLUDED.x25519,ed25519=EXCLUDED.ed25519,sealed_private=EXCLUDED.sealed_private,updated_at=now()")
            .bind(owner)
            .bind(version + 1)
            .bind(bundle)
            .bind(&keys.x25519)
            .bind(&keys.ed25519)
            .bind(sealed_private)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(version + 1)
    }

    pub async fn spaces(&self, account: Uuid) -> Result<Vec<SpaceSummary>> {
        let rows = sqlx::query(
            "SELECT s.id,s.owner_account_id,m.role,s.current_epoch,s.next_sequence-1 AS latest,s.created_at,
               (SELECT count(*) FROM space_members x WHERE x.space_id=s.id) AS members,
               (SELECT count(*) FROM space_departures d WHERE d.space_id=s.id AND d.rotated_at IS NULL) AS departures
             FROM space_members m JOIN spaces s ON s.id=m.space_id
             WHERE m.account_id=$1 ORDER BY s.created_at DESC",
        )
        .bind(account)
        .fetch_all(&self.pool)
        .await
        .map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| SpaceSummary {
                id: r.get("id"),
                owner_account_id: r.get("owner_account_id"),
                role: r.get("role"),
                current_epoch: r.get("current_epoch"),
                latest_sequence: r.get("latest"),
                member_count: r.get("members"),
                pending_departures: r.get("departures"),
                created_at: r.get("created_at"),
            })
            .collect())
    }

    /// A space is born at epoch 1 with its owner alone, the head signed by
    /// the owner and the key sealed to the owner.
    pub async fn create_space(
        &self,
        account: Uuid,
        head: &Value,
        info: &HeadInfo,
        wrapped: &WrappedKey,
    ) -> Result<()> {
        if info.epoch != 1
            || info.owner != account
            || info.author != account
            || info.members.len() != 1
            || !info.departures.is_empty()
            || wrapped.account_id != account
            || wrapped.epoch != 1
        {
            return Err(Error::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        super::lock_account(&mut tx, account).await?;
        let memberships: i64 =
            sqlx::query_scalar("SELECT count(*) FROM space_members WHERE account_id=$1")
                .bind(account)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if memberships >= MAX_MEMBERSHIPS {
            return Err(Error::Quota);
        }
        if !keys_match(info, &published(&mut tx, &[account]).await?) {
            return Err(Error::Invalid);
        }
        let created = sqlx::query("INSERT INTO spaces(id,owner_account_id,current_epoch) VALUES($1,$2,1) ON CONFLICT DO NOTHING")
            .bind(info.space_id)
            .bind(account)
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
        if created == 0 {
            return Err(Error::Conflict);
        }
        sqlx::query("INSERT INTO space_members(space_id,account_id,role,joined_epoch) VALUES($1,$2,'owner',1)")
            .bind(info.space_id)
            .bind(account)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        insert_head(&mut tx, info.space_id, info, head).await?;
        insert_wraps(&mut tx, info.space_id, std::slice::from_ref(wrapped)).await?;
        tx.commit().await.map_err(db)
    }

    pub async fn space_detail(&self, account: Uuid, space: Uuid) -> Result<SpaceDetail> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let my_role = role(&mut tx, space, account).await?;
        let s = sqlx::query("SELECT owner_account_id,current_epoch,next_sequence-1 AS latest FROM spaces WHERE id=$1")
            .bind(space)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let members = sqlx::query("SELECT m.account_id,m.role,m.joined_epoch,i.public_bundle FROM space_members m LEFT JOIN identity_keys i ON i.account_id=m.account_id WHERE m.space_id=$1 ORDER BY m.account_id")
            .bind(space)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?
            .iter()
            .map(|r| SpaceMember {
                account_id: r.get("account_id"),
                role: r.get("role"),
                joined_epoch: r.get("joined_epoch"),
                identity: r.get("public_bundle"),
            })
            .collect();
        let heads = sqlx::query(
            "SELECT epoch,head FROM space_epoch_heads WHERE space_id=$1 ORDER BY epoch",
        )
        .bind(space)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?
        .iter()
        .map(|r| SpaceHead {
            epoch: r.get("epoch"),
            head: r.get("head"),
        })
        .collect();
        let keys = sqlx::query("SELECT account_id,epoch,sealed FROM space_wrapped_keys WHERE space_id=$1 AND account_id=$2 ORDER BY epoch")
            .bind(space)
            .bind(account)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?
            .iter()
            .map(|r| WrappedKey {
                account_id: r.get("account_id"),
                epoch: r.get("epoch"),
                sealed: r.get("sealed"),
            })
            .collect();
        // Only the owner admits, so only the owner sees who is waiting.
        let invitations = if my_role == "owner" {
            sqlx::query("SELECT id,created_at,expires_at,claimed_by,acceptance FROM space_invitations WHERE space_id=$1 AND admitted_at IS NULL AND revoked_at IS NULL AND (expires_at>now() OR claimed_by IS NOT NULL) ORDER BY created_at")
                .bind(space)
                .fetch_all(&mut *tx)
                .await
                .map_err(db)?
                .iter()
                .map(|r| InvitationView {
                    id: r.get("id"),
                    created_at: r.get("created_at"),
                    expires_at: r.get("expires_at"),
                    claimed_by: r.get("claimed_by"),
                    acceptance: r.get("acceptance"),
                })
                .collect()
        } else {
            Vec::new()
        };
        let departures = sqlx::query("SELECT account_id,epoch,statement FROM space_departures WHERE space_id=$1 AND rotated_at IS NULL ORDER BY account_id")
            .bind(space)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?
            .iter()
            .map(|r| DepartureView {
                account_id: r.get("account_id"),
                epoch: r.get("epoch"),
                statement: r.get("statement"),
            })
            .collect();
        tx.commit().await.map_err(db)?;
        Ok(SpaceDetail {
            id: space,
            owner_account_id: s.get("owner_account_id"),
            current_epoch: s.get("current_epoch"),
            latest_sequence: s.get("latest"),
            members,
            heads,
            keys,
            invitations,
            departures,
        })
    }

    /// Every membership change, and every rotation, is one new epoch. The
    /// service keeps its rows equal to the head it is given; the devices
    /// decide whether the head is legitimate.
    pub async fn advance_epoch(&self, w: EpochWrite<'_>) -> Result<()> {
        let info = w.info;
        if info.space_id != w.space || info.author != w.account {
            return Err(Error::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let (owner, current) = lock_space(&mut tx, w.space).await?;
        role(&mut tx, w.space, w.account).await?;
        if info.epoch != current + 1 {
            return Err(Error::Conflict);
        }
        if info.owner != owner || info.member(owner).is_none_or(|m| !m.owner) {
            return Err(Error::Invalid);
        }
        let (added, removed) = membership_change(&mut tx, &w, owner).await?;
        insert_head(&mut tx, w.space, info, w.head).await?;
        insert_wraps(&mut tx, w.space, w.wrapped).await?;
        for gone in &removed {
            sqlx::query("DELETE FROM space_members WHERE space_id=$1 AND account_id=$2")
                .bind(w.space)
                .bind(gone)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM space_wrapped_keys WHERE space_id=$1 AND account_id=$2")
                .bind(w.space)
                .bind(gone)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        for newcomer in &added {
            sqlx::query("INSERT INTO space_members(space_id,account_id,role,joined_epoch) VALUES($1,$2,'member',$3)")
                .bind(w.space)
                .bind(newcomer)
                .bind(info.epoch)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        sqlx::query(
            "UPDATE space_invitations SET admitted_at=now() WHERE space_id=$1 AND id = ANY($2)",
        )
        .bind(w.space)
        .bind(w.admit)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query(
            "UPDATE space_departures SET rotated_at=now() WHERE space_id=$1 AND rotated_at IS NULL",
        )
        .bind(w.space)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query("UPDATE spaces SET current_epoch=$2 WHERE id=$1")
            .bind(w.space)
            .bind(info.epoch)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)
    }

    pub async fn delete_space(&self, account: Uuid, space: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let (owner, _) = lock_space(&mut tx, space).await?;
        role(&mut tx, space, account).await?;
        if owner != account {
            return Err(Error::Forbidden);
        }
        sqlx::query("DELETE FROM spaces WHERE id=$1")
            .bind(space)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)
    }

    pub async fn create_invitation(&self, w: InvitationWrite<'_>) -> Result<()> {
        if w.token_hash.len() != 43 || w.payload.is_empty() || w.payload.len() > 8192 {
            return Err(Error::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let (owner, _) = lock_space(&mut tx, w.space).await?;
        role(&mut tx, w.space, w.account).await?;
        if owner != w.account {
            return Err(Error::Forbidden);
        }
        let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM space_invitations WHERE space_id=$1 AND admitted_at IS NULL AND revoked_at IS NULL AND expires_at>now()")
            .bind(w.space)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let members: i64 =
            sqlx::query_scalar("SELECT count(*) FROM space_members WHERE space_id=$1")
                .bind(w.space)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if pending >= MAX_PENDING_INVITATIONS
            || members >= i64::try_from(subrosa_domain::space::MAX_MEMBERS).unwrap_or(i64::MAX)
        {
            return Err(Error::Quota);
        }
        let created = sqlx::query("INSERT INTO space_invitations(id,space_id,created_by,token_hash,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
            .bind(w.id)
            .bind(w.space)
            .bind(w.account)
            .bind(w.token_hash)
            .bind(w.payload)
            .bind(w.expires_at)
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
        if created == 0 {
            return Err(Error::Conflict);
        }
        tx.commit().await.map_err(db)
    }

    /// Revoking only ever takes something away.
    pub async fn revoke_invitation(&self, account: Uuid, space: Uuid, id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let (owner, _) = lock_space(&mut tx, space).await?;
        if owner != account {
            return Err(Error::NotFound);
        }
        let done = sqlx::query("UPDATE space_invitations SET revoked_at=now() WHERE id=$1 AND space_id=$2 AND admitted_at IS NULL AND revoked_at IS NULL")
            .bind(id)
            .bind(space)
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected();
        if done == 0 {
            return Err(Error::NotFound);
        }
        tx.commit().await.map_err(db)
    }

    /// The sealed payload, to whoever shows the token the link derives.
    /// Anything else is `404`, so an invitation's existence leaks nothing.
    pub async fn open_invitation(
        &self,
        id: Uuid,
        token_hash: &str,
    ) -> Result<(Uuid, String, DateTime<Utc>)> {
        let r = sqlx::query("SELECT space_id,token_hash,payload,expires_at FROM space_invitations WHERE id=$1 AND revoked_at IS NULL AND admitted_at IS NULL AND claimed_by IS NULL AND expires_at>now()")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        let stored: String = r.get("token_hash");
        if !bool::from(stored.as_bytes().ct_eq(token_hash.as_bytes())) {
            return Err(Error::NotFound);
        }
        Ok((r.get("space_id"), r.get("payload"), r.get("expires_at")))
    }

    /// One claim per invitation, by one account, whose published keys are
    /// the ones it presents.
    pub async fn accept_invitation(
        &self,
        account: Uuid,
        id: Uuid,
        token_hash: &str,
        acceptance: &Value,
        keys: &BundleKeys,
    ) -> Result<Uuid> {
        if keys.account_id != account {
            return Err(Error::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let r = sqlx::query("SELECT space_id,token_hash,claimed_by,expires_at,revoked_at,admitted_at FROM space_invitations WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        let stored: String = r.get("token_hash");
        let expires: DateTime<Utc> = r.get("expires_at");
        if !bool::from(stored.as_bytes().ct_eq(token_hash.as_bytes()))
            || r.get::<Option<DateTime<Utc>>, _>("revoked_at").is_some()
            || expires <= Utc::now()
        {
            return Err(Error::NotFound);
        }
        if r.get::<Option<Uuid>, _>("claimed_by").is_some()
            || r.get::<Option<DateTime<Utc>>, _>("admitted_at").is_some()
        {
            return Err(Error::Conflict);
        }
        let space: Uuid = r.get("space_id");
        let member: Option<String> = sqlx::query_scalar(
            "SELECT role FROM space_members WHERE space_id=$1 AND account_id=$2",
        )
        .bind(space)
        .bind(account)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if member.is_some() {
            return Err(Error::Conflict);
        }
        let published = published(&mut tx, &[account]).await?;
        if published.get(&account) != Some(&(keys.x25519.clone(), keys.ed25519.clone())) {
            return Err(Error::Invalid);
        }
        sqlx::query(
            "UPDATE space_invitations SET claimed_by=$2,claimed_at=now(),acceptance=$3 WHERE id=$1",
        )
        .bind(id)
        .bind(account)
        .bind(acceptance)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(space)
    }

    /// A member leaves at once: no more access, and a signed statement a
    /// remaining member rotates the key with. The owner cannot leave; the
    /// owner deletes the space.
    pub async fn leave_space(
        &self,
        account: Uuid,
        space: Uuid,
        epoch: i64,
        statement: &str,
    ) -> Result<()> {
        if statement.len() != 86 {
            return Err(Error::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let (owner, current) = lock_space(&mut tx, space).await?;
        role(&mut tx, space, account).await?;
        if owner == account {
            return Err(Error::Forbidden);
        }
        if epoch != current {
            return Err(Error::Conflict);
        }
        sqlx::query("DELETE FROM space_members WHERE space_id=$1 AND account_id=$2")
            .bind(space)
            .bind(account)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM space_wrapped_keys WHERE space_id=$1 AND account_id=$2")
            .bind(space)
            .bind(account)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO space_departures(space_id,account_id,epoch,statement) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(space)
            .bind(account)
            .bind(epoch)
            .bind(statement)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)
    }

    /// Writes are accepted under the current epoch only, from a current
    /// member, in the name of that member. A retry of a revision with the
    /// same bytes answers its first result; other bytes are a conflict.
    pub async fn append_space_objects(
        &self,
        account: Uuid,
        space: Uuid,
        objects: &[NewSpaceObject],
    ) -> Result<Vec<ObjectResult>> {
        let total: usize = objects.iter().map(|o| o.ciphertext.len()).sum();
        if objects.is_empty() || objects.len() > MAX_BATCH_OPERATIONS || total > MAX_BATCH_BYTES {
            return Err(Error::Invalid);
        }
        for object in objects {
            subrosa_domain::space::check_object(object)?;
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let (_, current) = lock_space(&mut tx, space).await?;
        role(&mut tx, space, account).await?;
        let mut results = Vec::with_capacity(objects.len());
        let mut added_bytes = 0i64;
        for object in objects {
            let existing = sqlx::query("SELECT sequence,object_id,kind,epoch,author_account_id,ciphertext,signature,deleted,parent_revision FROM space_objects WHERE space_id=$1 AND revision=$2")
                .bind(space)
                .bind(object.revision)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
            if let Some(r) = existing {
                let same = r.get::<Uuid, _>("object_id") == object.object_id
                    && r.get::<String, _>("kind") == object.kind
                    && r.get::<i64, _>("epoch") == object.epoch
                    && r.get::<Uuid, _>("author_account_id") == account
                    && r.get::<String, _>("ciphertext") == object.ciphertext
                    && r.get::<String, _>("signature") == object.signature
                    && r.get::<bool, _>("deleted") == object.deleted
                    && r.get::<Option<Uuid>, _>("parent_revision") == object.parent_revision;
                if !same {
                    return Err(Error::Conflict);
                }
                results.push(ObjectResult {
                    revision: object.revision,
                    sequence: r.get("sequence"),
                });
                continue;
            }
            if object.epoch != current {
                return Err(Error::Conflict);
            }
            let sequence: i64 = sqlx::query_scalar(
                "UPDATE spaces SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1",
            )
            .bind(space)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            sqlx::query("INSERT INTO space_objects(space_id,sequence,object_id,revision,parent_revision,kind,epoch,author_account_id,ciphertext,signature,deleted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
                .bind(space)
                .bind(sequence)
                .bind(object.object_id)
                .bind(object.revision)
                .bind(object.parent_revision)
                .bind(&object.kind)
                .bind(object.epoch)
                .bind(account)
                .bind(&object.ciphertext)
                .bind(&object.signature)
                .bind(object.deleted)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            added_bytes += i64::try_from(object.ciphertext.len()).unwrap_or(i64::MAX);
            results.push(ObjectResult {
                revision: object.revision,
                sequence,
            });
        }
        let room = sqlx::query(
            "UPDATE spaces SET used_bytes=used_bytes+$2 WHERE id=$1 AND used_bytes+$2<=$3",
        )
        .bind(space)
        .bind(added_bytes)
        .bind(MAX_SPACE_BYTES)
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if room == 0 {
            return Err(Error::Quota);
        }
        tx.commit().await.map_err(db)?;
        Ok(results)
    }

    pub async fn space_objects(
        &self,
        account: Uuid,
        space: Uuid,
        after: i64,
        limit: i64,
    ) -> Result<ObjectPage> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        role(&mut tx, space, account).await?;
        let latest: i64 = sqlx::query_scalar("SELECT next_sequence-1 FROM spaces WHERE id=$1")
            .bind(space)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if after > latest {
            return Err(Error::Invalid);
        }
        let rows = sqlx::query("SELECT sequence,object_id,revision,parent_revision,kind,epoch,author_account_id,ciphertext,signature,deleted,created_at FROM space_objects WHERE space_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3")
            .bind(space)
            .bind(after)
            .bind(limit + 1)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        let mut objects = Vec::new();
        let mut bytes = 0usize;
        let mut has_more = false;
        for row in &rows {
            let object = object_row(row);
            bytes += object.ciphertext.len() + 512;
            if objects.len() == usize::try_from(limit).unwrap_or(0)
                || (!objects.is_empty() && bytes > MAX_PAGE_BYTES)
            {
                has_more = true;
                break;
            }
            objects.push(object);
        }
        let cursor = objects.last().map_or(after, |o: &SpaceObject| o.sequence);
        Ok(ObjectPage {
            objects,
            cursor,
            has_more,
        })
    }
}
