//! Durable object synchronization. SQLite triggers journal the same transaction
//! as a local edit. A frozen payload is retried with the same operation id.
//! Inbound revisions and cursor commit together; conflicts never overwrite.
use super::*;
use sqlx_sqlite::SqliteConnection;
use tauri::Emitter;

pub const CREDENTIAL_ID: &str = "00000000-0000-4000-8000-000000000001";
pub use super::sync_issues::SyncIssue;
pub(super) use super::sync_issues::{
    isolatable_file_error, isolatable_outbox_error, issue_count, issues, reconcile_issues,
    record_issue, record_issue_on, retry_issues,
};
use super::sync_tables::{object_column, object_of, Table, TABLES};
const UUID_SQL:&str="(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))))";
fn table(name: &str) -> Result<&'static Table, AppError> {
    // A distinct authenticated wire codec is mandatory: older clients ignore
    // unknown extra fields on agent_tasks and default unknown safety profiles.
    // They must reject the entire conversation rather than lose its permissions.
    let name = if name == "assistant_conversations" {
        "agent_tasks"
    } else {
        name
    };
    TABLES
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| error("sync_format_invalid"))
}
fn row_json(t: &Table, prefix: &str) -> String {
    let object = format!(
        "json_object({})",
        t.columns
            .iter()
            .filter(|c| !(t.name == "memories" && **c == "scope"))
            .map(|c| format!("'{c}',{prefix}{c}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    // A memory carries its scope only when it has one (ADR-0085). The
    // person's own memories keep the shape every device already reads; a
    // project's is refused by a device too old to know scopes, which is the
    // safe outcome: applied without its scope, it would join the person's
    // own memory there.
    if t.name == "memories" {
        format!("json_patch({object},CASE WHEN {prefix}scope IS NULL THEN '{{}}' ELSE json_object('scope',{prefix}scope) END)")
    } else {
        object
    }
}
fn snapshot_body(t: &Table, prefix: &str) -> String {
    if t.name == "agent_tasks" {
        format!("json_object('table',CASE WHEN {prefix}safety_profile='custom_assistant' THEN 'assistant_conversations' ELSE 'agent_tasks' END,'row',{},'assistant_snapshot',json((SELECT snapshot_json FROM assistant_conversations WHERE task_id={prefix}id)))",row_json(t,prefix))
    } else if t.name == "notes" {
        format!(
            "json_object('table','notes','row',{},'summary',{})",
            row_json(t, prefix),
            super::summaries::snapshot(&format!("{prefix}id"))
        )
    } else {
        format!(
            "json_object('table','{}','row',{})",
            t.name,
            row_json(t, prefix)
        )
    }
}
/// A temporary chat (ADR-0083) never leaves the device: its task and its
/// messages queue nothing, not even the tombstone of their deletion. The
/// messages of a temporary chat are deleted before the chat itself, so the
/// parent row is still there to be asked.
fn stays_local(t: &Table, prefix: &str) -> String {
    match t.name {
        "agent_tasks" => format!(" AND {prefix}ephemeral=0"),
        "agent_messages" => outside_temporary_chat(prefix),
        "saved_items" => super::saved_items::outside_temporary_chat(prefix),
        // Health and finances leave only by the person's own choice on this
        // device (ADR-0099). A received row is applied with `applying=1`, so
        // a device that never opted in still shows what another one sent.
        "health_days" => {
            format!(" AND {prefix}metric IN (SELECT metric FROM health_metrics WHERE sync=1)")
        }
        "transactions" | "finance_rules" => {
            " AND (SELECT sync FROM finance_settings WHERE id=1)=1".to_string()
        }
        // A connector row is named before it can leave (`object_column`).
        "connectors" => format!(" AND {prefix}object_id IS NOT NULL"),
        _ => String::new(),
    }
}
/// Queues the rows of `table_name` matching `filter` that have never left
/// this device: what a person kept local until they opted in (ADR-0099).
/// A library with no account queues nothing; its first inventory will.
pub(crate) async fn enqueue_existing(
    pool: &SqlitePool,
    table_name: &str,
    filter: &str,
) -> Result<(), AppError> {
    let t = table(table_name)?;
    let bound = query("SELECT 1 FROM account_sync_control WHERE id=1 AND account_id IS NOT NULL")
        .fetch_optional(pool)
        .await?
        .is_some();
    if !bound {
        return Ok(());
    }
    let object = object_column(t);
    query(&format!("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) SELECT {UUID_SQL},{object},'{}',{},0 FROM {} WHERE {object} NOT IN (SELECT object_id FROM account_sync_outbox) AND {object} NOT IN (SELECT object_id FROM account_sync_heads) AND ({filter}){}",t.kind,snapshot_body(t,&format!("{}.",t.name)),t.name,stays_local(t,&format!("{}.",t.name)))).execute(pool).await?;
    Ok(())
}
/// For a row that belongs to a chat through its `task_id`.
fn outside_temporary_chat(prefix: &str) -> String {
    format!(" AND NOT EXISTS(SELECT 1 FROM agent_tasks WHERE agent_tasks.id={prefix}task_id AND agent_tasks.ephemeral=1)")
}
/// Only a change to a column that travels is a change worth sending. Without
/// this, a local-only write (a memory's embedding) or a write that changes
/// nothing re-sent the whole row, and every device that did the same thing
/// left the others a sibling revision to review.
fn changed_columns(t: &Table) -> String {
    format!(
        " AND ({})",
        t.columns
            .iter()
            .map(|c| format!("OLD.{c} IS NOT NEW.{c}"))
            .collect::<Vec<_>>()
            .join(" OR ")
    )
}
/// The trigger statements that queue a snapshot of `object`. Every row carries
/// the whole object, so a newer edit rewrites the object's last unsent row in
/// place instead of queueing another: a recording's once-a-second checkpoint
/// used to leave thousands of rows for one object. The row keeps its place, so
/// a note still leaves before the transcript that needs it. A row that may
/// already be on the server (sealed: its operation id is the retry key), a
/// resolution (it names the siblings a person acknowledged) and a row held
/// back by an issue are never rewritten; the edit queues after them.
///
/// `from` is empty, or a `FROM … WHERE …` naming the row the snapshot reads.
fn enqueue(object: &str, kind: &str, body: &str, deleted: u8, from: &str) -> String {
    let last = format!("sequence=(SELECT MAX(sequence) FROM account_sync_outbox WHERE object_id={object}) AND kind='{kind}' AND ciphertext IS NULL AND resolved_revisions='[]' AND operation_id NOT IN (SELECT item_id FROM account_sync_issues WHERE lane='outbox')");
    let join = if from.contains(" WHERE ") {
        " AND"
    } else {
        " WHERE"
    };
    format!("UPDATE account_sync_outbox SET body=(SELECT {body}{from}),deleted={deleted} WHERE {last} AND EXISTS(SELECT 1{from}); INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) SELECT {UUID_SQL},{object},'{kind}',{body},{deleted}{from}{join} NOT EXISTS(SELECT 1 FROM account_sync_outbox WHERE {last});")
}
/// Installs the outbox triggers as one set, in one transaction, and only
/// when their definition changed: the set's digest is ledgered next to the
/// migration files, so an ordinary launch costs one lookup. One transaction
/// matters twice. No write can land between a DROP and its CREATE unrecorded,
/// and a launch racing another sees one schema change instead of a hundred
/// (each one invalidates the other connections' prepared statements). The
/// write lock is taken up front, because upgrading a read lock while another
/// launch migrates fails at once instead of waiting its turn.
async fn install_managed(
    pool: &SqlitePool,
    triggers: &[(String, String)],
) -> Result<(), sqlx::error::Error> {
    use sha2::Digest as _;
    const LEDGER: &str = "account_sync_triggers";
    let mut digest = sha2::Sha256::new();
    for (name, sql) in triggers {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(sql.as_bytes());
        digest.update([0]);
    }
    let sum: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let recorded = "SELECT checksum FROM schema_migrations WHERE name=?";
    let current = |row: Option<sqlx_sqlite::SqliteRow>| {
        row.is_some_and(|row| row.get::<String, _>("checksum") == sum)
    };
    if current(query(recorded).bind(LEDGER).fetch_optional(pool).await?) {
        return Ok(());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    // Another launch may have installed them while this one waited.
    if !current(
        query(recorded)
            .bind(LEDGER)
            .fetch_optional(&mut *tx)
            .await?,
    ) {
        for (name, sql) in triggers {
            query(&format!("DROP TRIGGER IF EXISTS {name}"))
                .execute(&mut *tx)
                .await?;
            query(sql).execute(&mut *tx).await?;
        }
        query("INSERT INTO schema_migrations(name,checksum,applied_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET checksum=excluded.checksum,applied_at=excluded.applied_at")
            .bind(LEDGER)
            .bind(&sum)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}
/// Installed only after the additive schema migration. The trigger body is
/// executed as one SQLite statement, not fed to the legacy semicolon splitter.
pub async fn install(pool: &SqlitePool) -> Result<(), sqlx::error::Error> {
    // `install_managed` replaces the whole set whenever its definition
    // changes, so an older database picks up every one of these, not only the
    // task triggers that used to be dropped at each launch.
    let mut managed = Vec::new();
    for t in TABLES {
        for (action, prefix, deleted) in [
            ("INSERT", "NEW.", 0u8),
            ("UPDATE", "NEW.", 0),
            ("DELETE", "OLD.", 1),
        ] {
            let gate = if t.name == "agent_tasks" && action == "INSERT" {
                " AND NEW.safety_profile<>'custom_assistant'".to_string()
            } else if action == "UPDATE" {
                changed_columns(t)
            } else {
                String::new()
            } + &stays_local(t, prefix);
            let name = format!("account_sync_{}_{}", t.name, action.to_lowercase());
            let sql=format!("CREATE TRIGGER {name} AFTER {action} ON {} WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1){gate} BEGIN {} END",t.name,enqueue(&format!("{prefix}{}",object_column(t)),t.kind,&snapshot_body(t,prefix),deleted,""));
            managed.push((name, sql));
        }
    }
    let tasks = TABLES
        .iter()
        .find(|t| t.name == "agent_tasks")
        .ok_or_else(|| sqlx::error::Error::Protocol("task schema missing".into()))?;
    for action in ["INSERT", "UPDATE"] {
        let name = format!("account_assistant_snapshot_{}", action.to_lowercase());
        let sql = format!("CREATE TRIGGER {name} AFTER {action} ON assistant_conversations WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1){} BEGIN {} END",outside_temporary_chat("NEW."),enqueue("NEW.task_id","conversation",&snapshot_body(tasks,"agent_tasks."),0," FROM agent_tasks WHERE agent_tasks.id=NEW.task_id"));
        managed.push((name, sql));
    }
    let notes = TABLES
        .iter()
        .find(|t| t.name == "notes")
        .ok_or_else(|| sqlx::error::Error::Protocol("notes sync schema unavailable".into()))?;
    for (action, prefix, ready) in [
        ("INSERT", "NEW.", " AND NEW.status='ready'"),
        ("UPDATE", "NEW.", " AND NEW.status='ready'"),
        ("DELETE", "OLD.", ""),
    ] {
        let name = format!("account_summary_{}", action.to_lowercase());
        let sql = format!("CREATE TRIGGER {name} AFTER {action} ON note_summaries WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1){ready} BEGIN {} END",enqueue(&format!("{prefix}note_id"),"note",&snapshot_body(notes,"notes."),0,&format!(" FROM notes WHERE notes.id={prefix}note_id")));
        managed.push((name, sql));
    }
    managed.extend(super::session_folders::triggers(UUID_SQL));
    install_managed(pool, &managed).await?;
    query(&format!("CREATE TRIGGER IF NOT EXISTS account_membership_insert AFTER INSERT ON note_folders WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1) BEGIN INSERT INTO account_note_folders(id,note_id,folder_id,assigned_at) SELECT {UUID_SQL},NEW.note_id,NEW.folder_id,NEW.assigned_at WHERE NOT EXISTS(SELECT 1 FROM account_note_folders WHERE note_id=NEW.note_id AND folder_id=NEW.folder_id); UPDATE account_note_folders SET deleted=0,assigned_at=NEW.assigned_at WHERE note_id=NEW.note_id AND folder_id=NEW.folder_id; END")).execute(pool).await?;
    query("CREATE TRIGGER IF NOT EXISTS account_membership_delete AFTER DELETE ON note_folders WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1) BEGIN UPDATE account_note_folders SET deleted=1 WHERE note_id=OLD.note_id AND folder_id=OLD.folder_id; END").execute(pool).await?;
    query(&format!("CREATE TRIGGER IF NOT EXISTS account_usage_insert AFTER INSERT ON egress_ledger WHEN NEW.method='POST' AND NEW.purpose IN ('chat','transcription','embeddings','note generation','dictation','image','video','speech','music','ask') AND (SELECT account_id IS NOT NULL AND device_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1) BEGIN INSERT INTO account_usage(id,device_id,day,model,request_count,request_bytes,response_bytes) VALUES ({UUID_SQL},(SELECT device_id FROM account_sync_control WHERE id=1),substr(NEW.at,1,10),COALESCE(NEW.model,''),1,NEW.request_bytes,NEW.response_bytes) ON CONFLICT(device_id,day,model) DO UPDATE SET request_count=request_count+1,request_bytes=request_bytes+NEW.request_bytes,response_bytes=response_bytes+NEW.response_bytes; END")).execute(pool).await?;
    Ok(())
}
pub async fn set_enabled(pool: &SqlitePool, enabled: bool) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    if enabled {
        query(&format!("INSERT INTO account_note_folders(id,note_id,folder_id,assigned_at) SELECT {UUID_SQL},nf.note_id,nf.folder_id,nf.assigned_at FROM note_folders nf WHERE NOT EXISTS(SELECT 1 FROM account_note_folders s WHERE s.note_id=nf.note_id AND s.folder_id=nf.folder_id)")).execute(&mut *tx).await?;
        super::session_folders::backfill(&mut tx, UUID_SQL).await?;
        let count: i64 = query("SELECT count(*) AS n FROM account_sync_heads")
            .fetch_one(&mut *tx)
            .await?
            .get("n");
        // The first inventory is captured in the same write transaction as enable.
        if count == 0 {
            for t in TABLES {
                let object = object_column(t);
                let sql=format!("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) SELECT {UUID_SQL},{object},'{}',{},0 FROM {} WHERE {object} NOT IN (SELECT object_id FROM account_sync_outbox){}",t.kind,snapshot_body(t,&format!("{}.",t.name)),t.name,stays_local(t,&format!("{}.",t.name)));
                query(&sql).execute(&mut *tx).await?;
            }
        }
        // Saved items joined the registry after most accounts took their first
        // inventory (ADR-0088): what was saved before that leaves now.
        let saved = table("saved_items")?;
        query(&format!("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) SELECT {UUID_SQL},id,'{}',{},0 FROM saved_items WHERE id NOT IN (SELECT object_id FROM account_sync_outbox) AND id NOT IN (SELECT object_id FROM account_sync_heads){}",saved.kind,snapshot_body(saved,"saved_items."),stays_local(saved,"saved_items."))).execute(&mut *tx).await?;
    }
    query("UPDATE account_sync_control SET enabled=? WHERE id=1")
        .bind(enabled)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
fn aad(s: &Session, kind: &str, id: &str) -> String {
    format!("subrosa:object:v1:{}:{kind}:{id}", s.account.id)
}
#[derive(Deserialize)]
struct Change {
    sequence: i64,
    #[serde(default)]
    resolved_revisions: Vec<String>,
    object_id: String,
    revision: String,
    parent_revision: Option<String>,
    kind: String,
    ciphertext: String,
    deleted: bool,
    operation_id: Option<String>,
}
#[derive(Deserialize)]
struct Page {
    changes: Vec<Change>,
    cursor: i64,
    has_more: bool,
}
#[derive(Deserialize)]
struct PushResult {
    operation_id: String,
    revision: String,
    sequence: i64,
    /// The service kept another head next to this one. The pull preserves
    /// that branch as a card; listing this device's own revision as one
    /// would ask the person to review a value already on screen.
    #[allow(dead_code)]
    conflict: bool,
}
#[derive(Deserialize)]
struct PushResults {
    results: Vec<PushResult>,
}
pub async fn resume(app: &AppHandle) {
    if let Err(e) = run(app).await {
        if !matches!(e.code.as_str(), "account_not_connected" | "vault_locked") {
            tracing::warn!(code=%e.code,"account synchronization deferred");
        }
    }
}
pub async fn run(app: &AppHandle) -> Result<(), AppError> {
    let result = tokio::time::timeout(Duration::from_secs(30), run_inner(app))
        .await
        .unwrap_or_else(|_| Err(error("sync_timeout")));
    if let Err(failure) = &result {
        if let Ok(pool) = pool(app).await {
            let _ =
                query("UPDATE account_sync_control SET last_sync_error=? WHERE id=1 AND enabled=1")
                    .bind(&failure.code)
                    .execute(&pool)
                    .await;
            let _ = app.emit("subrosa://sync-updated", json!({"error":failure.code}));
        }
    }
    result
}
async fn run_inner(app: &AppHandle) -> Result<(), AppError> {
    #[cfg(desktop)]
    let _ = super::conversations::backfill_desktop(app).await;
    // A pass under way is let finish rather than skipped in silence: a
    // person who asked for a sync, or a wake-up the waiter delivered, would
    // otherwise be lost to a chat mirror holding the lock for a moment.
    let Ok(_guard) = tokio::time::timeout(Duration::from_secs(10), SESSION_LOCK.lock()).await
    else {
        return Ok(());
    };
    let _background = crate::ios_background::BackgroundTask::begin("account-sync");
    let pool = pool(app).await?;
    let enabled: i64 = query("SELECT enabled FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?
        .get("enabled");
    if enabled == 0 {
        return Ok(());
    }
    let s = session(&pool).await?;
    let key = vault_key(&s)?;
    let had_error: Option<String> =
        query("SELECT last_sync_error FROM account_sync_control WHERE id=1")
            .fetch_one(&pool)
            .await?
            .get("last_sync_error");
    let transfers_before = super::files::pending_transfers(&pool).await.unwrap_or(0);
    let summary = synchronize(&pool, &s, &key).await?;
    if summary.applied > 0 {
        query("UPDATE account_sync_control SET last_received_at=? WHERE id=1")
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await?;
    }
    let file_result = super::files::step(app, &pool, &s, &key).await;
    capture_turn_usage(&pool).await?;
    if let Err(failure) = capture_balance(&pool).await {
        tracing::debug!(code=%failure.code,"account balance snapshot deferred");
    }
    file_result?;
    query("UPDATE account_sync_control SET last_synced_at=?,last_sync_error=NULL WHERE id=1")
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&pool)
        .await?;
    // The webview re-reads its lists on this event, so it is sent when
    // something moved: a revision applied or sent, a file that progressed,
    // an error that cleared. An idle pass is silent.
    let transfers_after = super::files::pending_transfers(&pool).await.unwrap_or(0);
    if summary.changed() || had_error.is_some() || transfers_after != transfers_before {
        let _ = app.emit("subrosa://sync-updated", json!({"applied":summary.applied,"pushed":summary.pushed,"preserved":summary.preserved,"parked":summary.parked,"kinds":summary.kinds}));
    }
    Ok(())
}
/// What one pass did, for the status line and the event the webview hears.
#[derive(Default, Debug, Clone, Serialize)]
pub struct Summary {
    pub pushed: usize,
    pub applied: usize,
    pub preserved: usize,
    pub parked: usize,
    pub kinds: std::collections::BTreeSet<String>,
}
impl Summary {
    pub fn changed(&self) -> bool {
        self.pushed + self.applied + self.preserved + self.parked > 0
    }
    fn note(&mut self, kind: &str) {
        self.kinds.insert(kind.to_string());
    }
}
/// How many changes one page asks for. The service allows 500.
const PAGE_LIMIT: usize = 500;

pub(super) async fn synchronize(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<Summary, AppError> {
    let mut summary = Summary::default();
    // Receive before sending (ADR-0108). A deletion decided on stale
    // knowledge is then sealed against the head the service holds, not the
    // one this device remembered, and a tombstone waiting to leave absorbs
    // the edit that arrives instead of crossing it as a sibling.
    pull(pool, s, key, &mut summary).await?;
    push(pool, s, key, &mut summary).await?;
    replay_pending(pool, s, key, &mut summary).await?;
    summary.applied += settle_clean_deletions(pool, s, key).await?;
    auto_merge_note_conflicts(pool, s, key).await;
    auto_resolve_identical_conflicts(pool, s, key).await;
    settle_edits_older_than_a_local_deletion(pool, s, key).await;
    Ok(summary)
}

async fn pull(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    summary: &mut Summary,
) -> Result<(), AppError> {
    for _ in 0..10 {
        let cursor: i64 = query("SELECT cursor FROM account_sync_control WHERE id=1")
            .fetch_one(pool)
            .await?
            .get("cursor");
        // A library that has never received anything asks for the heads
        // (ADR-0109): what is, not everything that was.
        let fresh = cursor == 0
            && query("SELECT 1 FROM account_sync_inbox LIMIT 1")
                .fetch_optional(pool)
                .await?
                .is_none();
        let heads = if fresh { "&heads=1" } else { "" };
        let data = call(
            s,
            reqwest::Method::GET,
            &format!("/api/v1/sync?after={cursor}&limit={PAGE_LIMIT}{heads}"),
            None,
        )
        .await?;
        let page: Page = serde_json::from_value(data).map_err(|_| error("sync_format_invalid"))?;
        if page.cursor < cursor || page.changes.len() > PAGE_LIMIT {
            return Err(error("sync_format_invalid"));
        }
        let mut tx = pool.begin().await?;
        for change in &page.changes {
            if change.sequence <= cursor || change.sequence > page.cursor {
                return Err(error("sync_format_invalid"));
            }
            let existing = query("SELECT revision FROM account_sync_inbox WHERE revision=?")
                .bind(&change.revision)
                .fetch_optional(&mut *tx)
                .await?;
            if existing.is_some() {
                continue;
            }
            query("INSERT INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,sequence,resolved_revisions) VALUES(?,?,?,?,?,?,?,?,?)").bind(&change.revision).bind(&change.object_id).bind(&change.kind).bind(&change.ciphertext).bind(&change.parent_revision).bind(&change.operation_id).bind(change.deleted).bind(change.sequence).bind(json!(change.resolved_revisions).to_string()).execute(&mut *tx).await?;
            admit(&mut tx, s, key, change, summary).await?;
        }
        query("UPDATE account_sync_control SET cursor=? WHERE id=1")
            .bind(page.cursor)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        if !page.has_more {
            break;
        }
    }
    Ok(())
}

/// What became of a revision this device was handed.
#[derive(Debug, PartialEq, Eq)]
enum Admitted {
    /// Written into the library, and the head moved to it.
    Applied,
    /// Kept as a card for a person: it crossed work of this device's own.
    Preserved,
    /// Left in the inbox for a parent that has not arrived or applied yet.
    Waiting,
    /// Set aside as an issue: this build cannot read it. The stream goes on.
    Parked,
    /// Already this device's head, or history a deletion here had settled.
    Already,
}

/// Admits one inbound revision under a savepoint, so a revision this build
/// cannot read is parked and the page goes on, and nothing half-written
/// stays behind: without the savepoint, `applying=1` could outlive the
/// failure and silence every trigger in the library (ADR-0108).
async fn admit(
    conn: &mut SqliteConnection,
    s: &Session,
    key: &[u8; 32],
    c: &Change,
    summary: &mut Summary,
) -> Result<Admitted, AppError> {
    query("SAVEPOINT admit").execute(&mut *conn).await?;
    match admit_inner(conn, s, key, c).await {
        Ok(outcome) => {
            query("RELEASE admit").execute(&mut *conn).await?;
            match outcome {
                Admitted::Applied => {
                    summary.applied += 1;
                    summary.note(&c.kind);
                }
                Admitted::Preserved => {
                    summary.preserved += 1;
                    summary.note(&c.kind);
                }
                Admitted::Waiting | Admitted::Parked | Admitted::Already => {}
            }
            Ok(outcome)
        }
        Err(failure) if failure.code == "sync_format_invalid" => {
            query("ROLLBACK TO admit").execute(&mut *conn).await?;
            query("RELEASE admit").execute(&mut *conn).await?;
            record_issue_on(conn, "inbox", &c.revision, &failure.code).await?;
            summary.parked += 1;
            Ok(Admitted::Parked)
        }
        Err(failure) => Err(failure),
    }
}

async fn head_of(conn: &mut SqliteConnection, object_id: &str) -> Result<Option<String>, AppError> {
    Ok(query("SELECT revision FROM account_sync_heads WHERE object_id=?")
        .bind(object_id)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.get::<String, _>("revision")))
}

/// Whether something of `object_id` waits to leave this device. A row set
/// aside by an issue does not count: it is not going anywhere until a person
/// retries it, and a deletion that applies takes it along.
async fn pending_unparked(conn: &mut SqliteConnection, object_id: &str) -> Result<bool, AppError> {
    Ok(query("SELECT 1 FROM account_sync_outbox o WHERE o.object_id=? AND NOT EXISTS(SELECT 1 FROM account_sync_issues i WHERE i.lane='outbox' AND i.item_id=o.operation_id) LIMIT 1")
        .bind(object_id)
        .fetch_optional(&mut *conn)
        .await?
        .is_some())
}

/// A deletion of this device's own that has not been sealed yet: its parent
/// is decided at seal time, so what arrives meanwhile is simply what it will
/// retire.
async fn unsealed_tombstone(conn: &mut SqliteConnection, object_id: &str) -> Result<Option<i64>, AppError> {
    Ok(query("SELECT sequence FROM account_sync_outbox WHERE object_id=? AND deleted=1 AND ciphertext IS NULL ORDER BY sequence DESC LIMIT 1")
        .bind(object_id)
        .fetch_optional(&mut *conn)
        .await?
        .map(|r| r.get::<i64, _>("sequence")))
}

async fn resolve_cards_of(conn: &mut SqliteConnection, object_id: &str) -> Result<(), AppError> {
    query("UPDATE account_sync_conflicts SET resolved=1 WHERE object_id=? AND resolved=0")
        .bind(object_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Whether the row this revision describes belongs to a parent object this
/// device holds as deleted. Such a row is history the deletion settled: a
/// transcript of a note that is gone does not wait for the note to return.
async fn parent_object_deleted(conn: &mut SqliteConnection, body: &Value) -> Result<bool, AppError> {
    for (field, parent) in [("note_id", "notes"), ("task_id", "agent_tasks")] {
        let Some(id) = body["row"][field].as_str() else {
            continue;
        };
        if body["table"] == "assistant_references" {
            continue;
        }
        let present = query(&format!("SELECT 1 FROM {parent} WHERE id=?"))
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
        if present {
            continue;
        }
        let tombstoned = query("SELECT 1 FROM account_sync_heads h JOIN account_sync_inbox i ON i.revision=h.revision WHERE h.object_id=? AND i.deleted=1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
        if tombstoned {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn admit_inner(
    conn: &mut SqliteConnection,
    s: &Session,
    key: &[u8; 32],
    c: &Change,
) -> Result<Admitted, AppError> {
    // Authenticate even replayed/own revisions. Server substitution is
    // rejected before any cursor or local content changes.
    let body = verify(s, key, c)?;
    let head = head_of(conn, &c.object_id).await?;
    if head.as_deref() == Some(&c.revision) {
        mark_applied(conn, &c.revision).await?;
        return Ok(Admitted::Already);
    }
    // Behind its parent, whether that one waits for a dependency or was
    // parked: a child applied out of order would read as a disagreement.
    if let Some(parent) = &c.parent_revision {
        let waiting = query("SELECT 1 FROM account_sync_inbox WHERE revision=? AND applied=0")
            .bind(parent)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
        if waiting {
            return Ok(Admitted::Waiting);
        }
    }
    if let Some(sequence) = unsealed_tombstone(conn, &c.object_id).await? {
        if c.deleted {
            // Deleted there too: one tombstone is enough.
            query("DELETE FROM account_sync_outbox WHERE sequence=?")
                .bind(sequence)
                .execute(&mut *conn)
                .await?;
        } else {
            // Absorbed: the deletion this device is about to send retires
            // this revision too. Nothing is written, the row is gone here.
            query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind").bind(&c.object_id).bind(&c.revision).bind(&c.kind).execute(&mut *conn).await?;
            resolve_cards_of(conn, &c.object_id).await?;
            mark_applied(conn, &c.revision).await?;
            return Ok(Admitted::Applied);
        }
    }
    if pending_unparked(conn, &c.object_id).await? {
        preserve(conn, c).await?;
        mark_applied(conn, &c.revision).await?;
        return Ok(Admitted::Preserved);
    }
    let head = head_of(conn, &c.object_id).await?;
    if !c.deleted
        && head.is_some()
        && head != c.parent_revision
        && !head
            .as_ref()
            .is_some_and(|h| c.resolved_revisions.contains(h))
    {
        preserve(conn, c).await?;
        mark_applied(conn, &c.revision).await?;
        return Ok(Admitted::Preserved);
    }
    if !c.deleted && parent_object_deleted(conn, &body).await? {
        mark_applied(conn, &c.revision).await?;
        return Ok(Admitted::Already);
    }
    // Dependencies can arrive in a later page. A durable inbox retains them
    // and `replay_pending` retries once their parent note/task is present.
    if !apply(conn, c, &body).await? {
        return Ok(Admitted::Waiting);
    }
    head_and_applied(conn, c).await?;
    let preserved = c.deleted
        && query("SELECT 1 FROM account_sync_conflicts WHERE id=? AND resolved=0")
            .bind(&c.revision)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
    Ok(if preserved {
        Admitted::Preserved
    } else {
        Admitted::Applied
    })
}

/// A live sibling older than this device's own deletion of the object: the
/// other device had not seen the deletion, this device has nothing of the
/// object left to keep, and the service will settle it with a tombstone that
/// names the sibling. It happens when a tombstone was sealed before a push
/// that failed, so it left with a parent older than what had arrived.
async fn settle_edits_older_than_a_local_deletion(pool: &SqlitePool, s: &Session, key: &[u8; 32]) {
    let rows = match query("SELECT c.id FROM account_sync_conflicts c JOIN account_sync_heads h ON h.object_id=c.object_id JOIN account_sync_inbox i ON i.revision=h.revision WHERE c.resolved=0 AND c.deleted=0 AND i.deleted=1 AND c.id<h.revision AND NOT EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.object_id=c.object_id) ORDER BY c.created_at LIMIT 50")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(failure) => {
            tracing::warn!(%failure,"stale sibling scan deferred");
            return;
        }
    };
    for row in rows {
        let id: String = row.get("id");
        if let Err(failure) = resolve_in_store(pool, s, key, &id, "keep_local").await {
            if failure.code != "sync_pending_changes" {
                tracing::warn!(code=%failure.code,"stale sibling deferred");
            }
        }
    }
}

/// A sibling that says exactly what this device already holds is not a
/// disagreement, and asking a person to review it is noise. It happens
/// whenever two devices send the same content from the same parent: a memory
/// re-sent after a local-only write, a setting touched twice. Keeping the
/// local copy acknowledges the sibling, so the other devices converge too.
/// Deletions and real differences stay for review.
async fn auto_resolve_identical_conflicts(pool: &SqlitePool, s: &Session, key: &[u8; 32]) {
    let rows = match query("SELECT * FROM account_sync_conflicts WHERE resolved=0 AND deleted=0 ORDER BY created_at LIMIT 200")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(failure) => {
            tracing::warn!(%failure,"identical conflict scan deferred");
            return;
        }
    };
    for row in rows {
        let id: String = row.get("id");
        match conflict_matches_local(pool, s, key, &row).await {
            Ok(true) => {
                if let Err(failure) = resolve_in_store(pool, s, key, &id, "keep_local").await {
                    if failure.code != "sync_pending_changes"
                        && failure.code != "sync_dependencies_pending"
                    {
                        tracing::warn!(code=%failure.code,"identical conflict deferred");
                    }
                }
            }
            Ok(false) => {}
            Err(failure) => tracing::warn!(code=%failure.code,"identical conflict check deferred"),
        }
    }
}

async fn conflict_matches_local(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    row: &sqlx_sqlite::SqliteRow,
) -> Result<bool, AppError> {
    let c = conflict_change(row)?;
    let remote = verify(s, key, &c)?;
    let name = remote["table"]
        .as_str()
        .ok_or_else(|| error("sync_format_invalid"))?;
    if name == "carpe_diem_settings" {
        return Ok(false);
    }
    let t = table(name)?;
    let local = query(&format!(
        "SELECT {} AS body FROM {} WHERE id=?",
        snapshot_body(t, &format!("{}.", t.name)),
        t.name
    ))
    .bind(&c.object_id)
    .fetch_optional(pool)
    .await?;
    let Some(local) = local else {
        return Ok(false);
    };
    let local: Value = serde_json::from_str(&local.get::<String, _>("body"))
        .map_err(|_| error("sync_local_object_invalid"))?;
    if t.name == "saved_items" {
        return Ok(super::saved_items::same_item(&local, &remote));
    }
    Ok(same_content(&local, &remote))
}

/// The envelope fields describe a revision, not what it says.
fn same_content(local: &Value, remote: &Value) -> bool {
    let content = |body: &Value| {
        let mut body = body.clone();
        if let Some(fields) = body.as_object_mut() {
            for envelope in [
                "v",
                "operation_id",
                "parent_revision",
                "deleted",
                "resolved_revisions",
            ] {
                fields.remove(envelope);
            }
        }
        body
    };
    content(local) == content(remote)
}

async fn auto_merge_note_conflicts(pool: &SqlitePool, s: &Session, key: &[u8; 32]) {
    let rows = match query("SELECT id FROM account_sync_conflicts WHERE kind='note' AND resolved=0 ORDER BY created_at LIMIT 20")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(failure) => {
            tracing::warn!(%failure,"note merge scan deferred");
            return;
        }
    };
    for row in rows {
        let id: String = row.get("id");
        if let Err(failure) = resolve_in_store(pool, s, key, &id, "merge").await {
            if failure.code != "sync_conflict_requires_review"
                && failure.code != "sync_pending_changes"
                && failure.code != "sync_dependencies_pending"
            {
                tracing::warn!(code=%failure.code,"note merge deferred");
            }
        }
    }
}

fn merge_note_body(base: &Value, local: &Value, remote: &Value) -> Option<Value> {
    if [base, local, remote]
        .iter()
        .any(|body| body["table"] != "notes")
    {
        return None;
    }
    let (base_row, local_row, remote_row) = (
        base["row"].as_object()?,
        local["row"].as_object()?,
        remote["row"].as_object()?,
    );
    if base_row.len() != local_row.len() || base_row.len() != remote_row.len() {
        return None;
    }
    let mut merged = remote.clone();
    let result = merged["row"].as_object_mut()?;
    for (field, ancestor) in base_row {
        let ours = local_row.get(field)?;
        let theirs = remote_row.get(field)?;
        let value = if ours == theirs {
            ours.clone()
        } else if ours == ancestor {
            theirs.clone()
        } else if theirs == ancestor {
            ours.clone()
        } else if field == "updated_at" {
            json!(chrono::Utc::now().to_rfc3339())
        } else if field == "edited_content" {
            json!(diffy::merge(ancestor.as_str()?, ours.as_str()?, theirs.as_str()?).ok()?)
        } else {
            return None;
        };
        result.insert(field.clone(), value);
    }
    if result.len() != base_row.len() {
        return None;
    }
    let (base_summary, local_summary, remote_summary) =
        (&base["summary"], &local["summary"], &remote["summary"]);
    merged["summary"] = if local_summary == remote_summary {
        local_summary.clone()
    } else if local_summary == base_summary {
        remote_summary.clone()
    } else if remote_summary == base_summary {
        local_summary.clone()
    } else {
        return None;
    };
    Some(merged)
}
/// Operations one push carries at most, and the ciphertext it may total.
/// The service allows 100 and four MiB; staying under both leaves room for
/// the envelope and keeps a refused batch cheap to isolate.
const BATCH_OPERATIONS: usize = 50;
const BATCH_BYTES: usize = 4 * 1024 * 1024 - 64 * 1024;
const OPERATION_BYTES: usize = 1024 * 1024;

/// A row sealed and ready to leave: its ciphertext is frozen under its
/// operation id, so a retry sends the same bytes.
struct Sealed {
    sequence: i64,
    operation_id: String,
    object_id: String,
    kind: String,
    deleted: bool,
    ciphertext: String,
    parent: Option<String>,
    resolved: Vec<String>,
}

async fn next_outbox(
    pool: &SqlitePool,
    object_filter: Option<&str>,
) -> Result<Option<sqlx_sqlite::SqliteRow>, AppError> {
    Ok(next_outbox_batch(pool, object_filter, 1).await?.pop())
}

/// The earliest row of each object with nothing earlier of its own, oldest
/// first, rows set aside by an issue excluded.
async fn next_outbox_batch(
    pool: &SqlitePool,
    object_filter: Option<&str>,
    limit: usize,
) -> Result<Vec<sqlx_sqlite::SqliteRow>, AppError> {
    Ok(query("SELECT o.* FROM account_sync_outbox o WHERE (?1 IS NULL OR o.object_id=?1) AND NOT EXISTS(SELECT 1 FROM account_sync_outbox earlier WHERE earlier.object_id=o.object_id AND earlier.sequence<o.sequence) AND NOT EXISTS(SELECT 1 FROM account_sync_issues issue WHERE issue.lane='outbox' AND issue.item_id=o.operation_id) ORDER BY o.sequence LIMIT ?2")
        .bind(object_filter)
        .bind(limit as i64)
        .fetch_all(pool)
        .await?)
}

/// Seals one outbox row inside the caller's transaction. `None` means the
/// row was rewritten by a newer edit between the read and the seal (the
/// triggers keep one unsent snapshot per object): sealing the stale body
/// would send it and drop the edit, so nothing is sealed and the row is read
/// again next time.
async fn seal(
    tx: &mut SqliteConnection,
    s: &Session,
    key: &[u8; 32],
    row: &sqlx_sqlite::SqliteRow,
) -> Result<Option<Sealed>, AppError> {
    let sequence: i64 = row.get("sequence");
    let resolved_revisions: Vec<String> =
        serde_json::from_str(&row.get::<String, _>("resolved_revisions"))
            .map_err(|_| error("sync_local_object_invalid"))?;
    let operation_id: String = row.get("operation_id");
    let id: String = row.get("object_id");
    let kind: String = row.get("kind");
    let deleted: bool = row.get("deleted");
    let existing: Option<String> = row.get("ciphertext");
    let (ciphertext, parent, resolved) = if let Some(ciphertext) = existing {
        (
            ciphertext,
            row.get::<Option<String>, _>("parent_revision"),
            resolved_revisions,
        )
    } else {
        let parent = head_of(tx, &id).await?;
        // A tombstone retires every sibling this device knows of (ADR-0108):
        // the person deleted the object, which answers each card about it.
        let resolved = if deleted && resolved_revisions.is_empty() {
            let siblings: Vec<String> = query("SELECT id FROM account_sync_conflicts WHERE object_id=? AND resolved=0 AND id<>? ORDER BY created_at LIMIT 64")
                .bind(&id)
                .bind(parent.as_deref().unwrap_or_default())
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(|r| r.get::<String, _>("id"))
                .collect();
            if !siblings.is_empty() {
                resolve_cards_of(tx, &id).await?;
            }
            siblings
        } else {
            resolved_revisions
        };
        let mut body: Value = serde_json::from_str(&row.get::<String, _>("body"))
            .map_err(|_| error("sync_local_object_invalid"))?;
        body["v"] = json!(1);
        body["operation_id"] = json!(operation_id);
        body["parent_revision"] = json!(parent);
        body["deleted"] = json!(deleted);
        body["resolved_revisions"] = json!(resolved);
        let clear = Zeroizing::new(
            serde_json::to_vec(&body).map_err(|_| error("sync_local_object_invalid"))?,
        );
        let ciphertext = crypto::seal(key, &aad(s, &kind, &id), &clear)?;
        let sealed = query("UPDATE account_sync_outbox SET ciphertext=?,parent_revision=?,resolved_revisions=? WHERE sequence=? AND ciphertext IS NULL AND body=?")
            .bind(&ciphertext)
            .bind(&parent)
            .bind(json!(resolved).to_string())
            .bind(sequence)
            .bind(row.get::<String, _>("body"))
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if sealed == 0 {
            return Ok(None);
        }
        (ciphertext, parent, resolved)
    };
    if ciphertext.len() > OPERATION_BYTES {
        return Err(error("sync_object_too_large"));
    }
    Ok(Some(Sealed {
        sequence,
        operation_id,
        object_id: id,
        kind,
        deleted,
        ciphertext,
        parent,
        resolved,
    }))
}

/// Sends sealed rows as one push and records what the service answered:
/// each revision becomes this device's head and an inbox row already
/// applied, so its echo is skipped on the next pull, and the outbox row
/// goes. Even a sibling becomes this device's own head: the other branch is
/// retained as a card on pull, never silently applied over the local edit.
async fn post_batch(pool: &SqlitePool, s: &Session, sealed: &[Sealed]) -> Result<usize, AppError> {
    let operations: Vec<Value> = sealed
        .iter()
        .map(|item| json!({"operation_id":item.operation_id,"object_id":item.object_id,"parent_revision":item.parent,"kind":item.kind,"ciphertext":item.ciphertext,"deleted":item.deleted,"resolved_revisions":item.resolved}))
        .collect();
    let data = call(
        s,
        reqwest::Method::POST,
        "/api/v1/sync",
        Some(json!({"operations":operations})),
    )
    .await?;
    let result: PushResults =
        serde_json::from_value(data).map_err(|_| error("sync_format_invalid"))?;
    if result.results.len() != sealed.len() {
        return Err(error("sync_format_invalid"));
    }
    let mut tx = pool.begin().await?;
    for (item, answer) in sealed.iter().zip(&result.results) {
        if answer.operation_id != item.operation_id {
            return Err(error("sync_format_invalid"));
        }
        query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind").bind(&item.object_id).bind(&answer.revision).bind(&item.kind).execute(&mut *tx).await?;
        query("INSERT OR IGNORE INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,sequence,applied,resolved_revisions) VALUES(?,?,?,?,?,?,?,?,1,?)")
            .bind(&answer.revision).bind(&item.object_id).bind(&item.kind).bind(&item.ciphertext)
            .bind(&item.parent).bind(&item.operation_id).bind(item.deleted).bind(answer.sequence).bind(json!(item.resolved).to_string())
            .execute(&mut *tx).await?;
        query("DELETE FROM account_sync_outbox WHERE sequence=?")
            .bind(item.sequence)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(sealed.len())
}

/// Sends what waits, a batch at a time (ADR-0109). A batch the service
/// refuses as a whole is sent row by row, so the one row it objects to is
/// set aside and the others leave.
async fn push(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    summary: &mut Summary,
) -> Result<(), AppError> {
    for _ in 0..20 {
        let rows = next_outbox_batch(pool, None, BATCH_OPERATIONS).await?;
        if rows.is_empty() {
            break;
        }
        let mut sealed = Vec::new();
        let mut bytes = 0usize;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        for row in &rows {
            let operation: String = row.get("operation_id");
            match seal(&mut tx, s, key, row).await {
                Ok(Some(item)) => {
                    if bytes + item.ciphertext.len() > BATCH_BYTES && !sealed.is_empty() {
                        break;
                    }
                    bytes += item.ciphertext.len();
                    sealed.push(item);
                }
                Ok(None) => {}
                Err(failure) if isolatable_outbox_error(&failure.code) => {
                    record_issue_on(&mut tx, "outbox", &operation, &failure.code).await?;
                }
                Err(failure) => return Err(failure),
            }
        }
        tx.commit().await?;
        if sealed.is_empty() {
            continue;
        }
        let kinds: Vec<String> = sealed.iter().map(|item| item.kind.clone()).collect();
        match post_batch(pool, s, &sealed).await {
            Ok(sent) => {
                summary.pushed += sent;
                for kind in kinds {
                    summary.note(&kind);
                }
            }
            Err(failure)
                if sealed.len() > 1
                    && matches!(
                        failure.code.as_str(),
                        "account_conflict" | "account_invalid_request"
                    ) =>
            {
                for item in sealed {
                    let kind = item.kind.clone();
                    match post_batch(pool, s, std::slice::from_ref(&item)).await {
                        Ok(_) => {
                            summary.pushed += 1;
                            summary.note(&kind);
                        }
                        Err(failure) if failure.code == "account_conflict" => {
                            record_issue(pool, "outbox", &item.operation_id, "sync_parent_unknown")
                                .await?;
                        }
                        Err(failure) => return Err(failure),
                    }
                }
            }
            Err(failure) if failure.code == "account_conflict" => {
                record_issue(pool, "outbox", &sealed[0].operation_id, "sync_parent_unknown").await?;
            }
            Err(failure) => return Err(failure),
        }
    }
    Ok(())
}

/// One row, the way `share_credential` sends its one object. Returns whether
/// something was sent or re-read; `Ok(false)` when nothing waits.
async fn push_one(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    object_filter: Option<&str>,
) -> Result<bool, AppError> {
    let Some(row) = next_outbox(pool, object_filter).await? else {
        return Ok(false);
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let sealed = match seal(&mut tx, s, key, &row).await {
        Ok(sealed) => sealed,
        // Sealed and too large: the ciphertext stays, so a retry does not
        // encrypt it again, and the caller hears why nothing left.
        Err(failure) if isolatable_outbox_error(&failure.code) => {
            tx.commit().await?;
            return Err(failure);
        }
        Err(failure) => return Err(failure),
    };
    tx.commit().await?;
    let Some(item) = sealed else {
        return Ok(true);
    };
    post_batch(pool, s, std::slice::from_ref(&item)).await?;
    Ok(true)
}

/// Whether anything waits to leave this device, so a tick can wake the
/// driver without a network request: unsent rows the issues did not park.
pub(super) async fn has_local_work(pool: &SqlitePool) -> Result<bool, AppError> {
    Ok(!next_outbox_batch(pool, None, 1).await?.is_empty()
        || super::files::has_work(pool).await?)
}
fn verify(s: &Session, key: &[u8; 32], c: &Change) -> Result<Value, AppError> {
    uuid::Uuid::parse_str(&c.object_id).map_err(|_| error("sync_format_invalid"))?;
    uuid::Uuid::parse_str(&c.revision).map_err(|_| error("sync_format_invalid"))?;
    let clear = crypto::open(key, &aad(s, &c.kind, &c.object_id), &c.ciphertext)?;
    let body: Value = serde_json::from_slice(&clear).map_err(|_| error("sync_format_invalid"))?;
    if body["v"] != 1
        || body["deleted"] != c.deleted
        || body["parent_revision"] != json!(c.parent_revision)
        || c.operation_id
            .as_ref()
            .map_or(true, |id| body["operation_id"] != *id)
    {
        return Err(error("sync_authentication_failed"));
    }
    let resolved: Vec<String> = serde_json::from_value(
        body.get("resolved_revisions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|_| error("sync_authentication_failed"))?;
    if resolved != c.resolved_revisions || resolved.len() > 64 {
        return Err(error("sync_authentication_failed"));
    }
    let name = body["table"]
        .as_str()
        .ok_or_else(|| error("sync_format_invalid"))?;
    if name == "carpe_diem_settings" {
        if c.kind != "settings" || c.object_id != CREDENTIAL_ID {
            return Err(error("sync_format_invalid"));
        }
    } else {
        if table(name)?.kind != c.kind {
            return Err(error("sync_format_invalid"));
        }
    }
    let row_id = body["row"]["id"]
        .as_str()
        .ok_or_else(|| error("sync_format_invalid"))?;
    if object_of(name, row_id) != c.object_id {
        return Err(error("sync_format_invalid"));
    }
    Ok(body)
}
async fn preserve(conn: &mut SqliteConnection, c: &Change) -> Result<(), AppError> {
    // Only live sibling heads need review. Their authenticated child keeps
    // the previous ciphertext archived while retiring its old conflict card.
    for ancestor in c.parent_revision.iter().chain(c.resolved_revisions.iter()) {
        query("UPDATE account_sync_conflicts SET resolved=1 WHERE id=? AND object_id=?")
            .bind(ancestor)
            .bind(&c.object_id)
            .execute(&mut *conn)
            .await?;
    }
    query("INSERT OR IGNORE INTO account_sync_conflicts(id,object_id,kind,ciphertext,parent_revision,operation_id,deleted,created_at,resolved_revisions) VALUES(?,?,?,?,?,?,?,?,?)").bind(&c.revision).bind(&c.object_id).bind(&c.kind).bind(&c.ciphertext).bind(&c.parent_revision).bind(&c.operation_id).bind(c.deleted).bind(chrono::Utc::now().to_rfc3339()).bind(json!(c.resolved_revisions).to_string()).execute(conn).await?;
    Ok(())
}
/// The tables a deletion of `table` takes with it, by the column that names
/// the parent.
fn children_of(table: &str) -> &'static [(&'static str, &'static str)] {
    match table {
        "notes" => &[
            ("recording_sessions", "note_id"),
            ("audio_artifacts", "note_id"),
            ("transcripts", "note_id"),
        ],
        "agent_tasks" => &[("agent_messages", "task_id")],
        _ => &[],
    }
}
/// Whether a remote deletion applies here (ADR-0108). It does when nothing
/// of the object waits to leave (the caller checked), the deletion is at
/// least as recent as what this device holds, and no child carries work the
/// deleting device never saw.
///
/// "At least as recent": its parent is the local head, or it acknowledged
/// the head, or it was minted after the head. Revisions are time-ordered
/// identifiers the service mints, so the last test is one comparison and
/// needs no clock of this device's own. A deletion older than the head means
/// someone edited after it was decided; that stays a question for a person.
///
/// Children are looked up by their foreign key: a child with an unsent
/// local change, or a head revision later than the tombstone, is a
/// disagreement. Objects without children are always clean on that count.
async fn deletion_applies(
    conn: &mut SqliteConnection,
    table: &str,
    c: &Change,
    head: Option<&str>,
) -> Result<bool, AppError> {
    let settled = match head {
        None => true,
        Some(h) => {
            h == c.revision
                || c.parent_revision.as_deref() == Some(h)
                || c.resolved_revisions.iter().any(|r| r == h)
                || h < c.revision.as_str()
        }
    };
    if !settled {
        return Ok(false);
    }
    for (child, column) in children_of(table) {
        let newer = query(&format!("SELECT 1 FROM {child} ch WHERE ch.{column}=? AND (EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.object_id=ch.id AND NOT EXISTS(SELECT 1 FROM account_sync_issues i WHERE i.lane='outbox' AND i.item_id=o.operation_id)) OR EXISTS(SELECT 1 FROM account_sync_heads h WHERE h.object_id=ch.id AND h.revision>?)) LIMIT 1"))
            .bind(&c.object_id)
            .bind(&c.revision)
            .fetch_optional(&mut *conn)
            .await?;
        if newer.is_some() {
            return Ok(false);
        }
    }
    Ok(true)
}
/// Applies a deletion that `deletion_applies` admitted: the rows go the way
/// this device's own delete takes them, the rows of the object parked by an
/// issue go too (retried later, they would come back as children of the
/// tombstone and bring the object back everywhere), and the inbox rows of
/// its children that were waiting for it are history now.
async fn apply_deletion(conn: &mut SqliteConnection, table: &str, object_id: &str) -> Result<(), AppError> {
    let mut children = Vec::new();
    for (child, column) in children_of(table) {
        let rows = query(&format!("SELECT id FROM {child} WHERE {column}=?"))
            .bind(object_id)
            .fetch_all(&mut *conn)
            .await?;
        children.extend(rows.into_iter().map(|r| r.get::<String, _>("id")));
    }
    delete_locally(conn, table, object_id).await?;
    query("DELETE FROM account_sync_outbox WHERE object_id=? AND operation_id IN (SELECT item_id FROM account_sync_issues WHERE lane='outbox')")
        .bind(object_id)
        .execute(&mut *conn)
        .await?;
    query("DELETE FROM account_sync_issues WHERE lane='outbox' AND NOT EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.operation_id=item_id)")
        .execute(&mut *conn)
        .await?;
    for child in children {
        query("UPDATE account_sync_inbox SET applied=1 WHERE object_id=? AND applied=0")
            .bind(child)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}
/// Removes an object another device deleted, the way this device's own delete
/// would. Callers hold `applying=1`, so no outbox row echoes the deletion. A
/// database connection knows nothing of the app's directories, so files the
/// rows pointed at are queued for the file lane rather than removed here.
pub(super) async fn delete_locally(
    conn: &mut SqliteConnection,
    table: &str,
    id: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    match table {
        "notes" => {
            let paths = query("SELECT path FROM audio_artifacts WHERE note_id=? AND path<>''")
                .bind(id)
                .fetch_all(&mut *conn)
                .await?;
            for row in paths {
                queue_removed_file(conn, "recording", row.get("path"), &now).await?;
            }
            crate::db::repositories::delete_note_records(conn, id).await?;
            crate::spotlight::forget(std::slice::from_ref(&id.to_string()));
        }
        "agent_tasks" => {
            // The desktop keeps the chat in its own runtime too: the file
            // lane, which has the app, asks it to forget the session.
            let session: Option<String> =
                query("SELECT hermes_session_id FROM agent_tasks WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await?
                    .and_then(|row| row.get("hermes_session_id"));
            if let Some(session) = session.filter(|s| !s.is_empty()) {
                queue_removed_file(conn, "hermes-session", session, &now).await?;
            }
            for sql in [
                "DELETE FROM agent_tool_events WHERE task_id=?",
                "DELETE FROM agent_messages WHERE task_id=?",
                "DELETE FROM session_folders WHERE session_id=?",
                "DELETE FROM assistant_conversations WHERE task_id=?",
                "DELETE FROM agent_tasks WHERE id=?",
            ] {
                query(sql).bind(id).execute(&mut *conn).await?;
            }
        }
        "audio_artifacts" => {
            let path: Option<String> = query("SELECT path FROM audio_artifacts WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?
                .map(|row| row.get("path"));
            if let Some(path) = path.filter(|p| !p.is_empty()) {
                queue_removed_file(conn, "recording", path, &now).await?;
            }
            query("DELETE FROM audio_artifacts WHERE id=?")
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
        "account_studio_files" | "assistant_references" | "project_files" => {
            let lane = if table == "account_studio_files" {
                "studio"
            } else {
                "assistant"
            };
            let name: Option<String> = query(&format!("SELECT file_name FROM {table} WHERE id=?"))
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?
                .map(|row| row.get("file_name"));
            if let Some(name) = name.filter(|n| !n.is_empty()) {
                if lane == "studio" {
                    // What this device filed about the file goes with it: its
                    // mark (or a later folder change would revive it as a
                    // child of the tombstone), its provenance, and a download
                    // of it still under way, which would otherwise finish and
                    // put the file back after the deletion.
                    query("DELETE FROM studio_marks WHERE file_id=?")
                        .bind(id)
                        .execute(&mut *conn)
                        .await?;
                    query("DELETE FROM studio_artifact_metadata WHERE id=?")
                        .bind(&name)
                        .execute(&mut *conn)
                        .await?;
                    let manifests: Vec<String> =
                        query("SELECT id FROM account_file_manifests WHERE artifact_id=?")
                            .bind(id)
                            .fetch_all(&mut *conn)
                            .await?
                            .into_iter()
                            .map(|row| row.get("id"))
                            .collect();
                    for manifest in manifests {
                        query("DELETE FROM account_file_downloads WHERE manifest_id=?")
                            .bind(&manifest)
                            .execute(&mut *conn)
                            .await?;
                        queue_removed_file(conn, "staging", format!("{manifest}.part"), &now)
                            .await?;
                    }
                }
                queue_removed_file(conn, lane, name, &now).await?;
            }
            query(&format!("DELETE FROM {table} WHERE id=?"))
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
        "account_session_folders" => super::session_folders::delete_locally(conn, id).await?,
        // A connector is deleted by its object, and what this device kept
        // about it goes with it, as its own removal would take it. Its
        // keychain entries are this device's, and a sign-in reuses them.
        "connectors" => {
            for sql in [
                "DELETE FROM connector_state WHERE connector_id IN (SELECT id FROM connectors WHERE object_id=?)",
                "DELETE FROM connector_triggers WHERE connector_id IN (SELECT id FROM connectors WHERE object_id=?)",
                "DELETE FROM connectors WHERE object_id=?",
            ] {
                query(sql).bind(id).execute(&mut *conn).await?;
            }
        }
        "account_note_folders" => {
            query("DELETE FROM note_folders WHERE (note_id,folder_id) IN (SELECT note_id,folder_id FROM account_note_folders WHERE id=?)")
                .bind(id)
                .execute(&mut *conn)
                .await?;
            query("DELETE FROM account_note_folders WHERE id=?")
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
        _ => {
            let t = self::table(table)?;
            query(&format!("DELETE FROM {} WHERE id=?", t.name))
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}
async fn queue_removed_file(
    conn: &mut SqliteConnection,
    lane: &str,
    path: String,
    now: &str,
) -> Result<(), AppError> {
    query("INSERT INTO account_sync_removed_files(lane,path,created_at) VALUES(?,?,?)")
        .bind(lane)
        .bind(path)
        .bind(now)
        .execute(conn)
        .await?;
    Ok(())
}
/// Cards written for deletions that apply themselves today (ADR-0108): the
/// tombstone is at least as recent as the local head, nothing of the object
/// waits to leave, no child was revised since. Each is applied the way the
/// deletion would have been on arrival, the head moves to the tombstone,
/// and nothing is sent: the service holds that deletion already. A divergent
/// card (unsent work here, or an edit newer than the deletion) is left for
/// the person. Returns how many were settled.
pub(super) async fn settle_clean_deletions(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<usize, AppError> {
    let rows = query("SELECT c.* FROM account_sync_conflicts c WHERE c.resolved=0 AND c.deleted=1 AND NOT EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.object_id=c.object_id AND NOT EXISTS(SELECT 1 FROM account_sync_issues i WHERE i.lane='outbox' AND i.item_id=o.operation_id)) ORDER BY c.created_at LIMIT 200")
        .fetch_all(pool)
        .await?;
    let mut settled = 0;
    for row in rows {
        let c = conflict_change(&row)?;
        let Ok(body) = verify(s, key, &c) else {
            continue;
        };
        let Some(name) = body["table"].as_str() else {
            continue;
        };
        if name == "carpe_diem_settings" {
            continue;
        }
        let table = table(name)?.name;
        let mut tx = pool.begin().await?;
        let head = head_of(&mut tx, &c.object_id).await?;
        if !deletion_applies(&mut tx, table, &c, head.as_deref()).await? {
            continue;
        }
        query("UPDATE account_sync_control SET applying=1 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        apply_deletion(&mut tx, table, &c.object_id).await?;
        query("UPDATE account_sync_control SET applying=0 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind").bind(&c.object_id).bind(&c.revision).bind(&c.kind).execute(&mut *tx).await?;
        query("UPDATE account_sync_conflicts SET resolved=1 WHERE id=?")
            .bind(&c.revision)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        settled += 1;
    }
    Ok(settled)
}
async fn mark_applied(conn: &mut SqliteConnection, revision: &str) -> Result<(), AppError> {
    query("UPDATE account_sync_inbox SET applied=1 WHERE revision=?")
        .bind(revision)
        .execute(conn)
        .await?;
    Ok(())
}
async fn head_and_applied(conn: &mut SqliteConnection, c: &Change) -> Result<(), AppError> {
    for id in c.resolved_revisions.iter().chain(c.parent_revision.iter()) {
        query("UPDATE account_sync_conflicts SET resolved=1 WHERE id=? AND object_id=?")
            .bind(id)
            .bind(&c.object_id)
            .execute(&mut *conn)
            .await?;
    }
    query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind").bind(&c.object_id).bind(&c.revision).bind(&c.kind).execute(&mut *conn).await?;
    mark_applied(conn, &c.revision).await
}
async fn apply(conn: &mut SqliteConnection, c: &Change, body: &Value) -> Result<bool, AppError> {
    if body["table"] == "assistant_conversations"
        && !c.deleted
        && body.get("assistant_snapshot").map_or(true, Value::is_null)
    {
        return Err(error("sync_format_invalid"));
    }
    if body["table"] == "carpe_diem_settings" {
        query("INSERT INTO account_sync_settings(id,ciphertext,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,revision=excluded.revision").bind(&c.object_id).bind(&c.ciphertext).bind(&c.revision).execute(conn).await?;
        return Ok(true);
    }
    let t = table(
        body["table"]
            .as_str()
            .ok_or_else(|| error("sync_format_invalid"))?,
    )?;
    let mut row = body["row"]
        .as_object()
        .cloned()
        .ok_or_else(|| error("sync_format_invalid"))?;
    if row.keys().any(|k| !t.columns.contains(&k.as_str())) {
        return Err(error("sync_format_invalid"));
    }
    if c.deleted {
        // A deletion has no dependencies to wait for and nothing to coerce.
        // Clean, it is applied like this device's own delete (ADR-0072);
        // over work the deleting device never saw, it is kept for review.
        let head = head_of(conn, &c.object_id).await?;
        query("UPDATE account_sync_control SET applying=1 WHERE id=1")
            .execute(&mut *conn)
            .await?;
        if deletion_applies(conn, t.name, c, head.as_deref()).await? {
            apply_deletion(conn, t.name, &c.object_id).await?;
        } else {
            preserve(conn, c).await?;
        }
        query("UPDATE account_sync_control SET applying=0 WHERE id=1")
            .execute(conn)
            .await?;
        return Ok(true);
    }
    if t.name == "notes"
        && body.get("summary").is_some()
        && query("SELECT 1 FROM note_summaries WHERE note_id=? AND status IN ('pending','running')")
            .bind(&c.object_id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some()
    {
        return Ok(false);
    }
    // A received execution state is history, never authorization to run work.
    if t.name == "agent_tasks" {
        row.insert("status".into(), json!("completed"));
        if body.get("assistant_snapshot").is_some_and(|v| !v.is_null()) {
            row.insert("safety_profile".into(), json!("custom_assistant"));
        }
    }
    if t.name == "notes"
        && !matches!(
            row.get("processing_status").and_then(Value::as_str),
            Some("draft" | "ready")
        )
    {
        row.insert("processing_status".into(), json!("ready"));
    }
    if t.name == "ingests" {
        row.insert("status".into(), json!("done"));
    }
    // The object a connector arrived under is the one it leaves under again.
    if t.name == "connectors" {
        row.insert("object_id".into(), json!(c.object_id));
    }
    // A memory without a scope is the person's own (see `row_json`).
    if t.name == "memories" && !row.contains_key("scope") {
        row.insert("scope".into(), Value::Null);
    }
    // `account_errands` is deliberately absent from these coercions, and it is
    // the only table that is. Every other incoming row describes work another
    // device already did, so arriving in a running state would make this
    // machine redo it — hence the flattening above. An errand is the opposite:
    // it is a person asking this device to do something, so flattening it to a
    // terminal state would be flattening the feature (ADR-0054). What keeps
    // that safe lives in `crate::errands`: the row names one device, the
    // machine must have errands switched on, a local unsynchronised ledger
    // makes it single use, and it perishes after a week.
    if t.name == "recording_sessions" {
        row.insert("status".into(), json!("completed"));
    }
    let artifact_table = if t.name == "account_file_manifests"
        && row.get("source_kind").and_then(Value::as_str) == Some("assistant")
    {
        "assistant_references"
    } else if t.name == "account_file_manifests"
        && row.get("source_kind").and_then(Value::as_str) == Some("studio")
    {
        "account_studio_files"
    } else {
        "audio_artifacts"
    };
    for (field, parent) in [
        ("assistant_id", "assistants"),
        ("note_id", "notes"),
        ("task_id", "agent_tasks"),
        ("folder_id", "folders"),
        ("artifact_id", artifact_table),
        ("recording_session_id", "recording_sessions"),
        ("audio_artifact_id", "audio_artifacts"),
    ] {
        // A reference is an immutable note snapshot, not a dependency on the
        // continuing existence of the original note.
        if t.name == "assistant_references" && field == "note_id" {
            continue;
        }
        if let Some(id) = row.get(field).and_then(Value::as_str) {
            let mut found = query(&format!("SELECT 1 FROM {parent} WHERE id=?"))
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?
                .is_some();
            if !found && field == "artifact_id" && artifact_table == "assistant_references" {
                found=query("SELECT 1 FROM assistant_conversations c,json_each(c.snapshot_json,'$.references') j WHERE json_extract(j.value,'$.id')=? UNION SELECT 1 FROM project_files WHERE id=? LIMIT 1").bind(id).bind(id).fetch_optional(&mut *conn).await?.is_some();
            }
            if !found {
                return Ok(false);
            }
        }
    }
    query("UPDATE account_sync_control SET applying=1 WHERE id=1")
        .execute(&mut *conn)
        .await?;
    {
        if t.name == "audio_artifacts" {
            row.insert("path".into(), json!(""));
        }
        if t.name == "saved_items" {
            super::saved_items::make_room(conn, &row).await?;
        }
        let columns: Vec<_> = row.keys().cloned().collect();
        let assignments = columns
            .iter()
            .filter(|c| c.as_str() != "id" && c.as_str() != "path")
            .map(|c| format!("{c}=excluded.{c}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(id) DO UPDATE SET {}",
            t.name,
            columns.join(","),
            vec!["?"; columns.len()].join(","),
            assignments
        );
        let mut q = query(&sql);
        for column in &columns {
            let value = &row[column];
            q = match value {
                Value::Null => q.bind(Option::<String>::None),
                Value::String(s) => q.bind(s.clone()),
                Value::Number(n) if n.is_i64() => q.bind(n.as_i64()),
                Value::Number(n) => q.bind(n.as_f64()),
                Value::Bool(v) => q.bind(*v),
                _ => return Err(error("sync_format_invalid")),
            };
        }
        q.execute(&mut *conn).await?;
        if t.name == "agent_tasks" {
            if let Some(snapshot) = body.get("assistant_snapshot").filter(|v| !v.is_null()) {
                let parsed: crate::assistants::runtime::AssistantSnapshot =
                    serde_json::from_value(snapshot.clone())
                        .map_err(|_| error("sync_format_invalid"))?;
                query("INSERT INTO assistant_conversations(task_id,assistant_id,snapshot_json,created_at) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET assistant_id=excluded.assistant_id,snapshot_json=excluded.snapshot_json")
                    .bind(&c.object_id).bind(&parsed.definition.id).bind(snapshot.to_string()).bind(row.get("created_at").and_then(Value::as_str).unwrap_or_default()).execute(&mut *conn).await?;
            }
        }
        if t.name == "notes" {
            if let Some(summary) = body.get("summary") {
                super::summaries::apply(conn, &c.object_id, summary).await?;
            }
        }
        if t.name == "account_session_folders" {
            super::session_folders::apply(conn, &row).await?;
        }
        if t.name == "account_note_folders" {
            if row.get("deleted").and_then(Value::as_i64).unwrap_or(0) != 0 {
                query("DELETE FROM note_folders WHERE note_id=? AND folder_id=?")
                    .bind(row["note_id"].as_str())
                    .bind(row["folder_id"].as_str())
                    .execute(&mut *conn)
                    .await?;
            } else {
                query("INSERT OR IGNORE INTO note_folders(note_id,folder_id,assigned_at) VALUES(?,?,?)")
                    .bind(row["note_id"].as_str()).bind(row["folder_id"].as_str())
                    .bind(row["assigned_at"].as_str()).execute(&mut *conn).await?;
            }
        }
    }
    query("UPDATE account_sync_control SET applying=0 WHERE id=1")
        .execute(conn)
        .await?;
    Ok(true)
}
/// Inbox rows that could not be applied on arrival: a dependency that had
/// not come yet, a parent still waiting. Each pass admits what it can;
/// rows parked by an issue are not looked at until a person retries them.
async fn replay_pending(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    summary: &mut Summary,
) -> Result<(), AppError> {
    for _ in 0..TABLES.len() {
        let rows =
            query("SELECT * FROM account_sync_inbox WHERE applied=0 AND revision NOT IN (SELECT item_id FROM account_sync_issues WHERE lane='inbox') ORDER BY sequence LIMIT 200")
                .fetch_all(pool)
                .await?;
        let mut progressed = false;
        for r in rows {
            let c = Change {
                sequence: r.get("sequence"),
                resolved_revisions: serde_json::from_str(&r.get::<String, _>("resolved_revisions"))
                    .map_err(|_| error("sync_format_invalid"))?,
                object_id: r.get("object_id"),
                revision: r.get("revision"),
                parent_revision: r.get("parent_revision"),
                kind: r.get("kind"),
                ciphertext: r.get("ciphertext"),
                deleted: r.get("deleted"),
                operation_id: r.get("operation_id"),
            };
            let mut tx = pool.begin().await?;
            let outcome = admit(&mut tx, s, key, &c, summary).await?;
            tx.commit().await?;
            if outcome != Admitted::Waiting {
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    Ok(())
}
/// Days a deletion stays listed, and restorable, after it was decided.
const RECENTLY_DELETED_DAYS: i64 = 30;

/// Something a deletion took, as the account panel lists it (ADR-0108).
#[derive(Serialize, Clone, Debug)]
pub struct DeletedItem {
    pub object_id: String,
    pub kind: String,
    pub title: String,
    pub deleted_at: String,
}

/// When a time-ordered revision was minted, as the service mints them.
fn revision_time(revision: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let (seconds, nanos) = uuid::Uuid::parse_str(revision)
        .ok()?
        .get_timestamp()?
        .to_unix();
    chrono::DateTime::from_timestamp(i64::try_from(seconds).ok()?, nanos)
}

fn item_title(row: &Value) -> String {
    ["title", "name", "text", "content", "edited_content"]
        .iter()
        .filter_map(|field| row[*field].as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(|s| s.lines().next().unwrap_or_default().chars().take(120).collect())
        .unwrap_or_default()
}

/// The last live revision of an object this device holds as deleted, if the
/// journal still has one it can read.
async fn last_live_revision(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    object_id: &str,
    before: i64,
) -> Result<Option<(Change, Value)>, AppError> {
    let rows = query("SELECT * FROM account_sync_inbox WHERE object_id=? AND deleted=0 AND sequence<? ORDER BY sequence DESC LIMIT 5")
        .bind(object_id)
        .bind(before)
        .fetch_all(pool)
        .await?;
    for r in rows {
        let c = Change {
            sequence: r.get("sequence"),
            resolved_revisions: serde_json::from_str(&r.get::<String, _>("resolved_revisions"))
                .unwrap_or_default(),
            object_id: r.get("object_id"),
            revision: r.get("revision"),
            parent_revision: r.get("parent_revision"),
            kind: r.get("kind"),
            ciphertext: r.get("ciphertext"),
            deleted: r.get("deleted"),
            operation_id: r.get("operation_id"),
        };
        if let Ok(body) = verify(s, key, &c) {
            if matches!(body["table"].as_str(), Some("notes" | "memories")) {
                return Ok(Some((c, body)));
            }
        }
    }
    Ok(None)
}

/// Notes and memories a deletion took in the last thirty days, read from
/// the journal this device keeps: the tombstone that is the head, and the
/// last live revision before it. Nothing is listed that is back already.
pub(super) async fn recently_deleted(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<Vec<DeletedItem>, AppError> {
    let rows = query("SELECT h.object_id,h.kind,i.revision,i.sequence FROM account_sync_heads h JOIN account_sync_inbox i ON i.revision=h.revision WHERE i.deleted=1 AND h.kind IN ('note','memory') ORDER BY i.sequence DESC LIMIT 500")
        .fetch_all(pool)
        .await?;
    let horizon = chrono::Utc::now() - chrono::Duration::days(RECENTLY_DELETED_DAYS);
    let mut items = Vec::new();
    for row in rows {
        let object_id: String = row.get("object_id");
        let kind: String = row.get("kind");
        let revision: String = row.get("revision");
        let Some(at) = revision_time(&revision) else {
            continue;
        };
        if at < horizon {
            continue;
        }
        let table = if kind == "note" { "notes" } else { "memories" };
        let present = query(&format!("SELECT 1 FROM {table} WHERE id=?"))
            .bind(&object_id)
            .fetch_optional(pool)
            .await?
            .is_some();
        if present {
            continue;
        }
        let Some((_, body)) =
            last_live_revision(pool, s, key, &object_id, row.get("sequence")).await?
        else {
            continue;
        };
        items.push(DeletedItem {
            object_id,
            kind,
            title: item_title(&body["row"]),
            deleted_at: at.to_rfc3339(),
        });
        if items.len() >= 200 {
            break;
        }
    }
    Ok(items)
}

/// Brings a deleted note or memory back, on every device: its last live
/// revision is written here again and leaves as a child of the tombstone,
/// which every other device holds as the head and so applies. Children of a
/// note (recordings, transcripts) are not brought back; the text is.
pub(super) async fn restore_deleted(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    object_id: &str,
) -> Result<(), AppError> {
    let head = query("SELECT i.revision,i.sequence,i.kind FROM account_sync_heads h JOIN account_sync_inbox i ON i.revision=h.revision WHERE h.object_id=? AND i.deleted=1")
        .bind(object_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| error("sync_not_deleted"))?;
    let tombstone: String = head.get("revision");
    let kind: String = head.get("kind");
    let (live, body) = last_live_revision(pool, s, key, object_id, head.get("sequence"))
        .await?
        .ok_or_else(|| error("sync_restore_unavailable"))?;
    let mut tx = pool.begin().await?;
    if pending_unparked(&mut tx, object_id).await? {
        return Err(error("sync_pending_changes"));
    }
    let restored = Change {
        deleted: false,
        ..live
    };
    if !apply(&mut tx, &restored, &body).await? {
        return Err(error("sync_dependencies_pending"));
    }
    let op = uuid::Uuid::new_v4().to_string();
    let mut chosen = body;
    chosen["operation_id"] = json!(op);
    chosen["parent_revision"] = json!(tombstone);
    chosen["resolved_revisions"] = json!([]);
    chosen["deleted"] = json!(false);
    let encoded =
        Zeroizing::new(serde_json::to_vec(&chosen).map_err(|_| error("sync_format_invalid"))?);
    let ciphertext = crypto::seal(key, &aad(s, &kind, object_id), &encoded)?;
    query("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted,ciphertext,parent_revision,resolved_revisions) VALUES(?,?,?,'{}',0,?,?,'[]')")
        .bind(op)
        .bind(object_id)
        .bind(&kind)
        .bind(ciphertext)
        .bind(&tombstone)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn conflict_preview(app: &AppHandle, id: &str) -> Result<Value, AppError> {
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let key = vault_key(&s)?;
    let r = query("SELECT * FROM account_sync_conflicts WHERE id=? AND resolved=0")
        .bind(id)
        .fetch_one(&pool)
        .await?;
    let c = Change {
        sequence: 0,
        resolved_revisions: serde_json::from_str(&r.get::<String, _>("resolved_revisions"))
            .map_err(|_| error("sync_format_invalid"))?,
        object_id: r.get("object_id"),
        revision: r.get("id"),
        parent_revision: r.get("parent_revision"),
        kind: r.get("kind"),
        ciphertext: r.get("ciphertext"),
        deleted: r.get("deleted"),
        operation_id: r.get("operation_id"),
    };
    let remote = verify(&s, &key, &c)?;
    let name = remote["table"]
        .as_str()
        .ok_or_else(|| error("sync_format_invalid"))?;
    let local = if name == "carpe_diem_settings" {
        Some(json!({"base_url":crate::carpe_diem::settings::base_url()}))
    } else {
        let t = table(name)?;
        query(&format!(
            "SELECT {} AS body FROM {} WHERE id=?",
            row_json(t, ""),
            t.name
        ))
        .bind(&c.object_id)
        .fetch_optional(&pool)
        .await?
        .map(|r| serde_json::from_str::<Value>(&r.get::<String, _>("body")))
        .transpose()
        .map_err(|_| error("sync_format_invalid"))?
    };
    Ok(
        json!({"local_preview":local.as_ref().map(preview_text),"remote_preview":if c.deleted{None}else{Some(preview_text(&remote["row"]))},"deleted":c.deleted,"kind":c.kind}),
    )
}
fn preview_text(row: &Value) -> String {
    // Whitelist display fields. A generic JSON dump here would reveal the
    // provider key in a settings conflict, even though ordinary DTOs hide it.
    [
        "title",
        "name",
        "edited_content",
        "generated_content",
        "text",
        "content",
        "short_summary",
        "detailed_summary",
        "base_url",
        "format",
        "day",
        "model",
    ]
    .iter()
    .filter_map(|field| row[*field].as_str())
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n")
    .chars()
    .take(8000)
    .collect()
}
pub async fn resolve_conflict(app: &AppHandle, id: &str, resolution: &str) -> Result<(), AppError> {
    if resolution == "copy" {
        return restore_conflict(app, id).await;
    }
    if !matches!(resolution, "keep_local" | "use_remote" | "merge") {
        return Err(error("sync_resolution_invalid"));
    }
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let key = vault_key(&s)?;
    resolve_in_store(&pool, &s, &key, id, resolution).await
}
fn conflict_change(r: &sqlx_sqlite::SqliteRow) -> Result<Change, AppError> {
    Ok(Change {
        sequence: 0,
        resolved_revisions: serde_json::from_str(&r.get::<String, _>("resolved_revisions"))
            .map_err(|_| error("sync_format_invalid"))?,
        object_id: r.get("object_id"),
        revision: r.get("id"),
        parent_revision: r.get("parent_revision"),
        kind: r.get("kind"),
        ciphertext: r.get("ciphertext"),
        deleted: r.get("deleted"),
        operation_id: r.get("operation_id"),
    })
}
pub(super) async fn resolve_in_store(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    id: &str,
    resolution: &str,
) -> Result<(), AppError> {
    let r = query("SELECT * FROM account_sync_conflicts WHERE id=? AND resolved=0")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let c = conflict_change(&r)?;
    let remote = verify(s, key, &c)?;
    let mut tx = pool.begin().await?;
    if pending_unparked(&mut tx, &c.object_id).await? {
        return Err(error("sync_pending_changes"));
    }
    let parent = query("SELECT revision FROM account_sync_heads WHERE object_id=?")
        .bind(&c.object_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(|r| r.get::<String, _>("revision"));
    let mut chosen = remote.clone();
    let mut deleted = c.deleted;
    let name = remote["table"]
        .as_str()
        .ok_or_else(|| error("sync_format_invalid"))?;
    if resolution == "merge" {
        if name != "notes" || c.deleted {
            return Err(error("sync_conflict_requires_review"));
        }
        let base_revision = c
            .parent_revision
            .as_deref()
            .ok_or_else(|| error("sync_conflict_requires_review"))?;
        let local_head = parent
            .as_deref()
            .ok_or_else(|| error("sync_conflict_requires_review"))?;
        let head_parent: Option<String> = query(
            "SELECT parent_revision FROM account_sync_inbox WHERE revision=? AND object_id=?",
        )
        .bind(local_head)
        .bind(&c.object_id)
        .fetch_optional(&mut *tx)
        .await?
        .and_then(|row| row.get("parent_revision"));
        if head_parent.as_deref() != Some(base_revision) {
            return Err(error("sync_conflict_requires_review"));
        }
        let ancestor = query("SELECT ciphertext FROM account_sync_inbox WHERE revision=? AND object_id=? AND kind='note'")
            .bind(base_revision)
            .bind(&c.object_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| error("sync_conflict_requires_review"))?;
        let clear = crypto::open(
            key,
            &aad(s, "note", &c.object_id),
            &ancestor.get::<String, _>("ciphertext"),
        )?;
        let base: Value =
            serde_json::from_slice(&clear).map_err(|_| error("sync_format_invalid"))?;
        let notes = table("notes")?;
        let local = query(&format!(
            "SELECT {} AS body FROM notes WHERE id=?",
            snapshot_body(notes, "notes.")
        ))
        .bind(&c.object_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| error("sync_conflict_requires_review"))?;
        let local: Value = serde_json::from_str(&local.get::<String, _>("body"))
            .map_err(|_| error("sync_format_invalid"))?;
        chosen = merge_note_body(&base, &local, &remote)
            .ok_or_else(|| error("sync_conflict_requires_review"))?;
        if !apply(&mut tx, &c, &chosen).await? {
            return Err(error("sync_dependencies_pending"));
        }
        deleted = false;
    } else if resolution == "keep_local" {
        if name == "carpe_diem_settings" {
            let local=query("SELECT i.* FROM account_sync_inbox i JOIN account_sync_heads h ON h.revision=i.revision WHERE h.object_id=?").bind(&c.object_id).fetch_optional(&mut *tx).await?.ok_or_else(||error("sync_conflict_requires_review"))?;
            let clear = crypto::open(
                key,
                &aad(s, &c.kind, &c.object_id),
                &local.get::<String, _>("ciphertext"),
            )?;
            chosen = serde_json::from_slice(&clear).map_err(|_| error("sync_format_invalid"))?;
            deleted = chosen["deleted"]
                .as_bool()
                .ok_or_else(|| error("sync_format_invalid"))?;
        } else {
            let t = table(name)?;
            let local = query(&format!(
                "SELECT {} AS body FROM {} WHERE {}=?",
                snapshot_body(t, &format!("{}.", t.name)),
                t.name,
                object_column(t)
            ))
            .bind(&c.object_id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(local) = local {
                let snapshot: Value = serde_json::from_str(&local.get::<String, _>("body"))
                    .map_err(|_| error("sync_format_invalid"))?;
                chosen["row"] = snapshot["row"].clone();
                if t.name == "notes" {
                    chosen["summary"] = snapshot["summary"].clone();
                }
                deleted = false;
            } else {
                deleted = true;
            }
        }
    } else if c.deleted {
        query("UPDATE account_sync_control SET applying=1 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        if name == "carpe_diem_settings" {
            query("DELETE FROM account_sync_settings WHERE id=?")
                .bind(&c.object_id)
                .execute(&mut *tx)
                .await?;
        } else {
            delete_locally(&mut tx, table(name)?.name, &c.object_id).await?;
        }
        query("UPDATE account_sync_control SET applying=0 WHERE id=1")
            .execute(&mut *tx)
            .await?;
    } else if !apply(&mut tx, &c, &chosen).await? {
        return Err(error("sync_dependencies_pending"));
    }
    let tombstone_is_head = parent.as_deref() == Some(&c.revision);
    if deleted && c.deleted && tombstone_is_head {
        // The service already holds this deletion as the object's only head.
        // Answering it with a second tombstone would retire nothing there and
        // hand every other device a fresh card to answer in turn (ADR-0072).
        query("UPDATE account_sync_conflicts SET resolved=1 WHERE id=?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(());
    }
    let resolved = if tombstone_is_head {
        Vec::new()
    } else {
        vec![c.revision.clone()]
    };
    let op = uuid::Uuid::new_v4().to_string();
    chosen["operation_id"] = json!(op);
    chosen["parent_revision"] = json!(parent);
    chosen["resolved_revisions"] = json!(resolved);
    chosen["deleted"] = json!(deleted);
    let encoded =
        Zeroizing::new(serde_json::to_vec(&chosen).map_err(|_| error("sync_format_invalid"))?);
    let ciphertext = crypto::seal(key, &aad(s, &c.kind, &c.object_id), &encoded)?;
    query("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted,ciphertext,parent_revision,resolved_revisions) VALUES(?,?,?,'{}',?,?,?,?)").bind(op).bind(&c.object_id).bind(&c.kind).bind(deleted).bind(ciphertext).bind(parent).bind(json!(resolved).to_string()).execute(&mut *tx).await?;
    query("UPDATE account_sync_conflicts SET resolved=1 WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn restore_conflict(app: &AppHandle, id: &str) -> Result<(), AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let key = vault_key(&s)?;
    let r = query("SELECT * FROM account_sync_conflicts WHERE id=? AND resolved=0")
        .bind(id)
        .fetch_one(&pool)
        .await?;
    let c = Change {
        sequence: 0,
        resolved_revisions: serde_json::from_str(&r.get::<String, _>("resolved_revisions"))
            .map_err(|_| error("sync_format_invalid"))?,
        object_id: r.get("object_id"),
        revision: r.get("id"),
        parent_revision: r.get("parent_revision"),
        kind: r.get("kind"),
        ciphertext: r.get("ciphertext"),
        deleted: r.get("deleted"),
        operation_id: r.get("operation_id"),
    };
    let body = verify(&s, &key, &c)?;
    if body["table"] != "notes" || c.deleted {
        return Err(error("sync_conflict_requires_review"));
    }
    let row = &body["row"];
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let copied_id = uuid::Uuid::new_v4().to_string();
    query("INSERT INTO notes(id,title,generated_content,edited_content,processing_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(&copied_id).bind(row["title"].as_str().unwrap_or_default()).bind(row["generated_content"].as_str()).bind(row["edited_content"].as_str()).bind("ready").bind(&now).bind(&now).execute(&mut *tx).await?;
    if let Some(summary) = body.get("summary") {
        super::summaries::apply(&mut tx, &copied_id, summary).await?;
    }
    query("UPDATE account_sync_conflicts SET resolved=1 WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn share_credential(app: &AppHandle) -> Result<(), AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let key = vault_key(&s)?;
    // A device key belongs to this device (ADR-0069): every other device gets
    // its own from the account, and revoking one must not leave a copy alive
    // in the vault.
    if crate::carpe_diem::settings::issued_meta().is_some() {
        return Err(AppError::new(
            "carpe_diem_issued_not_shared",
            "This device's key was created for it alone. Your other devices get their own when they sign in.",
        ));
    }
    let (provider_base, provider) =
        crate::carpe_diem::settings::credentials().ok_or_else(|| error("carpe_diem_no_api_key"))?;
    let mut tx = pool.begin().await?;
    let parent = query("SELECT revision FROM account_sync_heads WHERE object_id=?")
        .bind(CREDENTIAL_ID)
        .fetch_optional(&mut *tx)
        .await?
        .map(|r| r.get::<String, _>("revision"));
    let op = uuid::Uuid::new_v4().to_string();
    let clear=Zeroizing::new(serde_json::to_vec(&json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":false,"table":"carpe_diem_settings","row":{"id":CREDENTIAL_ID,"api_key":provider.expose_str(),"base_url":provider_base}})).map_err(|_|error("sync_format_invalid"))?);
    let ciphertext = crypto::seal(&key, &aad(&s, "settings", CREDENTIAL_ID), &clear)?;
    query("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted,ciphertext,parent_revision) VALUES(?,?,'settings','{}',0,?,?)").bind(&op).bind(CREDENTIAL_ID).bind(&ciphertext).bind(&parent).execute(&mut *tx).await?;
    tx.commit().await?;
    // Sharing a credential is an explicit operation even if content sync is off.
    for _ in 0..100 {
        if !push_one(&pool, &s, &key, Some(CREDENTIAL_ID)).await? {
            break;
        }
    }
    Ok(())
}
pub async fn restore_credential(app: &AppHandle) -> Result<(), AppError> {
    // A foreground explicit restore can fetch settings without enabling content
    // upload. Read all encrypted pages and only decrypt the credential object.
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let key = vault_key(&s)?;
    let mut cursor = 0;
    let mut latest = None;
    for _ in 0..1000 {
        let data = call(
            &s,
            reqwest::Method::GET,
            &format!("/api/v1/sync?after={cursor}&limit=500&kind=settings"),
            None,
        )
        .await?;
        let page: Page = serde_json::from_value(data).map_err(|_| error("sync_format_invalid"))?;
        if page.cursor < cursor {
            return Err(error("sync_format_invalid"));
        }
        for c in page.changes {
            if c.kind == "settings" && c.object_id == CREDENTIAL_ID {
                let body = verify(&s, &key, &c)?;
                latest = Some((c, body));
            }
        }
        cursor = page.cursor;
        if !page.has_more {
            break;
        }
    }
    let (c, body) = latest.ok_or_else(|| error("vault_credential_missing"))?;
    if c.deleted {
        return Err(error("vault_credential_missing"));
    }
    let base = body["row"]["base_url"]
        .as_str()
        .ok_or_else(|| error("sync_format_invalid"))?;
    let api_key = body["row"]["api_key"]
        .as_str()
        .ok_or_else(|| error("sync_format_invalid"))?;
    crate::carpe_diem::settings::restore_account_credential(app, base, api_key).await?;
    Ok(())
}

async fn capture_turn_usage(pool: &SqlitePool) -> Result<(), AppError> {
    static RUN_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let stats = crate::carpe_diem::cache_stats::snapshot();
    if stats.turns == 0 {
        return Ok(());
    }
    let id = RUN_ID.get_or_init(|| uuid::Uuid::new_v4().to_string());
    if query("SELECT turns FROM account_turn_usage WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .is_some_and(|r| r.get::<i64, _>("turns") as u64 == stats.turns)
    {
        return Ok(());
    }
    let device: Option<String> = query("SELECT device_id FROM account_sync_control WHERE id=1")
        .fetch_one(pool)
        .await?
        .get("device_id");
    let Some(device) = device else {
        return Ok(());
    };
    let count = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
    query("INSERT INTO account_turn_usage(id,device_id,sampled_at,turns,prompt_tokens,completion_tokens,cached_tokens,cost_usdc_micro,cache_saved_usdc_micro) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sampled_at=excluded.sampled_at,turns=excluded.turns,prompt_tokens=excluded.prompt_tokens,completion_tokens=excluded.completion_tokens,cached_tokens=excluded.cached_tokens,cost_usdc_micro=excluded.cost_usdc_micro,cache_saved_usdc_micro=excluded.cache_saved_usdc_micro")
        .bind(id).bind(device).bind(chrono::Utc::now().to_rfc3339()).bind(count(stats.turns)).bind(count(stats.prompt_tokens)).bind(count(stats.completion_tokens)).bind(count(stats.cached_tokens)).bind((stats.cost_usdc_micro>0).then(||count(stats.cost_usdc_micro))).bind(count(stats.cache_saved_usdc_micro)).execute(pool).await?;
    Ok(())
}
async fn capture_balance(pool: &SqlitePool) -> Result<(), AppError> {
    let device: Option<String> = query("SELECT device_id FROM account_sync_control WHERE id=1")
        .fetch_one(pool)
        .await?
        .get("device_id");
    let Some(device) = device else {
        return Ok(());
    };
    let current = query("SELECT id,sampled_at FROM account_billing WHERE device_id=?")
        .bind(&device)
        .fetch_optional(pool)
        .await?;
    if let Some(row) = &current {
        if chrono::DateTime::parse_from_rfc3339(&row.get::<String, _>("sampled_at"))
            .is_ok_and(|t| chrono::Utc::now().signed_duration_since(t).num_seconds() < 300)
        {
            return Ok(());
        }
    }
    let credits = crate::carpe_diem::settings::carpe_diem_get_credits().await?;
    let id = current
        .map(|r| r.get::<String, _>("id"))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    query("INSERT INTO account_billing(id,device_id,sampled_at,available_credits,escrow_credits,rail,price_multiplier) VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET sampled_at=excluded.sampled_at,available_credits=excluded.available_credits,escrow_credits=excluded.escrow_credits,rail=excluded.rail,price_multiplier=excluded.price_multiplier")
        .bind(id).bind(device).bind(chrono::Utc::now().to_rfc3339()).bind(credits.available_credits).bind(credits.escrow_credits).bind(credits.rail).bind(credits.price_multiplier).execute(pool).await?;
    Ok(())
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "sync_web_tests.rs"]
mod web_tests;

#[cfg(test)]
#[path = "sync_connector_tests.rs"]
mod connector_tests;

#[cfg(test)]
#[path = "sync_fake_service.rs"]
pub(super) mod fake_service;

#[cfg(test)]
#[path = "sync_devices_tests.rs"]
mod devices_tests;
