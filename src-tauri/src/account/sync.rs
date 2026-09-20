//! Durable object synchronization. SQLite triggers journal the same transaction
//! as a local edit. A frozen payload is retried with the same operation id.
//! Inbound revisions and cursor commit together; conflicts never overwrite.
use super::*;
use sqlx_sqlite::SqliteConnection;
use tauri::Emitter;

pub const CREDENTIAL_ID: &str = "00000000-0000-4000-8000-000000000001";
struct Table {
    name: &'static str,
    kind: &'static str,
    columns: &'static [&'static str],
}
const TABLES: &[Table] = &[
    Table {
        name: "ingests",
        kind: "artifact",
        columns: &[
            "id",
            "url",
            "kind",
            "status",
            "title",
            "note_id",
            "folder_id",
            "bytes_done",
            "bytes_total",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "account_studio_files",
        kind: "artifact",
        columns: &[
            "id",
            "file_name",
            "format",
            "bytes",
            "created_at",
            "model",
            "prompt",
        ],
    },
    Table {
        name: "account_turn_usage",
        kind: "usage",
        columns: &[
            "id",
            "device_id",
            "sampled_at",
            "turns",
            "prompt_tokens",
            "completion_tokens",
            "cached_tokens",
            "cost_usdc_micro",
            "cache_saved_usdc_micro",
        ],
    },
    Table {
        name: "account_billing",
        kind: "usage",
        columns: &[
            "id",
            "device_id",
            "sampled_at",
            "available_credits",
            "escrow_credits",
            "rail",
            "price_multiplier",
        ],
    },
    Table {
        name: "account_note_folders",
        kind: "folder",
        columns: &["id", "note_id", "folder_id", "assigned_at", "deleted"],
    },
    Table {
        name: "account_usage",
        kind: "usage",
        columns: &[
            "id",
            "device_id",
            "day",
            "model",
            "request_count",
            "request_bytes",
            "response_bytes",
        ],
    },
    Table {
        name: "account_file_manifests",
        kind: "artifact",
        columns: &[
            "id",
            "artifact_id",
            "bytes",
            "format",
            "chunks_json",
            "created_at",
            "source_kind",
        ],
    },
    Table {
        name: "folders",
        kind: "folder",
        columns: &[
            "id",
            "name",
            "description",
            "created_at",
            "updated_at",
            "deleted_at",
        ],
    },
    Table {
        name: "notes",
        kind: "note",
        columns: &[
            "id",
            "title",
            "generated_content",
            "edited_content",
            "active_tab",
            "processing_status",
            "created_at",
            "updated_at",
            "calendar_event_id",
            "scheduled_start",
            "attendees_json",
        ],
    },
    Table {
        name: "recording_sessions",
        kind: "artifact",
        columns: &[
            "id",
            "note_id",
            "status",
            "started_at",
            "ended_at",
            "expected_elapsed_ms",
            "source_mode",
        ],
    },
    Table {
        name: "audio_artifacts",
        kind: "artifact",
        columns: &[
            "id",
            "note_id",
            "recording_session_id",
            "format",
            "duration_ms",
            "size_bytes",
            "checksum",
            "created_at",
            "source",
        ],
    },
    Table {
        name: "transcripts",
        kind: "transcript",
        columns: &[
            "id",
            "note_id",
            "audio_artifact_id",
            "text",
            "language",
            "provider",
            "status",
            "created_at",
            "updated_at",
            "recording_session_id",
            "source",
            "start_ms",
            "end_ms",
            "turn_index",
            "source_mode",
        ],
    },
    Table {
        name: "memories",
        kind: "memory",
        columns: &[
            "id",
            "text",
            "source",
            "importance",
            "disabled",
            "created_at",
            "updated_at",
        ],
    },
    Table {
        name: "agent_tasks",
        kind: "conversation",
        columns: &[
            "id",
            "title",
            "prompt",
            "status",
            "safety_profile",
            "progress_summary",
            "created_at",
            "updated_at",
            "completed_at",
            "model",
        ],
    },
    // An errand travels as an ordinary revision: the service carries it without
    // being able to read the link inside, and the device it names is the only
    // one that acts on it (ADR-0054).
    Table {
        name: "account_errands",
        kind: "errand",
        columns: &[
            "id",
            "device_id",
            "url",
            "folder_id",
            "requested_by",
            "requested_at",
            "state",
            "note_id",
            "message",
            "updated_at",
        ],
    },
    Table {
        name: "agent_messages",
        kind: "conversation",
        columns: &[
            "id",
            "task_id",
            "role",
            "content",
            "created_at",
            "external_id",
        ],
    },
];
const UUID_SQL:&str="(lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))))";
fn table(name: &str) -> Result<&'static Table, AppError> {
    TABLES
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| error("sync_format_invalid"))
}
fn row_json(t: &Table, prefix: &str) -> String {
    format!(
        "json_object({})",
        t.columns
            .iter()
            .map(|c| format!("'{c}',{prefix}{c}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn snapshot_body(t: &Table, prefix: &str) -> String {
    if t.name == "notes" {
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
/// Installed only after the additive schema migration. The trigger body is
/// executed as one SQLite statement, not fed to the legacy semicolon splitter.
pub async fn install(pool: &SqlitePool) -> Result<(), sqlx::error::Error> {
    for t in TABLES {
        for (action, prefix, deleted) in [
            ("INSERT", "NEW.", 0),
            ("UPDATE", "NEW.", 0),
            ("DELETE", "OLD.", 1),
        ] {
            let sql=format!("CREATE TRIGGER IF NOT EXISTS account_sync_{}_{} AFTER {} ON {} WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1) BEGIN INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) VALUES ({UUID_SQL},{prefix}id,'{}',{},{deleted}); END",t.name,action.to_lowercase(),action,t.name,t.kind,snapshot_body(t,prefix));
            query(&sql).execute(pool).await?;
        }
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
        query(&format!("CREATE TRIGGER IF NOT EXISTS account_summary_{} AFTER {} ON note_summaries WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1){} BEGIN INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) SELECT {UUID_SQL},notes.id,'note',{},0 FROM notes WHERE notes.id={prefix}note_id; END",action.to_lowercase(),action,ready,snapshot_body(notes,"notes."))).execute(pool).await?;
    }
    query(&format!("CREATE TRIGGER IF NOT EXISTS account_membership_insert AFTER INSERT ON note_folders WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1) BEGIN INSERT INTO account_note_folders(id,note_id,folder_id,assigned_at) SELECT {UUID_SQL},NEW.note_id,NEW.folder_id,NEW.assigned_at WHERE NOT EXISTS(SELECT 1 FROM account_note_folders WHERE note_id=NEW.note_id AND folder_id=NEW.folder_id); UPDATE account_note_folders SET deleted=0,assigned_at=NEW.assigned_at WHERE note_id=NEW.note_id AND folder_id=NEW.folder_id; END")).execute(pool).await?;
    query("CREATE TRIGGER IF NOT EXISTS account_membership_delete AFTER DELETE ON note_folders WHEN (SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1) BEGIN UPDATE account_note_folders SET deleted=1 WHERE note_id=OLD.note_id AND folder_id=OLD.folder_id; END").execute(pool).await?;
    query(&format!("CREATE TRIGGER IF NOT EXISTS account_usage_insert AFTER INSERT ON egress_ledger WHEN NEW.method='POST' AND NEW.purpose IN ('chat','transcription','embeddings','note generation','dictation','image','video','speech','music','ask') AND (SELECT account_id IS NOT NULL AND device_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1) BEGIN INSERT INTO account_usage(id,device_id,day,model,request_count,request_bytes,response_bytes) VALUES ({UUID_SQL},(SELECT device_id FROM account_sync_control WHERE id=1),substr(NEW.at,1,10),COALESCE(NEW.model,''),1,NEW.request_bytes,NEW.response_bytes) ON CONFLICT(device_id,day,model) DO UPDATE SET request_count=request_count+1,request_bytes=request_bytes+NEW.request_bytes,response_bytes=response_bytes+NEW.response_bytes; END")).execute(pool).await?;
    Ok(())
}
pub async fn set_enabled(pool: &SqlitePool, enabled: bool) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    if enabled {
        query(&format!("INSERT INTO account_note_folders(id,note_id,folder_id,assigned_at) SELECT {UUID_SQL},nf.note_id,nf.folder_id,nf.assigned_at FROM note_folders nf WHERE NOT EXISTS(SELECT 1 FROM account_note_folders s WHERE s.note_id=nf.note_id AND s.folder_id=nf.folder_id)")).execute(&mut *tx).await?;
        let count: i64 = query("SELECT count(*) AS n FROM account_sync_heads")
            .fetch_one(&mut *tx)
            .await?
            .get("n");
        // The first inventory is captured in the same write transaction as enable.
        if count == 0 {
            for t in TABLES {
                let sql=format!("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) SELECT {UUID_SQL},id,'{}',{},0 FROM {} WHERE id NOT IN (SELECT object_id FROM account_sync_outbox)",t.kind,snapshot_body(t,&format!("{}.",t.name)),t.name);
                query(&sql).execute(&mut *tx).await?;
            }
        }
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
            let _ = app.emit("subrosa://sync-updated", ());
        }
    }
    result
}
async fn run_inner(app: &AppHandle) -> Result<(), AppError> {
    #[cfg(desktop)]
    let _ = super::conversations::backfill_desktop(app).await;
    let Ok(_guard) = SESSION_LOCK.try_lock() else {
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
    synchronize(&pool, &s, &key).await?;
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
    let _ = app.emit("subrosa://sync-updated", ());
    Ok(())
}
pub(super) async fn synchronize(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<(), AppError> {
    // Push before pulling: a local edit is either acknowledged, or preserved as
    // a sibling by the server. Incoming changes cannot race this run's lock.
    for _ in 0..100 {
        if !push_one(pool, s, key, None).await? {
            break;
        }
    }
    for _ in 0..10 {
        let cursor: i64 = query("SELECT cursor FROM account_sync_control WHERE id=1")
            .fetch_one(pool)
            .await?
            .get("cursor");
        let data = call(
            s,
            reqwest::Method::GET,
            &format!("/api/v1/sync?after={cursor}&limit=100"),
            None,
        )
        .await?;
        let page: Page = serde_json::from_value(data).map_err(|_| error("sync_format_invalid"))?;
        if page.cursor < cursor || page.changes.len() > 100 {
            return Err(error("sync_format_invalid"));
        }
        let mut tx = pool.begin().await?;
        for change in &page.changes {
            if change.sequence <= cursor || change.sequence > page.cursor {
                return Err(error("sync_format_invalid"));
            }
            // Authenticate even replayed/own revisions. Server substitution is rejected
            // before any cursor or local content changes.
            let body = verify(s, key, change)?;
            let existing = query("SELECT revision FROM account_sync_inbox WHERE revision=?")
                .bind(&change.revision)
                .fetch_optional(&mut *tx)
                .await?;
            if existing.is_some() {
                continue;
            }
            query("INSERT INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,sequence,resolved_revisions) VALUES(?,?,?,?,?,?,?,?,?)").bind(&change.revision).bind(&change.object_id).bind(&change.kind).bind(&change.ciphertext).bind(&change.parent_revision).bind(&change.operation_id).bind(change.deleted).bind(change.sequence).bind(json!(change.resolved_revisions).to_string()).execute(&mut *tx).await?;
            let head = query("SELECT revision FROM account_sync_heads WHERE object_id=?")
                .bind(&change.object_id)
                .fetch_optional(&mut *tx)
                .await?
                .map(|r| r.get::<String, _>("revision"));
            let pending = query("SELECT 1 FROM account_sync_outbox WHERE object_id=? LIMIT 1")
                .bind(&change.object_id)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
            if head.as_deref() == Some(&change.revision) {
                mark_applied(&mut tx, &change.revision).await?;
                continue;
            }
            if pending
                || (head.is_some()
                    && head != change.parent_revision
                    && !head
                        .as_ref()
                        .is_some_and(|h| change.resolved_revisions.contains(h)))
            {
                preserve(&mut tx, change).await?;
                mark_applied(&mut tx, &change.revision).await?;
                continue;
            }
            // Dependencies can arrive in a later page. A durable inbox retains them and
            // replay_pending below retries once their parent note/task is present.
            if apply(&mut tx, change, &body).await? {
                head_and_applied(&mut tx, change).await?;
            }
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
    replay_pending(pool, s, key).await?;
    Ok(())
}
async fn push_one(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    object_filter: Option<&str>,
) -> Result<bool, AppError> {
    let row = query("SELECT * FROM account_sync_outbox WHERE (?1 IS NULL OR object_id=?1) ORDER BY sequence LIMIT 1")
        .bind(object_filter)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let sequence: i64 = row.get("sequence");
    let resolved_revisions: Vec<String> =
        serde_json::from_str(&row.get::<String, _>("resolved_revisions"))
            .map_err(|_| error("sync_format_invalid"))?;
    let operation_id: String = row.get("operation_id");
    let id: String = row.get("object_id");
    let kind: String = row.get("kind");
    let deleted: bool = row.get("deleted");
    let existing: Option<String> = row.get("ciphertext");
    let (ciphertext, parent) = if let Some(ciphertext) = existing {
        (ciphertext, row.get::<Option<String>, _>("parent_revision"))
    } else {
        let mut tx = pool.begin().await?;
        let parent = query("SELECT revision FROM account_sync_heads WHERE object_id=?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?
            .map(|r| r.get::<String, _>("revision"));
        let mut body: Value = serde_json::from_str(&row.get::<String, _>("body"))
            .map_err(|_| error("sync_format_invalid"))?;
        body["v"] = json!(1);
        body["operation_id"] = json!(operation_id);
        body["parent_revision"] = json!(parent);
        body["deleted"] = json!(deleted);
        body["resolved_revisions"] = json!(resolved_revisions);
        let clear =
            Zeroizing::new(serde_json::to_vec(&body).map_err(|_| error("sync_format_invalid"))?);
        let ciphertext = crypto::seal(key, &aad(s, &kind, &id), &clear)?;
        query("UPDATE account_sync_outbox SET ciphertext=?,parent_revision=? WHERE sequence=?")
            .bind(&ciphertext)
            .bind(&parent)
            .bind(sequence)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        (ciphertext, parent)
    };
    if ciphertext.len() > 1024 * 1024 {
        return Err(error("sync_object_too_large"));
    }
    let data=call(s,reqwest::Method::POST,"/api/v1/sync",Some(json!({"operations":[{"operation_id":operation_id,"object_id":id,"parent_revision":parent,"kind":kind,"ciphertext":ciphertext,"deleted":deleted,"resolved_revisions":resolved_revisions}]}))).await?;
    let result: PushResults =
        serde_json::from_value(data).map_err(|_| error("sync_format_invalid"))?;
    if result.results.len() != 1 {
        return Err(error("sync_format_invalid"));
    }
    let result = &result.results[0];
    if result.operation_id != operation_id {
        return Err(error("sync_format_invalid"));
    }
    let mut tx = pool.begin().await?;
    // The local variant already exists on this device. The pull will preserve
    // the *other* branch; listing our own pushed sibling as a conflict would
    // repeatedly ask the user to resolve a value already on screen.
    let _server_preserved_sibling = result.conflict;
    // Even a sibling becomes this device's own head. Other branch changes are
    // retained as conflicts on pull, never silently applied over the local edit.
    query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind").bind(&id).bind(&result.revision).bind(&kind).execute(&mut *tx).await?;
    query("INSERT OR IGNORE INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,sequence,applied,resolved_revisions) VALUES(?,?,?,?,?,?,?,?,1,?)")
        .bind(&result.revision).bind(&id).bind(&kind).bind(&ciphertext)
        .bind(&parent).bind(&operation_id).bind(deleted).bind(result.sequence).bind(json!(resolved_revisions).to_string())
        .execute(&mut *tx).await?;
    query("DELETE FROM account_sync_outbox WHERE sequence=?")
        .bind(sequence)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
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
    if body["row"]["id"] != c.object_id {
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
        && row.get("source_kind").and_then(Value::as_str) == Some("studio")
    {
        "account_studio_files"
    } else {
        "audio_artifacts"
    };
    for (field, parent) in [
        ("note_id", "notes"),
        ("task_id", "agent_tasks"),
        ("folder_id", "folders"),
        ("artifact_id", artifact_table),
        ("recording_session_id", "recording_sessions"),
        ("audio_artifact_id", "audio_artifacts"),
    ] {
        if let Some(id) = row.get(field).and_then(Value::as_str) {
            let found = query(&format!("SELECT 1 FROM {parent} WHERE id=?"))
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?
                .is_some();
            if !found {
                return Ok(false);
            }
        }
    }
    query("UPDATE account_sync_control SET applying=1 WHERE id=1")
        .execute(&mut *conn)
        .await?;
    if c.deleted {
        // Remote deletions are preserved for explicit review. Cascading a note
        // delete could erase newer children which the deleting device never saw.
        preserve(conn, c).await?;
    } else {
        if t.name == "audio_artifacts" {
            row.insert("path".into(), json!(""));
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
        if t.name == "notes" {
            if let Some(summary) = body.get("summary") {
                super::summaries::apply(conn, &c.object_id, summary).await?;
            }
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
async fn replay_pending(pool: &SqlitePool, s: &Session, key: &[u8; 32]) -> Result<(), AppError> {
    for _ in 0..TABLES.len() {
        let rows =
            query("SELECT * FROM account_sync_inbox WHERE applied=0 ORDER BY sequence LIMIT 1000")
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
            let body = verify(s, key, &c)?;
            let mut tx = pool.begin().await?;
            let pending = query("SELECT 1 FROM account_sync_outbox WHERE object_id=? LIMIT 1")
                .bind(&c.object_id)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
            let head = query("SELECT revision FROM account_sync_heads WHERE object_id=?")
                .bind(&c.object_id)
                .fetch_optional(&mut *tx)
                .await?
                .map(|r| r.get::<String, _>("revision"));
            if pending
                || (head.is_some()
                    && head != c.parent_revision
                    && !head
                        .as_ref()
                        .is_some_and(|h| c.resolved_revisions.contains(h)))
            {
                preserve(&mut tx, &c).await?;
                mark_applied(&mut tx, &c.revision).await?;
                progressed = true;
            } else if apply(&mut tx, &c, &body).await? {
                head_and_applied(&mut tx, &c).await?;
                progressed = true;
            }
            tx.commit().await?;
        }
        if !progressed {
            break;
        }
    }
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
    if !matches!(resolution, "keep_local" | "use_remote") {
        return Err(error("sync_resolution_invalid"));
    }
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    let key = vault_key(&s)?;
    resolve_in_store(&pool, &s, &key, id, resolution).await
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
    let remote = verify(s, key, &c)?;
    let mut tx = pool.begin().await?;
    if query("SELECT 1 FROM account_sync_outbox WHERE object_id=? LIMIT 1")
        .bind(&c.object_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    {
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
    if resolution == "keep_local" {
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
                "SELECT {} AS body FROM {} WHERE id=?",
                snapshot_body(t, &format!("{}.", t.name)),
                t.name
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
            let t = table(name)?;
            query(&format!("DELETE FROM {} WHERE id=?", t.name))
                .bind(&c.object_id)
                .execute(&mut *tx)
                .await?;
        }
        query("UPDATE account_sync_control SET applying=0 WHERE id=1")
            .execute(&mut *tx)
            .await?;
    } else if !apply(&mut tx, &c, &chosen).await? {
        return Err(error("sync_dependencies_pending"));
    }
    let resolved = if parent.as_deref() == Some(&c.revision) {
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
            &format!("/api/v1/sync?after={cursor}&limit=100"),
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
mod tests {
    use super::*;
    use sqlx_sqlite::SqlitePoolOptions;

    async fn database() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        query("UPDATE account_sync_control SET account_id='account-one' WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }
    async fn insert_note(conn: &mut SqliteConnection, id: &str, title: &str) {
        query("INSERT INTO notes(id,title,created_at,updated_at) VALUES(?,?,?,?)")
            .bind(id)
            .bind(title)
            .bind("2026-09-14T12:00:00Z")
            .bind("2026-09-14T12:00:00Z")
            .execute(conn)
            .await
            .unwrap();
    }
    fn session_fixture() -> Session {
        Session {
            base: "https://example.test".into(),
            account: Account {
                id: "account-one".into(),
                email: "one@example.test".into(),
                created_at: "now".into(),
            },
            token: Redacted::new("opaque-test-session".into()),
        }
    }
    fn change(s: &Session, key: &[u8; 32], id: &str, parent: Option<String>, row: Value) -> Change {
        let op = uuid::Uuid::new_v4().to_string();
        let body = json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":false,"table":"notes","row":row});
        Change {
            sequence: 1,
            resolved_revisions: Vec::new(),
            object_id: id.into(),
            revision: uuid::Uuid::new_v4().to_string(),
            parent_revision: parent,
            kind: "note".into(),
            ciphertext: crypto::seal(
                key,
                &aad(s, "note", id),
                &serde_json::to_vec(&body).unwrap(),
            )
            .unwrap(),
            deleted: false,
            operation_id: Some(op),
        }
    }
    #[tokio::test]
    async fn oversized_object_is_retained_and_reported_before_network() {
        let pool = database().await;
        let id = uuid::Uuid::new_v4().to_string();
        query("INSERT INTO notes(id,title,created_at,updated_at) VALUES(?,?,'now','now')")
            .bind(&id)
            .bind("x".repeat(800_000))
            .execute(&pool)
            .await
            .unwrap();
        let error = push_one(&pool, &session_fixture(), &[3; 32], None)
            .await
            .unwrap_err();
        assert_eq!(error.code, "sync_object_too_large");
        let row = query("SELECT ciphertext FROM account_sync_outbox WHERE object_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(row.get::<String, _>("ciphertext").len() > 1024 * 1024);
    }

    #[tokio::test]
    async fn edit_and_outbox_are_atomic_and_disabled_sync_retains_edits() {
        let pool = database().await;
        let id = uuid::Uuid::new_v4().to_string();
        let mut tx = pool.begin().await.unwrap();
        insert_note(&mut tx, &id, "Local draft").await;
        tx.rollback().await.unwrap();
        assert_eq!(
            query("SELECT count(*) AS n FROM account_sync_outbox")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<i64, _>("n"),
            0
        );
        let mut conn = pool.acquire().await.unwrap();
        insert_note(&mut conn, &id, "Private draft").await;
        drop(conn);
        let r = query("SELECT object_id,body,ciphertext FROM account_sync_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(r.get::<String, _>("object_id"), id);
        assert!(r.get::<String, _>("body").contains("Private draft"));
        assert!(r.get::<Option<String>, _>("ciphertext").is_none());
        query("UPDATE notes SET title='Changed while offline' WHERE id=?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            query("SELECT count(*) AS n FROM account_sync_outbox")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<i64, _>("n"),
            2
        );
    }
    #[tokio::test]
    async fn inbound_apply_does_not_echo_and_never_starts_processing() {
        let pool = database().await;
        let s = session_fixture();
        let key = crypto::random_key();
        let id = uuid::Uuid::new_v4().to_string();
        let c = change(
            &s,
            &key,
            &id,
            None,
            json!({"id":id,"title":"Remote work","processing_status":"transcribing","created_at":"now","updated_at":"now"}),
        );
        let body = verify(&s, &key, &c).unwrap();
        let mut tx = pool.begin().await.unwrap();
        assert!(apply(&mut tx, &c, &body).await.unwrap());
        tx.commit().await.unwrap();
        let r = query("SELECT title,processing_status FROM notes WHERE id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(r.get::<String, _>("title"), "Remote work");
        assert_eq!(r.get::<String, _>("processing_status"), "ready");
        assert_eq!(
            query("SELECT count(*) AS n FROM account_sync_outbox")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<i64, _>("n"),
            0
        );
    }
    #[test]
    fn ciphertext_authenticates_account_object_kind_and_operation_metadata() {
        let s = session_fixture();
        let key = crypto::random_key();
        let id = uuid::Uuid::new_v4().to_string();
        let mut c = change(&s, &key, &id, None, json!({"id":id}));
        assert!(verify(&s, &key, &c).is_ok());
        c.parent_revision = Some(uuid::Uuid::new_v4().to_string());
        assert!(verify(&s, &key, &c).is_err());
        c.parent_revision = None;
        c.operation_id = Some(uuid::Uuid::new_v4().to_string());
        assert!(verify(&s, &key, &c).is_err());
        c.kind = "memory".into();
        assert!(verify(&s, &key, &c).is_err());
    }
    #[tokio::test]
    async fn sibling_conflicts_are_preserved_without_replacing_local_content() {
        let pool = database().await;
        let s = session_fixture();
        let key = crypto::random_key();
        let id = uuid::Uuid::new_v4().to_string();
        let mut conn = pool.acquire().await.unwrap();
        insert_note(&mut conn, &id, "Local variant").await;
        drop(conn);
        let c = change(
            &s,
            &key,
            &id,
            None,
            json!({"id":id,"title":"Remote variant"}),
        );
        let mut tx = pool.begin().await.unwrap();
        preserve(&mut tx, &c).await.unwrap();
        preserve(&mut tx, &c).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            query("SELECT count(*) AS n FROM account_sync_conflicts")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<i64, _>("n"),
            1
        );
        assert_eq!(
            query("SELECT title FROM notes WHERE id=?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<String, _>("title"),
            "Local variant"
        );
        let stored: String = query("SELECT ciphertext FROM account_sync_conflicts")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("ciphertext");
        assert!(!stored.contains("Remote variant"));
    }
    #[tokio::test]
    async fn rolled_back_inbound_apply_cannot_suppress_future_local_edits() {
        let pool = database().await;
        let id = uuid::Uuid::new_v4().to_string();
        let mut tx = pool.begin().await.unwrap();
        query("UPDATE account_sync_control SET applying=1 WHERE id=1")
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        insert_note(&mut conn, &id, "Survives interruption").await;
        drop(conn);
        assert_eq!(
            query("SELECT count(*) AS n FROM account_sync_outbox")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<i64, _>("n"),
            1
        );
    }
    #[tokio::test]
    async fn imported_unfinished_conversation_is_history_not_paid_work() {
        let pool = database().await;
        let s = session_fixture();
        let key = crypto::random_key();
        let id = uuid::Uuid::new_v4().to_string();
        let op = uuid::Uuid::new_v4().to_string();
        let body = json!({"v":1,"operation_id":op,"parent_revision":null,"deleted":false,"table":"agent_tasks","row":{"id":id,"title":"Conversation","prompt":"Continue","status":"running","safety_profile":"balanced","created_at":"now","updated_at":"now"}});
        let c = Change {
            sequence: 1,
            resolved_revisions: Vec::new(),
            object_id: id.clone(),
            revision: uuid::Uuid::new_v4().to_string(),
            parent_revision: None,
            kind: "conversation".into(),
            ciphertext: crypto::seal(
                &key,
                &aad(&s, "conversation", &id),
                &serde_json::to_vec(&body).unwrap(),
            )
            .unwrap(),
            deleted: false,
            operation_id: Some(op),
        };
        let mut tx = pool.begin().await.unwrap();
        assert!(apply(&mut tx, &c, &verify(&s, &key, &c).unwrap())
            .await
            .unwrap());
        tx.commit().await.unwrap();
        query("INSERT INTO agent_messages(id,task_id,role,content,created_at) VALUES(?,?,'user','Waiting for paid reply','now')").bind(uuid::Uuid::new_v4().to_string()).bind(&id).execute(&pool).await.unwrap();
        let repos = crate::db::repositories::Repositories::new(pool);
        assert!(repos.agent_tasks_awaiting_reply().await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn keeping_local_note_preserves_its_own_summary_in_encrypted_merge() {
        let pool = database().await;
        let s = session_fixture();
        let key = crypto::random_key();
        let id = uuid::Uuid::new_v4().to_string();
        let mut conn = pool.acquire().await.unwrap();
        insert_note(&mut conn, &id, "Local title").await;
        drop(conn);
        query("INSERT INTO note_summaries(note_id,status,short_summary,model,prompt_version,created_at,updated_at) VALUES(?,'ready','Local summary','model','v1','now','now')").bind(&id).execute(&pool).await.unwrap();
        query("DELETE FROM account_sync_outbox")
            .execute(&pool)
            .await
            .unwrap();
        query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,'note')")
            .bind(&id)
            .bind(uuid::Uuid::new_v4().to_string())
            .execute(&pool)
            .await
            .unwrap();
        let mut c = change(
            &s,
            &key,
            &id,
            None,
            json!({"id":id,"title":"Remote title","created_at":"now","updated_at":"now"}),
        );
        let mut body = verify(&s, &key, &c).unwrap();
        body["summary"] = json!({"short_summary":"Remote summary"});
        c.ciphertext = crypto::seal(
            &key,
            &aad(&s, "note", &id),
            &serde_json::to_vec(&body).unwrap(),
        )
        .unwrap();
        let mut tx = pool.begin().await.unwrap();
        preserve(&mut tx, &c).await.unwrap();
        tx.commit().await.unwrap();
        resolve_in_store(&pool, &s, &key, &c.revision, "keep_local")
            .await
            .unwrap();
        let encrypted: String =
            query("SELECT ciphertext FROM account_sync_outbox WHERE object_id=?")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .get("ciphertext");
        let clear = crypto::open(&key, &aad(&s, "note", &id), &encrypted).unwrap();
        let merged: Value = serde_json::from_slice(&clear).unwrap();
        assert_eq!(merged["row"]["title"], "Local title");
        assert_eq!(merged["summary"]["short_summary"], "Local summary");
        assert_eq!(merged["resolved_revisions"], json!([c.revision]));
    }
    #[tokio::test]
    async fn usage_ignores_account_network_and_counts_only_inference_attempts() {
        let pool = database().await;
        query("UPDATE account_sync_control SET device_id='device-one' WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        for (purpose, method) in [
            ("account sync", "POST"),
            ("models", "GET"),
            ("chat", "POST"),
        ] {
            query("INSERT INTO egress_ledger(at,host,purpose,method,request_bytes,response_bytes) VALUES('2026-09-14T12:00:00Z','carpe-diem.xyz',?,?,20,30)").bind(purpose).bind(method).execute(&pool).await.unwrap();
        }
        let row = query("SELECT request_count,request_bytes FROM account_usage")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("request_count"), 1);
        assert_eq!(row.get::<i64, _>("request_bytes"), 20);
    }
    #[tokio::test]
    async fn encrypted_input_cannot_write_unknown_columns_or_tables() {
        let pool = database().await;
        let s = session_fixture();
        let key = crypto::random_key();
        let id = uuid::Uuid::new_v4().to_string();
        let c = change(
            &s,
            &key,
            &id,
            None,
            json!({"id":id,"title":"x","created_at":"now","updated_at":"now","malicious_column":"x"}),
        );
        let body = verify(&s, &key, &c).unwrap();
        let mut tx = pool.begin().await.unwrap();
        assert!(apply(&mut tx, &c, &body).await.is_err());
    }
}
