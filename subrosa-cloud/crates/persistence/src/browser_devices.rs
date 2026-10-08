//! Browsers admitted as devices (ADR 0096). The service keeps the public half
//! of each browser's device key and nothing secret; admission is a pairing it
//! watched another device approve, or a value derived from the recovery key
//! that only the holder of that key can produce.
use super::{Repository, db, device_row, lock_account, record_event};
use sqlx::Row;
use subrosa_domain::{Device, Error, Result, SecurityEventKind, Session};
use subtle::ConstantTimeEq;
use uuid::Uuid;

/// How many live browser devices one account may hold. A person uses a few
/// browsers; more than this is a script admitting itself in a loop.
pub const MAX_BROWSER_DEVICES: i64 = 10;

/// The out-of-band half of an admission, already checked for shape.
pub enum Admission<'a> {
    /// A pairing request this browser session created and another, live app
    /// approved within the last five minutes.
    Pairing(Uuid),
    /// SHA-256 of the value the browser derived from the recovery key.
    Recovery(&'a [u8]),
}
pub struct NewBrowserDevice<'a> {
    pub session: &'a Session,
    pub name: &'a str,
    pub x: &'a str,
    pub y: &'a str,
    pub jkt: &'a str,
    pub admission: Admission<'a>,
}

impl Repository {
    /// Admits the browser in one transaction: the admission is consumed, the
    /// device row is written and the history line with it, or nothing is.
    pub async fn admit_browser_device(&self, p: NewBrowserDevice<'_>) -> Result<Device> {
        let owner = p.session.account.id;
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, owner).await?;
        let admitted = match p.admission {
            // Consumed by deletion, so one approval admits one browser. The
            // approver must still be a live app: a device revoked between its
            // approval and this call admits nobody.
            Admission::Pairing(id) => sqlx::query("DELETE FROM pairing_requests p WHERE p.id=$1 AND p.account_id=$2 AND p.requester_device_id IS NULL AND p.requester_hash=$3 AND p.expires_at>now() AND p.approved_at>now()-interval '5 minutes' AND EXISTS(SELECT 1 FROM devices d WHERE d.id=p.approved_by_device AND d.account_id=$2 AND d.kind='native' AND d.revoked_at IS NULL) RETURNING p.id")
                .bind(id)
                .bind(owner)
                .bind(&p.session.token_hash)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .is_some(),
            Admission::Recovery(proof_hash) => {
                let verifier: Option<Vec<u8>> = sqlx::query_scalar(
                    "SELECT admission_verifier FROM vaults WHERE account_id=$1",
                )
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .flatten();
                verifier.is_some_and(|v| bool::from(v.as_slice().ct_eq(proof_hash)))
            }
        };
        if !admitted {
            return Err(Error::AdmissionRequired);
        }
        let live: i64 = sqlx::query_scalar("SELECT count(*) FROM devices WHERE account_id=$1 AND kind='browser' AND revoked_at IS NULL")
            .bind(owner)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if live >= MAX_BROWSER_DEVICES {
            return Err(Error::Forbidden);
        }
        // The browser's admission time is the session's sign-in, so a browser
        // device is exactly as recent as the person who admitted it.
        let row = sqlx::query("INSERT INTO devices(id,account_id,name,kind,public_x,public_y,jkt,authenticated_at) VALUES($1,$2,$3,'browser',$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *")
            .bind(Uuid::now_v7())
            .bind(owner)
            .bind(p.name)
            .bind(p.x)
            .bind(p.y)
            .bind(p.jkt)
            .bind(p.session.authenticated_at)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(Error::Conflict)?;
        let device = device_row(&row);
        record_event(
            &mut tx,
            owner,
            SecurityEventKind::DeviceAdded,
            Some(device.id),
        )
        .await?;
        tx.commit().await.map_err(db)?;
        Ok(device)
    }
    /// The public key of a live browser device of `owner`, as `(x, y)`.
    pub async fn browser_device_key(&self, owner: Uuid, id: Uuid) -> Result<(String, String)> {
        let row = sqlx::query("SELECT public_x,public_y FROM devices WHERE account_id=$1 AND id=$2 AND kind='browser' AND revoked_at IS NULL")
            .bind(owner)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::DeviceProof)?;
        sqlx::query("UPDATE devices SET last_seen_at=now() WHERE id=$1 AND last_seen_at<now()-interval '1 minute'")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok((row.get("public_x"), row.get("public_y")))
    }
    /// Burns a proof identifier. A second use of the same one is a replay.
    pub async fn consume_device_proof(&self, jti_hash: &[u8]) -> Result<()> {
        let inserted = sqlx::query("INSERT INTO device_proofs(jti_hash,expires_at) VALUES($1,now()+interval '2 minutes') ON CONFLICT DO NOTHING")
            .bind(jti_hash)
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected();
        if inserted == 0 {
            Err(Error::DeviceProof)
        } else {
            Ok(())
        }
    }
}
