//! `PostgreSQL` repositories. Account row locks serialize quotas, journal cursors and deletion.
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use sqlx::{PgPool, Postgres, Row, Transaction};
use subrosa_domain::{
    Account, Change, Device, DeviceRequest, Error, Identity, JournalPage, LoginAttempt, Operation,
    OperationResult, Result, Secret, Session, Share, SharePreview, Vault,
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

#[derive(Clone)]
pub struct Repository {
    pool: PgPool,
}
fn db(error: sqlx::Error) -> Error {
    tracing::error!(kind = ?error.as_database_error().map(sqlx::error::DatabaseError::code), "database operation failed");
    drop(error);
    Error::Unavailable
}
fn account(row: &sqlx::postgres::PgRow) -> Account {
    Account {
        id: row.get("id"),
        email: row.get("email"),
        created_at: row.get("created_at"),
    }
}
impl Repository {
    pub async fn connect(url: &str) -> Result<Self> {
        Ok(Self {
            pool: sqlx::postgres::PgPoolOptions::new()
                .max_connections(20)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .connect(url)
                .await
                .map_err(db)?,
        })
    }
    pub async fn migrate(&self) -> Result<()> {
        sqlx::migrate!("../../migrations")
            .run(&self.pool)
            .await
            .map_err(|_| Error::Unavailable)
    }
    pub async fn healthy(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    pub async fn rate_limit(&self, key: &[u8], max: i32) -> Result<()> {
        let count: i32 = sqlx::query_scalar("INSERT INTO rate_limits(key) VALUES($1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limits.window_start < now() - interval '1 minute' THEN 1 ELSE rate_limits.count+1 END, window_start = CASE WHEN rate_limits.window_start < now() - interval '1 minute' THEN now() ELSE rate_limits.window_start END RETURNING count").bind(key).fetch_one(&self.pool).await.map_err(db)?;
        if count > max {
            Err(Error::RateLimited)
        } else {
            Ok(())
        }
    }
    pub async fn save_attempt(&self, a: &LoginAttempt) -> Result<()> {
        sqlx::query("INSERT INTO login_attempts(state_hash,browser_hash,verifier,nonce,return_to,native_request_id) VALUES($1,$2,$3,$4,$5,$6)").bind(&a.state_hash).bind(&a.browser_hash).bind(a.verifier.expose()).bind(a.nonce.expose()).bind(&a.return_to).bind(a.native_request_id).execute(&self.pool).await.map_err(db)?;
        Ok(())
    }
    pub async fn consume_attempt(&self, state: &[u8], browser: &[u8]) -> Result<LoginAttempt> {
        let r=sqlx::query("DELETE FROM login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *").bind(state).bind(browser).fetch_optional(&self.pool).await.map_err(db)?.ok_or(Error::Unauthorized)?;
        Ok(LoginAttempt {
            state_hash: r.get("state_hash"),
            browser_hash: r.get("browser_hash"),
            verifier: Secret(r.get("verifier")),
            nonce: Secret(r.get("nonce")),
            return_to: r.get("return_to"),
            native_request_id: r.get("native_request_id"),
        })
    }
    pub async fn browser_session(&self, identity: &Identity, token_hash: &[u8]) -> Result<Account> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let row=sqlx::query("INSERT INTO accounts(id,issuer,subject,email) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO UPDATE SET email=EXCLUDED.email RETURNING id,email,created_at").bind(Uuid::now_v7()).bind(&identity.issuer).bind(&identity.subject).bind(&identity.email).fetch_one(&mut *tx).await.map_err(db)?;
        let a = account(&row);
        sqlx::query("INSERT INTO sessions(token_hash,account_id,browser,authenticated_at,expires_at) VALUES($1,$2,true,$3,now()+interval '12 hours')").bind(token_hash).bind(a.id).bind(identity.authenticated_at).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(a)
    }
    pub async fn session(&self, hash: &[u8], browser: bool) -> Result<Session> {
        let row=sqlx::query("SELECT a.id,a.email,a.created_at,s.device_id,s.authenticated_at FROM sessions s JOIN accounts a ON a.id=s.account_id LEFT JOIN devices d ON d.id=s.device_id WHERE token_hash=$1 AND browser=$2 AND expires_at>now() AND (s.device_id IS NULL OR d.revoked_at IS NULL)").bind(hash).bind(browser).fetch_optional(&self.pool).await.map_err(db)?.ok_or(Error::Unauthorized)?;
        let device_id: Option<Uuid> = row.get("device_id");
        if let Some(id) = device_id {
            sqlx::query("UPDATE devices SET last_seen_at=now() WHERE id=$1 AND last_seen_at<now()-interval '1 minute'").bind(id).execute(&self.pool).await.map_err(db)?;
        }
        Ok(Session {
            account: account(&row),
            device_id,
            authenticated_at: row.get("authenticated_at"),
            browser,
            token_hash: hash.to_vec(),
        })
    }
    pub async fn logout(&self, hash: &[u8]) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("UPDATE session_families SET revoked_at=now() WHERE id=(SELECT family_id FROM sessions WHERE token_hash=$1)").bind(hash).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1 OR family_id IN (SELECT id FROM session_families WHERE revoked_at IS NOT NULL)").bind(hash).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)
    }
    pub async fn devices(&self, owner: Uuid) -> Result<Vec<Device>> {
        let rows =
            sqlx::query("SELECT * FROM devices WHERE account_id=$1 ORDER BY created_at DESC")
                .bind(owner)
                .fetch_all(&self.pool)
                .await
                .map_err(db)?;
        Ok(rows
            .iter()
            .map(|r| Device {
                id: r.get("id"),
                name: r.get("name"),
                created_at: r.get("created_at"),
                last_seen_at: r.get("last_seen_at"),
                revoked_at: r.get("revoked_at"),
                renewed_at: r.get("renewed_at"),
                renew_count: r.get("renew_count"),
            })
            .collect())
    }
    /// A label, not a credential: renaming never touches what the device may do.
    /// A revoked device keeps the name it had, so the list stays readable.
    pub async fn rename_device(&self, owner: Uuid, id: Uuid, name: &str) -> Result<()> {
        let count = sqlx::query(
            "UPDATE devices SET name=$1 WHERE account_id=$2 AND id=$3 AND revoked_at IS NULL",
        )
        .bind(name)
        .bind(owner)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(db)?
        .rows_affected();
        if count == 0 {
            Err(Error::NotFound)
        } else {
            Ok(())
        }
    }
    pub async fn revoke_device(&self, owner: Uuid, id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        // Clearing the secret is the point: revoking a device that could renew
        // itself without a browser would otherwise only pause it.
        let count=sqlx::query("UPDATE devices SET revoked_at=COALESCE(revoked_at,now()),secret_hash=NULL WHERE account_id=$1 AND id=$2").bind(owner).bind(id).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if count == 0 {
            return Err(Error::NotFound);
        }
        sqlx::query("DELETE FROM sessions WHERE account_id=$1 AND device_id=$2")
            .bind(owner)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM pairing_requests WHERE account_id=$1 AND requester_device_id=$2")
            .bind(owner)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE session_families SET revoked_at=COALESCE(revoked_at,now()) WHERE account_id=$1 AND device_id=$2").bind(owner).bind(id).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)
    }
    pub async fn create_device_request(&self, r: &DeviceRequest) -> Result<DateTime<Utc>> {
        sqlx::query_scalar("INSERT INTO device_requests(id,challenge,code_hash,start_hash,name,rebind_device_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING expires_at").bind(r.request_id).bind(&r.challenge).bind(&r.code_hash).bind(&r.start_hash).bind(&r.name).bind(r.rebind_device_id).fetch_one(&self.pool).await.map_err(db)
    }
    pub async fn approve_device(&self, session: &Session, code: &[u8]) -> Result<()> {
        let n=sqlx::query("UPDATE device_requests SET account_id=$1,authenticated_at=$2 WHERE code_hash=$3 AND account_id IS NULL AND NOT consumed AND expires_at>now()").bind(session.account.id).bind(session.authenticated_at).bind(code).execute(&self.pool).await.map_err(db)?.rows_affected();
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }
    pub async fn exchange_device(&self, p: DeviceExchangeParams<'_>) -> Result<IssuedSession> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let r=sqlx::query("SELECT *,last_poll>now()-interval '5 seconds' AS too_fast FROM device_requests WHERE id=$1 AND expires_at>now() AND NOT consumed FOR UPDATE").bind(p.request_id).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(Error::Unauthorized)?;
        // A request that ended in the browser is finished by its return code, a
        // request that showed a user code is finished without one, and neither
        // accepts the other. The verifier proves which app started it; the
        // return code proves which machine finished it. One half is never
        // enough, which is what replaced the human approval tap (ADR 0055).
        let expected: Option<Vec<u8>> = r.get("return_hash");
        let matches = bool::from(
            r.get::<Vec<u8>, _>("challenge")
                .as_slice()
                .ct_eq(p.challenge),
        ) && match (expected, p.return_hash) {
            (Some(expected), Some(given)) => bool::from(expected.as_slice().ct_eq(given)),
            (None, None) => true,
            _ => false,
        };
        if !matches {
            // Roll the read back, then count the failure on its own so it
            // survives. Polling with the right credentials is not a failure, so
            // a legitimate wait never approaches the bound.
            drop(tx);
            sqlx::query("UPDATE device_requests SET attempts=attempts+1,consumed=(attempts+1>=10) WHERE id=$1").bind(p.request_id).execute(&self.pool).await.map_err(db)?;
            return Err(Error::Unauthorized);
        }
        if r.get::<Option<bool>, _>("too_fast") == Some(true) {
            return Err(Error::RateLimited);
        }
        sqlx::query("UPDATE device_requests SET last_poll=now() WHERE id=$1")
            .bind(p.request_id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let Some(owner) = r.get::<Option<Uuid>, _>("account_id") else {
            tx.commit().await.map_err(db)?;
            return Err(Error::Pending);
        };
        let a = account(
            &sqlx::query("SELECT id,email,created_at FROM accounts WHERE id=$1 FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(Error::Unauthorized)?,
        );
        let family = Uuid::now_v7();
        let authenticated_at = r.get::<DateTime<Utc>, _>("authenticated_at");
        // Signing in again on a machine that already has a row is not a new
        // device. Reusing it keeps the list readable and keeps errands
        // addressed to this device deliverable. It grants nothing extra: the
        // exchange still required a fresh OIDC authentication just now.
        let rebind: Option<Uuid> = r.get("rebind_device_id");
        let reused = match rebind {
            Some(id) => sqlx::query_scalar::<_, Uuid>("UPDATE devices SET name=$3,last_seen_at=now(),secret_hash=$4,authenticated_at=$5,revoked_at=NULL WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id").bind(id).bind(owner).bind(r.get::<String,_>("name")).bind(p.device_secret_hash).bind(authenticated_at).fetch_optional(&mut *tx).await.map_err(db)?,
            None => None,
        };
        let device_id = if let Some(id) = reused {
            id
        } else {
            let id = Uuid::now_v7();
            sqlx::query("INSERT INTO devices(id,account_id,name,secret_hash,authenticated_at) VALUES($1,$2,$3,$4,$5)")
                .bind(id)
                .bind(owner)
                .bind(r.get::<String, _>("name"))
                .bind(p.device_secret_hash)
                .bind(authenticated_at)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            id
        };
        // A reused row may still carry families from the session it is
        // replacing. Retire them rather than leaving two live generations.
        sqlx::query(
            "UPDATE session_families SET revoked_at=COALESCE(revoked_at,now()) WHERE device_id=$1",
        )
        .bind(device_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query("DELETE FROM sessions WHERE device_id=$1")
            .bind(device_id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let refresh_expires_at=sqlx::query_scalar("INSERT INTO session_families(id,account_id,device_id,authenticated_at,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days') RETURNING expires_at").bind(family).bind(owner).bind(device_id).bind(authenticated_at).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO refresh_tokens(token_hash,family_id) VALUES($1,$2)")
            .bind(p.refresh_hash)
            .bind(family)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let expires_at=sqlx::query_scalar("INSERT INTO sessions(token_hash,account_id,device_id,browser,authenticated_at,expires_at,family_id) VALUES($1,$2,$3,false,$4,now()+interval '15 minutes',$5) RETURNING expires_at").bind(p.access_hash).bind(owner).bind(device_id).bind(authenticated_at).bind(family).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE device_requests SET consumed=true WHERE id=$1")
            .bind(p.request_id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(IssuedSession {
            account: a,
            device_id,
            expires_at,
            refresh_expires_at,
        })
    }
    pub async fn refresh_session(&self, p: RefreshParams<'_>) -> Result<IssuedSession> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        // Lock the family, not just the presented token: concurrent rotations/replays
        // must serialize even when they present different generations of its token.
        let r=sqlx::query("SELECT f.*,r.consumed_at FROM session_families f JOIN refresh_tokens r ON r.family_id=f.id JOIN devices d ON d.id=f.device_id WHERE r.token_hash=$1 AND f.expires_at>now() AND f.revoked_at IS NULL AND d.revoked_at IS NULL FOR UPDATE OF f").bind(p.refresh_hash).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(Error::Unauthorized)?;
        let family: Uuid = r.get("id");
        // Under READ COMMITTED a row-lock wait rechecks f but not the joined refresh
        // tuple. Read consumed_at again after acquiring the family lock.
        let consumed: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT consumed_at FROM refresh_tokens WHERE token_hash=$1")
                .bind(p.refresh_hash)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if consumed.is_some() {
            sqlx::query("UPDATE session_families SET revoked_at=now() WHERE id=$1")
                .bind(family)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM sessions WHERE family_id=$1")
                .bind(family)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
            return Err(Error::Unauthorized);
        }
        let owner: Uuid = r.get("account_id");
        let device_id: Uuid = r.get("device_id");
        let a = account(
            &sqlx::query("SELECT id,email,created_at FROM accounts WHERE id=$1")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?
                .ok_or(Error::Unauthorized)?,
        );
        sqlx::query("UPDATE refresh_tokens SET consumed_at=now() WHERE token_hash=$1")
            .bind(p.refresh_hash)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO refresh_tokens(token_hash,family_id) VALUES($1,$2)")
            .bind(p.new_refresh_hash)
            .bind(family)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let expires_at=sqlx::query_scalar("INSERT INTO sessions(token_hash,account_id,device_id,browser,authenticated_at,expires_at,family_id) VALUES($1,$2,$3,false,$4,LEAST(now()+interval '15 minutes',$5),$6) RETURNING expires_at").bind(p.new_access_hash).bind(owner).bind(device_id).bind(r.get::<DateTime<Utc>,_>("authenticated_at")).bind(r.get::<DateTime<Utc>,_>("expires_at")).bind(family).fetch_one(&mut *tx).await.map_err(db)?;
        let refresh_expires_at = r.get("expires_at");
        tx.commit().await.map_err(db)?;
        Ok(IssuedSession {
            account: a,
            device_id,
            expires_at,
            refresh_expires_at,
        })
    }
    /// Resolves the opaque handle in a native start link to the request it
    /// belongs to. Following this link starts an authentication and nothing
    /// else: it grants no session, and the code that finishes the request is
    /// not created until the person has actually signed in.
    pub async fn device_request_by_start(&self, start_hash: &[u8]) -> Result<Uuid> {
        sqlx::query_scalar("SELECT id FROM device_requests WHERE start_hash=$1 AND account_id IS NULL AND NOT consumed AND expires_at>now()").bind(start_hash).fetch_optional(&self.pool).await.map_err(db)?.ok_or(Error::NotFound)
    }
    /// The native end of the OIDC round trip: create or find the account, then
    /// bind this authentication to the waiting request together with the hash
    /// of the return code. No session row is written, so the browser this ran
    /// in keeps nothing.
    pub async fn native_callback(
        &self,
        identity: &Identity,
        request_id: Uuid,
        return_hash: &[u8],
    ) -> Result<Account> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let row=sqlx::query("INSERT INTO accounts(id,issuer,subject,email) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO UPDATE SET email=EXCLUDED.email RETURNING id,email,created_at").bind(Uuid::now_v7()).bind(&identity.issuer).bind(&identity.subject).bind(&identity.email).fetch_one(&mut *tx).await.map_err(db)?;
        let a = account(&row);
        let n=sqlx::query("UPDATE device_requests SET account_id=$1,authenticated_at=$2,return_hash=$3 WHERE id=$4 AND account_id IS NULL AND NOT consumed AND start_hash IS NOT NULL AND expires_at>now()").bind(a.id).bind(identity.authenticated_at).bind(return_hash).bind(request_id).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if n == 0 {
            return Err(Error::NotFound);
        }
        // A rebind is only honoured for the account that just authenticated.
        sqlx::query("UPDATE device_requests SET rebind_device_id=NULL WHERE id=$1 AND rebind_device_id IS NOT NULL AND rebind_device_id NOT IN (SELECT id FROM devices WHERE account_id=$2 AND revoked_at IS NULL)").bind(request_id).bind(a.id).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(a)
    }
    /// Proves a device secret without spending it, so a start request can name
    /// the row it means to reuse.
    pub async fn device_for_secret(&self, id: Uuid, secret_hash: &[u8]) -> Result<Uuid> {
        let stored: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT secret_hash FROM devices WHERE id=$1 AND revoked_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(db)?
        .flatten();
        match stored {
            Some(stored) if bool::from(stored.as_slice().ct_eq(secret_hash)) => Ok(id),
            _ => Err(Error::Unauthorized),
        }
    }
    /// A device that holds its secret mints a new token family without a
    /// browser. The family inherits the device's original admission instant,
    /// never `now()`, so a renewed session can never satisfy the five minute
    /// step-up that guards revocation and deletion (ADR 0056).
    pub async fn renew_session(&self, p: RenewParams<'_>) -> Result<IssuedSession> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let r=sqlx::query("SELECT d.account_id,d.authenticated_at,d.secret_hash,a.email,a.created_at FROM devices d JOIN accounts a ON a.id=d.account_id WHERE d.id=$1 AND d.revoked_at IS NULL AND d.secret_hash IS NOT NULL FOR UPDATE OF d").bind(p.device_id).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(Error::Unauthorized)?;
        if !bool::from(
            r.get::<Vec<u8>, _>("secret_hash")
                .as_slice()
                .ct_eq(p.secret_hash),
        ) {
            return Err(Error::Unauthorized);
        }
        let owner: Uuid = r.get("account_id");
        let a = Account {
            id: owner,
            email: r.get("email"),
            created_at: r.get("created_at"),
        };
        let authenticated_at: DateTime<Utc> = r.get("authenticated_at");
        // Exactly one live family per device. A cloned secret therefore shows
        // up as each copy cutting the other off, which renew_count makes
        // visible in the device list.
        sqlx::query("UPDATE session_families SET revoked_at=COALESCE(revoked_at,now()) WHERE device_id=$1 AND revoked_at IS NULL").bind(p.device_id).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("DELETE FROM sessions WHERE device_id=$1")
            .bind(p.device_id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let family = Uuid::now_v7();
        let refresh_expires_at=sqlx::query_scalar("INSERT INTO session_families(id,account_id,device_id,authenticated_at,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days') RETURNING expires_at").bind(family).bind(owner).bind(p.device_id).bind(authenticated_at).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO refresh_tokens(token_hash,family_id) VALUES($1,$2)")
            .bind(p.refresh_hash)
            .bind(family)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let expires_at=sqlx::query_scalar("INSERT INTO sessions(token_hash,account_id,device_id,browser,authenticated_at,expires_at,family_id) VALUES($1,$2,$3,false,$4,now()+interval '15 minutes',$5) RETURNING expires_at").bind(p.access_hash).bind(owner).bind(p.device_id).bind(authenticated_at).bind(family).fetch_one(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE devices SET renewed_at=now(),renew_count=renew_count+1,last_seen_at=now() WHERE id=$1").bind(p.device_id).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(IssuedSession {
            account: a,
            device_id: p.device_id,
            expires_at,
            refresh_expires_at,
        })
    }
    /// Signing out on the device itself. It proves the same secret a renewal
    /// would use, and asks for no step-up because it only takes access away.
    pub async fn renounce_device(&self, id: Uuid, secret_hash: &[u8]) -> Result<()> {
        let owner: Uuid = sqlx::query_scalar("SELECT account_id FROM devices WHERE id=$1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        self.device_for_secret(id, secret_hash).await?;
        self.revoke_device(owner, id).await
    }
    pub async fn changes(&self, p: PageParams<'_>) -> Result<JournalPage> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let watermark: i64 = sqlx::query_scalar("SELECT next_sequence FROM accounts WHERE id=$1")
            .bind(p.owner)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(Error::Unauthorized)?;
        if p.after > watermark {
            return Err(Error::Invalid);
        }
        let mut rows=sqlx::query("SELECT * FROM revisions WHERE account_id=$1 AND sequence>$2 AND sequence<=$3 AND ($4::text IS NULL OR kind=$4) ORDER BY sequence LIMIT $5").bind(p.owner).bind(p.after).bind(watermark).bind(p.kind).bind(p.limit+1).fetch(&mut *tx);
        let mut changes = Vec::new();
        let mut bytes = 128usize;
        let mut has_more = false;
        while let Some(r) = rows.try_next().await.map_err(db)? {
            let change = Change {
                resolved_revisions: r
                    .get::<sqlx::types::Json<Vec<Uuid>>, _>("resolved_revisions")
                    .0,
                sequence: r.get("sequence"),
                operation_id: r.get("operation_id"),
                object_id: r.get("object_id"),
                revision: r.get("revision"),
                parent_revision: r.get("parent_revision"),
                kind: r.get("kind"),
                ciphertext: r.get("ciphertext"),
                deleted: r.get("deleted"),
                device_id: r.get("device_id"),
            };
            let size = serde_json::to_vec(&change)
                .map_err(|_| Error::Unavailable)?
                .len()
                + 1;
            if changes.len() >= usize::try_from(p.limit).map_err(|_| Error::Invalid)?
                || bytes + size > 8 * 1024 * 1024
            {
                has_more = true;
                break;
            }
            bytes += size;
            changes.push(change);
        }
        drop(rows);
        tx.commit().await.map_err(db)?;
        // A completed filtered scan can advance past unrelated kinds, but only to the
        // snapshot watermark. Concurrent writes are observed on the next request.
        let cursor = if has_more {
            changes.last().map_or(p.after, |c| c.sequence)
        } else {
            watermark
        };
        Ok(JournalPage {
            changes,
            cursor,
            has_more,
        })
    }
    pub async fn append(&self, p: AppendParams<'_>) -> Result<Vec<OperationResult>> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.session.account.id).await?;
        // Recheck the session under the same account lock: deletion cannot race an upload.
        if !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now())",
        )
        .bind(&p.session.token_hash)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?
        {
            return Err(Error::Unauthorized);
        }
        let mut results = Vec::with_capacity(p.operations.len());
        for (op, digest) in p.operations {
            let old=sqlx::query("SELECT revision,sequence,conflict,operation_hash FROM revisions WHERE account_id=$1 AND operation_id=$2").bind(p.session.account.id).bind(op.operation_id).fetch_optional(&mut *tx).await.map_err(db)?;
            if let Some(r) = old {
                if r.get::<Vec<u8>, _>("operation_hash") != *digest {
                    return Err(Error::Conflict);
                }
                results.push(OperationResult {
                    operation_id: op.operation_id,
                    revision: r.get("revision"),
                    sequence: r.get("sequence"),
                    conflict: r.get("conflict"),
                });
                continue;
            }
            let heads: Vec<Uuid> = sqlx::query_scalar(
                "SELECT revision FROM revisions WHERE account_id=$1 AND object_id=$2 AND is_head",
            )
            .bind(p.session.account.id)
            .bind(op.object_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(db)?;
            if let Some(parent) = op.parent_revision {
                let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM revisions WHERE account_id=$1 AND object_id=$2 AND revision=$3)").bind(p.session.account.id).bind(op.object_id).bind(parent).fetch_one(&mut *tx).await.map_err(db)?;
                if !valid {
                    return Err(Error::Conflict);
                }
            }
            let mut acknowledged = op.resolved_revisions.clone();
            if let Some(parent) = op.parent_revision {
                acknowledged.push(parent);
            }
            for revision in &op.resolved_revisions {
                let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM revisions WHERE account_id=$1 AND object_id=$2 AND revision=$3)").bind(p.session.account.id).bind(op.object_id).bind(revision).fetch_one(&mut *tx).await.map_err(db)?;
                if !valid {
                    return Err(Error::Conflict);
                }
            }
            let conflict = heads.iter().any(|head| !acknowledged.contains(head));
            // Only explicitly authenticated, acknowledged heads may be retired. An
            // unseen concurrent head survives a resolution just like any other write.
            sqlx::query("UPDATE revisions SET is_head=false WHERE account_id=$1 AND object_id=$2 AND revision=ANY($3)").bind(p.session.account.id).bind(op.object_id).bind(&acknowledged).execute(&mut *tx).await.map_err(db)?;
            let bytes = i64::try_from(op.ciphertext.len() + 256).map_err(|_| Error::Quota)?;
            let sequence:Option<i64>=sqlx::query_scalar("UPDATE accounts SET next_sequence=next_sequence+1,used_bytes=used_bytes+$2 WHERE id=$1 AND used_bytes+$2<=$3 RETURNING next_sequence").bind(p.session.account.id).bind(bytes).bind(p.quota).fetch_optional(&mut *tx).await.map_err(db)?;
            let sequence = sequence.ok_or(Error::Quota)?;
            let revision = Uuid::now_v7();
            sqlx::query("INSERT INTO revisions(account_id,sequence,operation_id,operation_hash,object_id,revision,parent_revision,kind,ciphertext,deleted,conflict,device_id,resolved_revisions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)").bind(p.session.account.id).bind(sequence).bind(op.operation_id).bind(digest).bind(op.object_id).bind(revision).bind(op.parent_revision).bind(&op.kind).bind(&op.ciphertext).bind(op.deleted).bind(conflict).bind(p.session.device_id).bind(sqlx::types::Json(&op.resolved_revisions)).execute(&mut *tx).await.map_err(db)?;
            results.push(OperationResult {
                operation_id: op.operation_id,
                revision,
                sequence,
                conflict,
            });
        }
        tx.commit().await.map_err(db)?;
        Ok(results)
    }
    pub async fn vault(&self, owner: Uuid) -> Result<Vault> {
        let r = sqlx::query("SELECT version,envelope FROM vaults WHERE account_id=$1")
            .bind(owner)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        Ok(Vault {
            version: r.get("version"),
            envelope: r.get("envelope"),
        })
    }
    pub async fn save_vault(&self, p: VaultParams<'_>) -> Result<i64> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        let old=sqlx::query("SELECT version,octet_length(envelope::text)::bigint AS bytes FROM vaults WHERE account_id=$1").bind(p.owner).fetch_optional(&mut *tx).await.map_err(db)?;
        let version = old.as_ref().map_or(0, |r| r.get::<i64, _>("version"));
        if version != p.expected {
            return Err(Error::Conflict);
        }
        let old_bytes = old.map_or(0, |r| r.get::<i64, _>("bytes"));
        let new_bytes: i64 = sqlx::query_scalar("SELECT octet_length($1::jsonb::text)::bigint")
            .bind(p.envelope)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if sqlx::query(
            "UPDATE accounts SET used_bytes=used_bytes+$2 WHERE id=$1 AND used_bytes+$2<=$3",
        )
        .bind(p.owner)
        .bind(new_bytes - old_bytes)
        .bind(p.quota)
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected()
            == 0
        {
            return Err(Error::Quota);
        }
        sqlx::query("INSERT INTO vaults(account_id,version,envelope) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET version=EXCLUDED.version,envelope=EXCLUDED.envelope").bind(p.owner).bind(version+1).bind(p.envelope).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(version + 1)
    }
    pub async fn reserve_blob(&self, p: BlobParams<'_>) -> Result<BlobReservation> {
        // A committed intent accounts for storage before I/O. If the process dies after PUT,
        // retry and account deletion can still locate the orphan, without scanning a bucket.
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        let old=sqlx::query("SELECT bytes,digest FROM blobs WHERE account_id=$1 AND id=$2 UNION ALL SELECT bytes,digest FROM blob_intents WHERE account_id=$1 AND id=$2").bind(p.owner).bind(p.id).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(r) = old {
            if r.get::<Vec<u8>, _>("digest") != p.digest || r.get::<i64, _>("bytes") != p.bytes {
                return Err(Error::Conflict);
            }
        } else {
            if sqlx::query(
                "UPDATE accounts SET used_bytes=used_bytes+$2 WHERE id=$1 AND used_bytes+$2<=$3",
            )
            .bind(p.owner)
            .bind(p.bytes)
            .bind(p.quota)
            .execute(&mut *tx)
            .await
            .map_err(db)?
            .rows_affected()
                == 0
            {
                return Err(Error::Quota);
            }
            sqlx::query("INSERT INTO blob_intents(account_id,id,bytes,digest) VALUES($1,$2,$3,$4)")
                .bind(p.owner)
                .bind(p.id)
                .bind(p.bytes)
                .bind(p.digest)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        sqlx::query("INSERT INTO blobs(account_id,id,bytes,digest) SELECT account_id,id,bytes,digest FROM blob_intents WHERE account_id=$1 AND id=$2 ON CONFLICT DO NOTHING").bind(p.owner).bind(p.id).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("DELETE FROM blob_intents WHERE account_id=$1 AND id=$2")
            .bind(p.owner)
            .bind(p.id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        Ok(BlobReservation { tx })
    }
    pub async fn blob_exists(&self, owner: Uuid, id: Uuid) -> Result<()> {
        let yes: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM blobs WHERE account_id=$1 AND id=$2)")
                .bind(owner)
                .bind(id)
                .fetch_one(&self.pool)
                .await
                .map_err(db)?;
        if yes { Ok(()) } else { Err(Error::NotFound) }
    }
    pub async fn delete_account(&self, owner: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, owner).await?;
        sqlx::query("INSERT INTO blob_deletions(key) SELECT account_id::text || '/' || id::text FROM blobs WHERE account_id=$1 UNION SELECT account_id::text || '/' || id::text FROM blob_intents WHERE account_id=$1 ON CONFLICT DO NOTHING").bind(owner).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("DELETE FROM accounts WHERE id=$1")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)
    }
    /// Run on an isolated restored database before admitting traffic. Never on ordinary boot.
    pub async fn invalidate_restored_sessions(&self) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        for query in [
            "DELETE FROM pairing_requests",
            "DELETE FROM sessions",
            "DELETE FROM session_families",
            "DELETE FROM device_requests",
            "DELETE FROM login_attempts",
            "UPDATE devices SET revoked_at=COALESCE(revoked_at,now()),secret_hash=NULL",
        ] {
            sqlx::query(query).execute(&mut *tx).await.map_err(db)?;
        }
        tx.commit().await.map_err(db)
    }
    pub async fn reapply_deletion(&self, owner: Uuid) -> Result<()> {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=$1)")
            .bind(owner)
            .fetch_one(&self.pool)
            .await
            .map_err(db)?;
        if !exists {
            return Ok(());
        }
        match self.delete_account(owner).await {
            Ok(()) | Err(Error::Unauthorized) => Ok(()),
            Err(e) => Err(e),
        }
    }
    pub async fn cleanup_keys(&self) -> Result<Vec<String>> {
        sqlx::query_scalar("SELECT key FROM blob_deletions ORDER BY created_at LIMIT 100")
            .fetch_all(&self.pool)
            .await
            .map_err(db)
    }
    pub async fn cleaned_key(&self, key: &str) -> Result<()> {
        sqlx::query("DELETE FROM blob_deletions WHERE key=$1")
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(db)?;
        Ok(())
    }
    pub async fn create_pairing(&self, session: &Session, id: Uuid) -> Result<DateTime<Utc>> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, session.account.id).await?;
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pairing_requests WHERE account_id=$1 AND expires_at>now()",
        )
        .bind(session.account.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        if n >= 5 {
            return Err(Error::RateLimited);
        }
        let expires=sqlx::query_scalar("INSERT INTO pairing_requests(id,account_id,requester_hash,requester_device_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING expires_at").bind(id).bind(session.account.id).bind(&session.token_hash).bind(session.device_id).fetch_optional(&mut *tx).await.map_err(db)?.ok_or(Error::Conflict)?;
        tx.commit().await.map_err(db)?;
        Ok(expires)
    }
    pub async fn read_pairing(&self, session: &Session, id: Uuid) -> Result<serde_json::Value> {
        let r=sqlx::query("SELECT envelope,expires_at FROM pairing_requests WHERE id=$1 AND account_id=$2 AND ((requester_device_id IS NOT NULL AND requester_device_id IS NOT DISTINCT FROM $4::uuid) OR (requester_device_id IS NULL AND requester_hash=$3)) AND expires_at>now()").bind(id).bind(session.account.id).bind(&session.token_hash).bind(session.device_id).fetch_optional(&self.pool).await.map_err(db)?.ok_or(Error::NotFound)?;
        Ok(
            serde_json::json!({"envelope":r.get::<Option<String>,_>("envelope"),"expires_at":r.get::<DateTime<Utc>,_>("expires_at")}),
        )
    }
    pub async fn approve_pairing(&self, session: &Session, id: Uuid, envelope: &str) -> Result<()> {
        let n=sqlx::query("UPDATE pairing_requests SET envelope=$4 WHERE id=$1 AND account_id=$2 AND NOT ((requester_device_id IS NOT NULL AND requester_device_id IS NOT DISTINCT FROM $5::uuid) OR (requester_device_id IS NULL AND requester_hash=$3)) AND expires_at>now() AND envelope IS NULL").bind(id).bind(session.account.id).bind(&session.token_hash).bind(envelope).bind(session.device_id).execute(&self.pool).await.map_err(db)?.rows_affected();
        if n == 0 { Err(Error::Conflict) } else { Ok(()) }
    }
    pub async fn delete_pairing(&self, session: &Session, id: Uuid) -> Result<()> {
        let n = sqlx::query(
            "DELETE FROM pairing_requests WHERE id=$1 AND account_id=$2 AND ((requester_device_id IS NOT NULL AND requester_device_id IS NOT DISTINCT FROM $4::uuid) OR (requester_device_id IS NULL AND requester_hash=$3))",
        )
        .bind(id)
        .bind(session.account.id)
        .bind(&session.token_hash)
        .bind(session.device_id)
        .execute(&self.pool)
        .await
        .map_err(db)?
        .rows_affected();
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }
    /// Claims already-uploaded blobs for a new share.
    ///
    /// The blobs exist before the share does, because the upload route is the
    /// ordinary authenticated one and a lost response has to be retryable. What
    /// this adds is exclusivity: the unique index on `(account_id, blob_id)`
    /// rejects a blob another share already holds, which is what later lets
    /// release delete bytes without reading a manifest it has no key for.
    pub async fn create_share(&self, p: ShareParams<'_>) -> Result<Share> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        lock_account(&mut tx, p.owner).await?;
        // PostgreSQL sums a bigint into numeric, which does not decode as i64.
        // The cast is the difference between a 404 and an opaque 503.
        let bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(bytes),0)::bigint FROM blobs WHERE account_id=$1 AND id=ANY($2::uuid[])",
        )
        .bind(p.owner)
        .bind(p.blob_ids)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let counted: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM blobs WHERE account_id=$1 AND id=ANY($2::uuid[])",
        )
        .bind(p.owner)
        .bind(p.blob_ids)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        // Every position must resolve to a blob this account owns, and the ids
        // must be distinct: a share that names the same blob twice would free
        // it twice on release.
        if counted != i64::try_from(p.blob_ids.len()).unwrap_or(i64::MAX) {
            return Err(Error::NotFound);
        }
        let blobs = i32::try_from(p.blob_ids.len()).map_err(|_| Error::Invalid)?;
        sqlx::query(
            "INSERT INTO shares(id,account_id,expires_at,blobs,bytes) VALUES($1,$2,$3,$4,$5)",
        )
        .bind(p.id)
        .bind(p.owner)
        .bind(p.expires_at)
        .bind(blobs)
        .bind(bytes)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        for (position, blob) in p.blob_ids.iter().enumerate() {
            let position = i32::try_from(position).map_err(|_| Error::Invalid)?;
            if sqlx::query("INSERT INTO share_blobs(share_id,position,account_id,blob_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
                .bind(p.id)
                .bind(position)
                .bind(p.owner)
                .bind(blob)
                .execute(&mut *tx)
                .await
                .map_err(db)?
                .rows_affected()
                == 0
            {
                return Err(Error::Conflict);
            }
        }
        let created: DateTime<Utc> =
            sqlx::query_scalar("SELECT created_at FROM shares WHERE id=$1")
                .bind(p.id)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(Share {
            id: p.id,
            created_at: created,
            expires_at: p.expires_at,
            blobs,
            bytes,
        })
    }
    pub async fn shares(&self, owner: Uuid) -> Result<Vec<Share>> {
        Ok(sqlx::query("SELECT id,created_at,expires_at,blobs,bytes FROM shares WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 200")
            .bind(owner)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|row| Share {
                id: row.get("id"),
                created_at: row.get("created_at"),
                expires_at: row.get("expires_at"),
                blobs: row.get("blobs"),
                bytes: row.get("bytes"),
            })
            .collect())
    }
    /// Stops the service answering, now. The bytes go on the release queue that
    /// maintenance drains, rather than being deleted inline, so a storage
    /// outage cannot make a revocation fail.
    pub async fn revoke_share(&self, owner: Uuid, id: Uuid) -> Result<()> {
        let n = sqlx::query("UPDATE shares SET revoked_at=now() WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL")
            .bind(id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(db)?
            .rows_affected();
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }
    /// Read by anybody holding the link. Deliberately says nothing a stranger
    /// could not already infer from the ciphertext they are about to fetch.
    pub async fn share_preview(&self, id: Uuid) -> Result<SharePreview> {
        let row = sqlx::query("SELECT blobs,bytes,expires_at FROM shares WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        Ok(SharePreview {
            v: 1,
            blobs: row.get("blobs"),
            bytes: row.get("bytes"),
            expires_at: row.get("expires_at"),
        })
    }
    /// Resolves a position, never a blob id: the reader cannot name bytes, only
    /// ask for the next piece of the share they already hold a link to.
    pub async fn share_blob(&self, id: Uuid, position: i32) -> Result<(Uuid, Uuid)> {
        let row = sqlx::query("SELECT sb.account_id,sb.blob_id FROM share_blobs sb JOIN shares s ON s.id=sb.share_id WHERE sb.share_id=$1 AND sb.position=$2 AND s.revoked_at IS NULL AND s.expires_at>now()")
            .bind(id)
            .bind(position)
            .fetch_optional(&self.pool)
            .await
            .map_err(db)?
            .ok_or(Error::NotFound)?;
        Ok((row.get("account_id"), row.get("blob_id")))
    }
    /// Drains expired and revoked shares: the storage keys go on the same
    /// durable deletion queue account removal uses, the rows go, and the bytes
    /// come back off the quota. This is the garbage collection the service
    /// otherwise has none of, and the reason a share can cost quota at all.
    pub async fn release_shares(&self) -> Result<()> {
        loop {
            let Some(row) = sqlx::query("SELECT id,account_id FROM shares WHERE revoked_at IS NOT NULL OR expires_at<=now() ORDER BY expires_at LIMIT 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?
            else {
                return Ok(());
            };
            let (id, owner): (Uuid, Uuid) = (row.get("id"), row.get("account_id"));
            let mut tx = self.pool.begin().await.map_err(db)?;
            lock_account(&mut tx, owner).await?;
            let freed:i64=sqlx::query_scalar("WITH gone AS (DELETE FROM blobs b USING share_blobs sb WHERE sb.share_id=$1 AND b.account_id=sb.account_id AND b.id=sb.blob_id RETURNING b.account_id,b.id,b.bytes), queued AS (INSERT INTO blob_deletions(key) SELECT account_id::text||'/'||id::text FROM gone ON CONFLICT DO NOTHING) SELECT COALESCE(SUM(bytes),0)::bigint FROM gone").bind(id).fetch_one(&mut *tx).await.map_err(db)?;
            sqlx::query("UPDATE accounts SET used_bytes=GREATEST(0,used_bytes-$2) WHERE id=$1")
                .bind(owner)
                .bind(freed)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            sqlx::query("DELETE FROM shares WHERE id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
            tx.commit().await.map_err(db)?;
        }
    }
    pub async fn prune_auth(&self) -> Result<()> {
        for q in [
            "DELETE FROM pairing_requests WHERE expires_at<now()",
            "DELETE FROM session_families WHERE expires_at<now()",
            "DELETE FROM login_attempts WHERE expires_at<now()",
            "DELETE FROM device_requests WHERE expires_at<now()",
            "DELETE FROM sessions WHERE expires_at<now()",
            "DELETE FROM rate_limits WHERE window_start<now()-interval '2 minutes'",
        ] {
            sqlx::query(q).execute(&self.pool).await.map_err(db)?;
        }
        Ok(())
    }
}
async fn lock_account(tx: &mut Transaction<'_, Postgres>, owner: Uuid) -> Result<()> {
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db)?
        .ok_or(Error::Unauthorized)?;
    Ok(())
}
pub struct AppendParams<'a> {
    pub session: &'a Session,
    pub operations: &'a [(Operation, Vec<u8>)],
    pub quota: i64,
}
pub struct VaultParams<'a> {
    pub owner: Uuid,
    pub expected: i64,
    pub envelope: &'a serde_json::Value,
    pub quota: i64,
}
pub struct ShareParams<'a> {
    pub owner: Uuid,
    pub id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub blob_ids: &'a [Uuid],
}
pub struct BlobParams<'a> {
    pub owner: Uuid,
    pub id: Uuid,
    pub bytes: i64,
    pub digest: &'a [u8],
    pub quota: i64,
}
pub struct BlobReservation {
    tx: Transaction<'static, Postgres>,
}
impl BlobReservation {
    pub async fn commit(self) -> Result<()> {
        self.tx.commit().await.map_err(db)
    }
}

pub struct PageParams<'a> {
    pub owner: Uuid,
    pub after: i64,
    pub limit: i64,
    pub kind: Option<&'a str>,
}

pub struct DeviceExchangeParams<'a> {
    pub request_id: Uuid,
    pub challenge: &'a [u8],
    /// `Some` only for a native request, and then it is required.
    pub return_hash: Option<&'a [u8]>,
    pub access_hash: &'a [u8],
    pub refresh_hash: &'a [u8],
    pub device_secret_hash: &'a [u8],
}
pub struct RenewParams<'a> {
    pub device_id: Uuid,
    pub secret_hash: &'a [u8],
    pub access_hash: &'a [u8],
    pub refresh_hash: &'a [u8],
}
pub struct RefreshParams<'a> {
    pub refresh_hash: &'a [u8],
    pub new_access_hash: &'a [u8],
    pub new_refresh_hash: &'a [u8],
}
pub struct IssuedSession {
    pub account: Account,
    pub device_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub refresh_expires_at: DateTime<Utc>,
}
