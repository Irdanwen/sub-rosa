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
        base: "https://localhost".into(),
        account: Account {
            id: "account-one".into(),
            email: "one@example.test".into(),
            created_at: "now".into(),
        },
        token: Redacted::new("opaque-test-session".into()),
    }
}
#[test]
fn note_merge_keeps_independent_text_edits_and_rejects_overlap() {
    let base = json!({"table":"notes","row":{"id":"note","title":"Title","edited_content":"Alpha\nBeta\nGamma\nDelta\n","updated_at":"2026-09-14T09:00:00Z"},"summary":null});
    let mut local = base.clone();
    local["row"]["edited_content"] = json!("Alpha local\nBeta\nGamma\nDelta\n");
    local["row"]["updated_at"] = json!("2026-09-14T09:01:00Z");
    let mut remote = base.clone();
    remote["row"]["edited_content"] = json!("Alpha\nBeta\nGamma\nDelta remote\n");
    remote["row"]["updated_at"] = json!("2026-09-14T09:02:00Z");
    let merged = merge_note_body(&base, &local, &remote).expect("independent lines merge");
    assert_eq!(
        merged["row"]["edited_content"],
        "Alpha local\nBeta\nGamma\nDelta remote\n"
    );
    remote["row"]["edited_content"] = json!("Alpha remote\nBeta\nGamma\nDelta\n");
    assert!(merge_note_body(&base, &local, &remote).is_none());
}

#[test]
fn note_merge_keeps_independent_fields_but_refuses_competing_titles() {
    let base = json!({"table":"notes","row":{"id":"note","title":"Title","edited_content":"Body\n","updated_at":"2026-09-14T09:00:00Z"},"summary":null});
    let mut local = base.clone();
    local["row"]["title"] = json!("New title");
    let mut remote = base.clone();
    remote["row"]["edited_content"] = json!("New body\n");
    let merged = merge_note_body(&base, &local, &remote).expect("independent fields merge");
    assert_eq!(merged["row"]["title"], "New title");
    assert_eq!(merged["row"]["edited_content"], "New body\n");
    remote["row"]["title"] = json!("Different title");
    assert!(merge_note_body(&base, &local, &remote).is_none());
}

#[test]
fn a_protocol_conflict_or_invalid_server_response_stops_the_run() {
    assert!(isolatable_outbox_error("sync_object_too_large"));
    assert!(isolatable_outbox_error("sync_local_object_invalid"));
    assert!(!isolatable_outbox_error("account_conflict"));
    assert!(!isolatable_outbox_error("sync_format_invalid"));
}
#[tokio::test]
async fn automatic_note_merge_applies_and_journals_a_new_revision() {
    let pool = database().await;
    let s = session_fixture();
    let key = [3; 32];
    let id = uuid::Uuid::new_v4().to_string();
    let base_revision = uuid::Uuid::new_v4().to_string();
    let local_revision = uuid::Uuid::new_v4().to_string();
    let remote_revision = uuid::Uuid::new_v4().to_string();
    let mut conn = pool.acquire().await.unwrap();
    insert_note(&mut conn, &id, "Title").await;
    drop(conn);
    query("UPDATE notes SET edited_content='Alpha\nBeta\nGamma\nDelta\n' WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let snapshot = || async {
        let notes = table("notes").unwrap();
        let row = query(&format!(
            "SELECT {} AS body FROM notes WHERE id=?",
            snapshot_body(notes, "notes.")
        ))
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        serde_json::from_str::<Value>(&row.get::<String, _>("body")).unwrap()
    };
    let base = snapshot().await;
    query("UPDATE notes SET edited_content='Alpha local\nBeta\nGamma\nDelta\n' WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM account_sync_outbox")
        .execute(&pool)
        .await
        .unwrap();
    let local = snapshot().await;
    let mut remote = base.clone();
    remote["row"]["edited_content"] = json!("Alpha\nBeta\nGamma\nDelta remote\n");
    let operation = uuid::Uuid::new_v4().to_string();
    remote["v"] = json!(1);
    remote["operation_id"] = json!(operation);
    remote["parent_revision"] = json!(base_revision);
    remote["resolved_revisions"] = json!([]);
    remote["deleted"] = json!(false);
    let cipher = crypto::seal(
        &key,
        &aad(&s, "note", &id),
        &serde_json::to_vec(&remote).unwrap(),
    )
    .unwrap();
    let base_cipher = crypto::seal(
        &key,
        &aad(&s, "note", &id),
        &serde_json::to_vec(&base).unwrap(),
    )
    .unwrap();
    query("INSERT INTO account_sync_inbox(revision,object_id,kind,ciphertext,deleted,sequence,applied) VALUES(?,?,'note',?,0,1,1)")
            .bind(&base_revision).bind(&id).bind(base_cipher).execute(&pool).await.unwrap();
    query("INSERT INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,deleted,sequence,applied) VALUES(?,?,'note','',?,0,2,1)")
            .bind(&local_revision).bind(&id).bind(&base_revision).execute(&pool).await.unwrap();
    query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,'note')")
        .bind(&id)
        .bind(&local_revision)
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO account_sync_conflicts(id,object_id,kind,ciphertext,parent_revision,operation_id,deleted,created_at) VALUES(?,?,'note',?,?,?,0,'now')")
            .bind(&remote_revision).bind(&id).bind(cipher).bind(&base_revision).bind(&operation).execute(&pool).await.unwrap();
    resolve_in_store(&pool, &s, &key, &remote_revision, "merge")
        .await
        .unwrap();
    let row = query("SELECT edited_content FROM notes WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.get::<String, _>("edited_content"),
        "Alpha local\nBeta\nGamma\nDelta remote\n"
    );
    let outbound = next_outbox(&pool, None).await.unwrap().unwrap();
    let resolved: Vec<String> =
        serde_json::from_str(&outbound.get::<String, _>("resolved_revisions")).unwrap();
    assert_eq!(resolved, vec![remote_revision.clone()]);
    assert_eq!(
        outbound.get::<Option<String>, _>("parent_revision"),
        Some(local_revision)
    );
    assert_eq!(
        query("SELECT resolved FROM account_sync_conflicts WHERE id=?")
            .bind(remote_revision)
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i64, _>("resolved"),
        1
    );
    assert_eq!(
        local["row"]["edited_content"],
        "Alpha local\nBeta\nGamma\nDelta\n"
    );
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
async fn portable_assistant_snapshot_is_journaled_and_applied_without_execution() {
    let pool = database().await;
    let definition = crate::assistants::save(
        &pool,
        crate::assistants::AssistantDefinition {
            name: "Writer".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let task = uuid::Uuid::new_v4().to_string();
    query("INSERT INTO agent_tasks(id,title,prompt,status,safety_profile,created_at,updated_at) VALUES(?,'Writer','Hello','running','custom_assistant','now','now')").bind(&task).execute(&pool).await.unwrap();
    let reference_id = uuid::Uuid::new_v4().to_string();
    let snapshot = json!({"definition":definition,"references":[{"id":reference_id,"assistant_id":definition.id,"name":"Cover","format":"png","text":"","status":"ready","error":null,"note_id":null,"file_name":format!("{reference_id}.png"),"created_at":"now","updated_at":"now"}]});
    query("INSERT INTO assistant_conversations(task_id,assistant_id,snapshot_json,created_at) VALUES(?,?,?,'now')").bind(&task).bind(&definition.id).bind(snapshot.to_string()).execute(&pool).await.unwrap();
    let body: String =
        query("SELECT body FROM account_sync_outbox WHERE object_id=? ORDER BY rowid DESC LIMIT 1")
            .bind(&task)
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("body");
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        body["table"], "assistant_conversations",
        "old clients must reject this unknown codec rather than drop permissions"
    );
    assert_eq!(body["assistant_snapshot"], snapshot);
    let destination = database().await;
    let c = Change {
        sequence: 1,
        resolved_revisions: vec![],
        object_id: task.clone(),
        revision: uuid::Uuid::new_v4().to_string(),
        parent_revision: None,
        kind: "conversation".into(),
        ciphertext: String::new(),
        deleted: false,
        operation_id: Some(uuid::Uuid::new_v4().to_string()),
    };
    let mut tx = destination.begin().await.unwrap();
    assert!(apply(&mut tx, &c, &body).await.unwrap());
    tx.commit().await.unwrap();
    let actual = crate::assistants::runtime::snapshot_for_task(&destination, &task)
        .await
        .unwrap()
        .unwrap();
    assert!(!actual.definition.allow_notes && !actual.definition.allow_memory);
    assert_eq!(actual.definition.name, "Writer");
    let row = query("SELECT status,safety_profile FROM agent_tasks WHERE id=?")
        .bind(task)
        .fetch_one(&destination)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("status"), "completed");
    assert_eq!(row.get::<String, _>("safety_profile"), "custom_assistant");
    // A conversation's images still transfer after deleting its original
    // profile: the snapshot itself owns the authenticated file dependency.
    let manifest_id = uuid::Uuid::new_v4().to_string();
    let manifest = Change {
        object_id: manifest_id.clone(),
        kind: "artifact".into(),
        ..c
    };
    let body = json!({"table":"account_file_manifests","row":{"id":manifest_id,"artifact_id":reference_id,"bytes":10,"format":"png","chunks_json":"[]","created_at":"now","source_kind":"assistant"}});
    let mut tx = destination.begin().await.unwrap();
    assert!(apply(&mut tx, &manifest, &body).await.unwrap());
    tx.commit().await.unwrap();
    assert_eq!(
        query("SELECT count(*) AS n FROM account_sync_outbox")
            .fetch_one(&destination)
            .await
            .unwrap()
            .get::<i64, _>("n"),
        0
    );
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
async fn blocked_outbox_operation_does_not_starve_other_objects_or_reorder_its_own() {
    let pool = database().await;
    let blocked = uuid::Uuid::new_v4().to_string();
    let independent = uuid::Uuid::new_v4().to_string();
    let mut conn = pool.acquire().await.unwrap();
    insert_note(&mut conn, &blocked, "First").await;
    insert_note(&mut conn, &independent, "Second").await;
    drop(conn);
    query("UPDATE notes SET title='First edit' WHERE id=?")
        .bind(&blocked)
        .execute(&pool)
        .await
        .unwrap();
    let first = next_outbox(&pool, None).await.unwrap().unwrap();
    assert_eq!(first.get::<String, _>("object_id"), blocked);
    record_issue(
        &pool,
        "outbox",
        &first.get::<String, _>("operation_id"),
        "sync_object_too_large",
    )
    .await
    .unwrap();
    let next = next_outbox(&pool, None).await.unwrap().unwrap();
    assert_eq!(next.get::<String, _>("object_id"), independent);
    let visible = issues(&pool).await.unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].label.as_deref(), Some("First edit"));
    query("DELETE FROM account_sync_outbox WHERE object_id=?")
        .bind(independent)
        .execute(&pool)
        .await
        .unwrap();
    assert!(next_outbox(&pool, None).await.unwrap().is_none());
}

#[tokio::test]
async fn retry_retires_only_a_never_sent_oversized_snapshot_with_a_newer_edit() {
    let pool = database().await;
    let id = uuid::Uuid::new_v4().to_string();
    let mut conn = pool.acquire().await.unwrap();
    insert_note(&mut conn, &id, "First").await;
    drop(conn);
    let old = next_outbox(&pool, None).await.unwrap().unwrap();
    let operation: String = old.get("operation_id");
    record_issue(&pool, "outbox", &operation, "sync_object_too_large")
        .await
        .unwrap();
    query("UPDATE notes SET title='Revised' WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    retry_issues(&pool).await.unwrap();
    assert!(issues(&pool).await.unwrap().is_empty());
    let next = next_outbox(&pool, None).await.unwrap().unwrap();
    assert_ne!(next.get::<String, _>("operation_id"), operation);
    assert_eq!(next.get::<String, _>("object_id"), id);
    assert_eq!(
        query("SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i64, _>("n"),
        1
    );
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
    // The newer snapshot supersedes the unsent one: the edit is retained, once.
    let r = query("SELECT body FROM account_sync_outbox")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(r.len(), 1);
    assert!(r[0]
        .get::<String, _>("body")
        .contains("Changed while offline"));
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
    let encrypted: String = query("SELECT ciphertext FROM account_sync_outbox WHERE object_id=?")
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

async fn outbox_rows(pool: &SqlitePool, id: &str) -> Vec<sqlx_sqlite::SqliteRow> {
    query("SELECT * FROM account_sync_outbox WHERE object_id=? ORDER BY sequence")
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_local_only_or_empty_update_sends_nothing() {
    let pool = database().await;
    let id = uuid::Uuid::new_v4().to_string();
    query("INSERT INTO memories(id,text,created_at,updated_at) VALUES(?,'Likes tea','2026-07-01','2026-07-01')")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM account_sync_outbox")
        .execute(&pool)
        .await
        .unwrap();
    // The embedding backfill: a column that never travels.
    query("UPDATE memories SET embedding=x'00000000' WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE memories SET text=text WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(outbox_rows(&pool, &id).await.is_empty());
    query("UPDATE memories SET text='Likes green tea' WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let rows = outbox_rows(&pool, &id).await;
    assert_eq!(rows.len(), 1);
    assert!(rows[0].get::<String, _>("body").contains("Likes green tea"));
}

#[tokio::test]
async fn checkpoints_leave_one_unsent_snapshot_but_never_drop_a_sealed_one() {
    let pool = database().await;
    let id = uuid::Uuid::new_v4().to_string();
    let mut conn = pool.acquire().await.unwrap();
    insert_note(&mut conn, &id, "Draft").await;
    drop(conn);
    for n in 0..10 {
        query("UPDATE notes SET title=? WHERE id=?")
            .bind(format!("Draft {n}"))
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
    }
    let rows = outbox_rows(&pool, &id).await;
    assert_eq!(rows.len(), 1);
    assert!(rows[0].get::<String, _>("body").contains("Draft 9"));
    // Sealed: it may already be on the server under its operation id.
    query("UPDATE account_sync_outbox SET ciphertext='sealed' WHERE object_id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    // A resolution names the siblings someone acknowledged.
    query("UPDATE notes SET title='Resolved' WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE account_sync_outbox SET resolved_revisions='[\"sibling\"]' WHERE object_id=? AND ciphertext IS NULL")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE notes SET title='After' WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let rows = outbox_rows(&pool, &id).await;
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows[0].get::<Option<String>, _>("ciphertext").as_deref(),
        Some("sealed")
    );
    assert_eq!(
        rows[1].get::<String, _>("resolved_revisions"),
        "[\"sibling\"]"
    );
    assert!(rows[2].get::<String, _>("body").contains("After"));
}

#[tokio::test]
async fn outbox_compaction_keeps_the_last_unsent_snapshot_per_object() {
    let pool = database().await;
    let insert = |sequence: i64, object: &'static str, sealed: bool, resolved: &'static str| {
        let pool = pool.clone();
        async move {
            query("INSERT INTO account_sync_outbox(sequence,operation_id,object_id,kind,body,ciphertext,resolved_revisions) VALUES(?,?,?,'artifact','{}',?,?)")
                .bind(sequence)
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(object)
                .bind(sealed.then_some("sealed"))
                .bind(resolved)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    insert(1, "a", true, "[]").await;
    insert(2, "a", false, "[]").await;
    insert(3, "a", false, "[\"r\"]").await;
    insert(4, "a", false, "[]").await;
    insert(5, "a", false, "[]").await;
    insert(6, "b", false, "[]").await;
    for statement in include_str!("../../migrations/036_outbox_compaction.sql")
        .split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
    {
        query(statement).execute(&pool).await.unwrap();
    }
    let left: Vec<i64> = query("SELECT sequence FROM account_sync_outbox ORDER BY sequence")
        .fetch_all(&pool)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get("sequence"))
        .collect();
    assert_eq!(left, vec![1, 3, 5, 6]);
}

#[tokio::test]
async fn an_identical_sibling_resolves_itself_and_a_different_one_waits() {
    let pool = database().await;
    let s = session_fixture();
    let key = [5; 32];
    let base_revision = uuid::Uuid::new_v4().to_string();
    let mut revisions = Vec::new();
    for title in ["Same", "Different"] {
        let id = uuid::Uuid::new_v4().to_string();
        let mut conn = pool.acquire().await.unwrap();
        insert_note(&mut conn, &id, title).await;
        drop(conn);
        let notes = table("notes").unwrap();
        let body = query(&format!(
            "SELECT {} AS body FROM notes WHERE id=?",
            snapshot_body(notes, "notes.")
        ))
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut remote: Value = serde_json::from_str(&body.get::<String, _>("body")).unwrap();
        if title == "Different" {
            remote["row"]["title"] = json!("Edited elsewhere");
        }
        let operation = uuid::Uuid::new_v4().to_string();
        remote["v"] = json!(1);
        remote["operation_id"] = json!(operation);
        remote["parent_revision"] = json!(base_revision);
        remote["resolved_revisions"] = json!([]);
        remote["deleted"] = json!(false);
        let cipher = crypto::seal(
            &key,
            &aad(&s, "note", &id),
            &serde_json::to_vec(&remote).unwrap(),
        )
        .unwrap();
        let local_revision = uuid::Uuid::new_v4().to_string();
        query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,'note')")
            .bind(&id)
            .bind(&local_revision)
            .execute(&pool)
            .await
            .unwrap();
        let remote_revision = uuid::Uuid::new_v4().to_string();
        query("INSERT INTO account_sync_conflicts(id,object_id,kind,ciphertext,parent_revision,operation_id,deleted,created_at) VALUES(?,?,'note',?,?,?,0,'now')")
            .bind(&remote_revision).bind(&id).bind(cipher).bind(&base_revision).bind(&operation).execute(&pool).await.unwrap();
        revisions.push(remote_revision);
    }
    query("DELETE FROM account_sync_outbox")
        .execute(&pool)
        .await
        .unwrap();
    auto_resolve_identical_conflicts(&pool, &s, &key).await;
    let resolved = |id: String| {
        let pool = pool.clone();
        async move {
            query("SELECT resolved FROM account_sync_conflicts WHERE id=?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .get::<i64, _>("resolved")
        }
    };
    assert_eq!(resolved(revisions[0].clone()).await, 1);
    assert_eq!(resolved(revisions[1].clone()).await, 0);
    // The acknowledgement travels, so the other devices converge too.
    let outbound = next_outbox(&pool, None).await.unwrap().unwrap();
    let acknowledged: Vec<String> =
        serde_json::from_str(&outbound.get::<String, _>("resolved_revisions")).unwrap();
    assert_eq!(acknowledged, vec![revisions[0].clone()]);
}

// --- Remote deletions (ADR-0072) -------------------------------------------

/// A tombstone sealed the way another device seals its own delete: the
/// snapshot of the row it removed, with `deleted` set.
fn tombstone(
    s: &Session,
    key: &[u8; 32],
    table_name: &str,
    kind: &str,
    id: &str,
    parent: Option<String>,
    row: Value,
) -> Change {
    let op = uuid::Uuid::new_v4().to_string();
    let body = json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":true,"table":table_name,"row":row});
    Change {
        sequence: 1,
        resolved_revisions: Vec::new(),
        object_id: id.into(),
        revision: uuid::Uuid::now_v7().to_string(),
        parent_revision: parent,
        kind: kind.into(),
        ciphertext: crypto::seal(key, &aad(s, kind, id), &serde_json::to_vec(&body).unwrap())
            .unwrap(),
        deleted: true,
        operation_id: Some(op),
    }
}
async fn set_head(pool: &SqlitePool, id: &str, revision: &str, kind: &str) {
    query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision")
        .bind(id).bind(revision).bind(kind).execute(pool).await.unwrap();
}
async fn count(pool: &SqlitePool, sql: &str, id: &str) -> i64 {
    query(sql)
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
        .get::<i64, _>("n")
}
async fn insert_note_with_recording(pool: &SqlitePool, id: &str) -> (String, String) {
    let mut conn = pool.acquire().await.unwrap();
    insert_note(&mut conn, id, "Deleted elsewhere").await;
    drop(conn);
    let session = uuid::Uuid::new_v4().to_string();
    let artifact = uuid::Uuid::new_v4().to_string();
    query("INSERT INTO recording_sessions(id,note_id,status,started_at) VALUES(?,?,'completed','now')")
        .bind(&session).bind(id).execute(pool).await.unwrap();
    query("INSERT INTO audio_artifacts(id,note_id,recording_session_id,path,format,duration_ms,size_bytes,checksum,created_at) VALUES(?,?,?,'synced/take.audio','wav',1000,10,'sum','now')")
        .bind(&artifact).bind(id).bind(&session).execute(pool).await.unwrap();
    query("INSERT INTO transcripts(id,note_id,audio_artifact_id,text,provider,status,created_at,updated_at) VALUES(?,?,?,'Words','test','completed','now','now')")
        .bind(uuid::Uuid::new_v4().to_string()).bind(id).bind(&artifact).execute(pool).await.unwrap();
    query("DELETE FROM account_sync_outbox")
        .execute(pool)
        .await
        .unwrap();
    (session, artifact)
}
#[tokio::test]
async fn a_clean_remote_deletion_removes_the_note_and_its_children_without_a_card() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let (_session, artifact) = insert_note_with_recording(&pool, &id).await;
    let head = uuid::Uuid::now_v7().to_string();
    set_head(&pool, &id, &head, "note").await;
    set_head(
        &pool,
        &artifact,
        &uuid::Uuid::now_v7().to_string(),
        "artifact",
    )
    .await;
    let c = tombstone(&s, &key, "notes", "note", &id, Some(head), json!({"id":id}));
    let mut tx = pool.begin().await.unwrap();
    assert!(apply(&mut tx, &c, &verify(&s, &key, &c).unwrap())
        .await
        .unwrap());
    head_and_applied(&mut tx, &c).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) AS n FROM notes WHERE id=?", &id).await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM transcripts WHERE note_id=?",
            &id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM audio_artifacts WHERE note_id=?",
            &id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=?",
            &id
        )
        .await,
        0
    );
    // The apply ran under `applying=1`: nothing echoes back to the service.
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?",
            &id
        )
        .await,
        0
    );
    // The recording file is left for the lane that knows the directories.
    assert_eq!(count(&pool, "SELECT count(*) AS n FROM account_sync_removed_files WHERE lane='recording' AND path=?", "synced/take.audio").await, 1);
    let head: String = query("SELECT revision FROM account_sync_heads WHERE object_id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("revision");
    assert_eq!(head, c.revision);
}
#[tokio::test]
async fn a_remote_deletion_over_a_child_revised_since_is_kept_for_review() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let (_session, artifact) = insert_note_with_recording(&pool, &id).await;
    let head = uuid::Uuid::now_v7().to_string();
    set_head(&pool, &id, &head, "note").await;
    let c = tombstone(&s, &key, "notes", "note", &id, Some(head), json!({"id":id}));
    // A third device revised the recording after the deletion was decided.
    set_head(
        &pool,
        &artifact,
        &uuid::Uuid::now_v7().to_string(),
        "artifact",
    )
    .await;
    let mut tx = pool.begin().await.unwrap();
    assert!(apply(&mut tx, &c, &verify(&s, &key, &c).unwrap())
        .await
        .unwrap());
    tx.commit().await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) AS n FROM notes WHERE id=?", &id).await,
        1
    );
    assert_eq!(count(&pool, "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=? AND deleted=1 AND resolved=0", &id).await, 1);
}
#[tokio::test]
async fn a_remote_deletion_over_an_unsent_child_edit_is_kept_for_review() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let _ = insert_note_with_recording(&pool, &id).await;
    let head = uuid::Uuid::now_v7().to_string();
    set_head(&pool, &id, &head, "note").await;
    // Editing the transcript here queues it; the sync triggers are live.
    query("UPDATE transcripts SET text='Corrected here' WHERE note_id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let c = tombstone(&s, &key, "notes", "note", &id, Some(head), json!({"id":id}));
    let mut tx = pool.begin().await.unwrap();
    assert!(apply(&mut tx, &c, &verify(&s, &key, &c).unwrap())
        .await
        .unwrap());
    tx.commit().await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) AS n FROM notes WHERE id=?", &id).await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=? AND deleted=1",
            &id
        )
        .await,
        1
    );
}
#[tokio::test]
async fn a_tombstone_for_an_object_this_device_never_held_leaves_no_card() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let c = tombstone(&s, &key, "memories", "memory", &id, None, json!({"id":id}));
    let mut tx = pool.begin().await.unwrap();
    assert!(apply(&mut tx, &c, &verify(&s, &key, &c).unwrap())
        .await
        .unwrap());
    head_and_applied(&mut tx, &c).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=?",
            &id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_heads WHERE object_id=?",
            &id
        )
        .await,
        1
    );
}
#[tokio::test]
async fn a_tombstone_for_a_transcript_whose_note_is_already_gone_still_applies() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let note = uuid::Uuid::new_v4().to_string();
    let c = tombstone(
        &s,
        &key,
        "transcripts",
        "transcript",
        &id,
        None,
        json!({"id":id,"note_id":note}),
    );
    let mut tx = pool.begin().await.unwrap();
    // Before, the missing parent note parked this row in the inbox forever.
    assert!(apply(&mut tx, &c, &verify(&s, &key, &c).unwrap())
        .await
        .unwrap());
    tx.commit().await.unwrap();
}
/// A card for a deletion whose tombstone is already this device's head: the
/// shape every card took before ADR-0072, and the shape a full replay after a
/// reconnection leaves behind (upsert, then tombstone, both applied).
async fn card_with_tombstone_as_head(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    id: &str,
) -> Change {
    let mut conn = pool.acquire().await.unwrap();
    insert_note(&mut conn, id, "Resurrected by a replay").await;
    drop(conn);
    query("DELETE FROM account_sync_outbox")
        .execute(pool)
        .await
        .unwrap();
    let parent = uuid::Uuid::now_v7().to_string();
    let c = tombstone(s, key, "notes", "note", id, Some(parent), json!({"id":id}));
    let mut tx = pool.begin().await.unwrap();
    preserve(&mut tx, &c).await.unwrap();
    head_and_applied(&mut tx, &c).await.unwrap();
    tx.commit().await.unwrap();
    c
}
#[tokio::test]
async fn accepting_a_deletion_whose_tombstone_is_head_removes_locally_and_sends_nothing() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let c = card_with_tombstone_as_head(&pool, &s, &key, &id).await;
    resolve_in_store(&pool, &s, &key, &c.revision, "use_remote")
        .await
        .unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) AS n FROM notes WHERE id=?", &id).await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=? AND resolved=0",
            &id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?",
            &id
        )
        .await,
        0
    );
}
#[tokio::test]
async fn keeping_a_local_version_that_no_longer_exists_sends_nothing_either() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let c = card_with_tombstone_as_head(&pool, &s, &key, &id).await;
    query("UPDATE account_sync_control SET applying=1 WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM notes WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE account_sync_control SET applying=0 WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    resolve_in_store(&pool, &s, &key, &c.revision, "keep_local")
        .await
        .unwrap();
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=? AND resolved=0",
            &id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?",
            &id
        )
        .await,
        0
    );
}
#[tokio::test]
async fn keeping_a_local_version_that_exists_still_restores_it_everywhere() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let id = uuid::Uuid::new_v4().to_string();
    let c = card_with_tombstone_as_head(&pool, &s, &key, &id).await;
    resolve_in_store(&pool, &s, &key, &c.revision, "keep_local")
        .await
        .unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) AS n FROM notes WHERE id=?", &id).await,
        1
    );
    let outbound = next_outbox(&pool, None).await.unwrap().unwrap();
    assert_eq!(outbound.get::<i64, _>("deleted"), 0);
    assert_eq!(
        outbound.get::<Option<String>, _>("parent_revision"),
        Some(c.revision)
    );
}
#[tokio::test]
async fn settling_clean_deletion_cards_removes_rows_and_sends_nothing() {
    let pool = database().await;
    let s = session_fixture();
    let key = crypto::random_key();
    let clean = uuid::Uuid::new_v4().to_string();
    let divergent = uuid::Uuid::new_v4().to_string();
    let _ = card_with_tombstone_as_head(&pool, &s, &key, &clean).await;
    let c = card_with_tombstone_as_head(&pool, &s, &key, &divergent).await;
    // A live local head is a real disagreement, and stays for a person.
    set_head(&pool, &divergent, &uuid::Uuid::now_v7().to_string(), "note").await;
    settle_clean_deletions(&pool, &s, &key).await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) AS n FROM notes WHERE id=?", &clean).await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=? AND resolved=0",
            &clean
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM notes WHERE id=?",
            &divergent
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=? AND resolved=0",
            &divergent
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?",
            &c.object_id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?",
            &clean
        )
        .await,
        0
    );
}
#[tokio::test]
async fn a_chunk_the_service_would_not_serve_steps_aside_and_comes_back_later() {
    let pool = database().await;
    assert!(isolatable_file_error("sync_storage_limited"));
    assert!(isolatable_file_error("sync_blob_missing"));
    assert!(isolatable_file_error("account_network"));
    assert!(!isolatable_file_error("vault_locked"));
    let manifest = uuid::Uuid::new_v4().to_string();
    record_issue(&pool, "download", &manifest, "sync_storage_limited")
        .await
        .unwrap();
    query("INSERT INTO account_file_manifests(id,artifact_id,bytes,format,chunks_json,created_at) VALUES(?,?,1,'wav','[]','now')")
        .bind(&manifest).bind(uuid::Uuid::new_v4().to_string()).execute(&pool).await.unwrap();
    reconcile_issues(&pool).await.unwrap();
    assert_eq!(issue_count(&pool).await.unwrap(), 1);
    query("UPDATE account_sync_issues SET created_at=? WHERE item_id=?")
        .bind((chrono::Utc::now() - chrono::Duration::minutes(11)).to_rfc3339())
        .bind(&manifest)
        .execute(&pool)
        .await
        .unwrap();
    reconcile_issues(&pool).await.unwrap();
    assert_eq!(issue_count(&pool).await.unwrap(), 0);
}
