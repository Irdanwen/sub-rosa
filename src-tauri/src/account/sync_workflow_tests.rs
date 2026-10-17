//! The Studio's workflows travel as definitions (ADR-0118): their graph, name
//! and origin, never the card picture this device chose for them, and never
//! what ran.
use super::*;
use crate::studio_workflows::SaveWorkflowRequest;
use sqlx_sqlite::SqlitePoolOptions;

const ID: &str = "6f1c2a52-8d0e-4f52-9b5e-0f3a4c1d2e7b";

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

fn session() -> Session {
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

fn request(id: &str, name: &str, updated_at: i64) -> SaveWorkflowRequest {
    SaveWorkflowRequest {
        id: id.into(),
        name: name.into(),
        description: None,
        definition: format!(
            r#"{{"nodes":[{{"id":"n","type":"textInput"}}],"edges":[],"name":"{name}"}}"#
        ),
        format_version: Some(2),
        origin: None,
        created_at: Some(1),
        updated_at: Some(updated_at),
    }
}

async fn outbox(pool: &SqlitePool, id: &str) -> Vec<Value> {
    query("SELECT body FROM account_sync_outbox WHERE object_id=? ORDER BY sequence")
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|row| serde_json::from_str(&row.get::<String, _>("body")).unwrap())
        .collect()
}

fn received(key: &[u8; 32], deleted: bool, row: Value, parent: Option<String>) -> Change {
    let s = session();
    let op = uuid::Uuid::new_v4().to_string();
    let body = json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":deleted,"resolved_revisions":[],"table":"studio_workflows","row":row});
    Change {
        sequence: 1,
        resolved_revisions: Vec::new(),
        object_id: ID.into(),
        revision: uuid::Uuid::now_v7().to_string(),
        parent_revision: parent,
        kind: "settings".into(),
        ciphertext: crypto::seal(
            key,
            &aad(&s, "settings", ID),
            &serde_json::to_vec(&body).unwrap(),
        )
        .unwrap(),
        deleted,
        operation_id: Some(op),
    }
}

fn remote_row(name: &str, definition: &str) -> Value {
    json!({"id":ID,"name":name,"description":null,"definition":definition,"format_version":2,"origin":"block","created_at":1,"updated_at":50})
}

async fn apply_received(pool: &SqlitePool, c: &Change) -> Result<bool, AppError> {
    let body = verify(&session(), &KEY, c).unwrap();
    let mut tx = pool.begin().await.unwrap();
    let applied = apply(&mut tx, c, &body).await;
    tx.commit().await.unwrap();
    applied
}

const KEY: [u8; 32] = [7; 32];

#[tokio::test]
async fn a_workflow_leaves_as_one_definition_however_often_it_is_saved() {
    let pool = database().await;
    // The editor saves a moment after each change: a drag is many saves.
    for at in 10..20 {
        crate::studio_workflows::save(&pool, request(ID, &format!("Take {at}"), at))
            .await
            .unwrap();
    }
    let rows = outbox(&pool, ID).await;
    assert_eq!(rows.len(), 1, "unsent saves fold into one snapshot");
    assert_eq!(rows[0]["table"], "studio_workflows");
    assert_eq!(rows[0]["row"]["name"], "Take 19");
    assert_eq!(rows[0]["row"]["format_version"], 2);
    assert!(rows[0]["row"].get("cover_artifact_id").is_none());
    // Choosing the card's picture is this device's business.
    query("DELETE FROM account_sync_outbox")
        .execute(&pool)
        .await
        .unwrap();
    crate::studio_workflows::set_cover(&pool, ID, Some("cover.png"))
        .await
        .unwrap();
    assert!(outbox(&pool, ID).await.is_empty());
    crate::studio_workflows::delete(&pool, ID).await.unwrap();
    let rows = outbox(&pool, ID).await;
    assert_eq!(rows.len(), 1);
    let deleted: bool = query("SELECT deleted FROM account_sync_outbox WHERE object_id=?")
        .bind(ID)
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("deleted");
    assert!(deleted);
}

#[tokio::test]
async fn a_workflow_not_named_by_a_uuid_stays_on_the_device() {
    let pool = database().await;
    for id in ["compiled-my-film", "6F1C2A52-8D0E-4F52-9B5E-0F3A4C1D2E7B"] {
        crate::studio_workflows::save(&pool, request(id, "Local", 1))
            .await
            .unwrap();
        assert!(outbox(&pool, id).await.is_empty(), "{id}");
    }
}

#[tokio::test]
async fn a_workflow_from_another_device_arrives_without_echo_keeps_the_local_cover_and_leaves_with_its_tombstone(
) {
    let pool = database().await;
    crate::studio_workflows::save(&pool, request(ID, "Mine", 10))
        .await
        .unwrap();
    crate::studio_workflows::set_cover(&pool, ID, Some("cover.png"))
        .await
        .unwrap();
    query("DELETE FROM account_sync_outbox")
        .execute(&pool)
        .await
        .unwrap();
    let row = remote_row("  From the laptop ", r#"{"nodes":[],"edges":[],"app":{}}"#);
    let arrival = received(&KEY, false, row.clone(), None);
    assert!(apply_received(&pool, &arrival).await.unwrap());
    let stored = crate::studio_workflows::list(&pool).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].name, "From the laptop");
    assert_eq!(stored[0].origin, "block");
    assert_eq!(stored[0].cover_artifact_id.as_deref(), Some("cover.png"));
    assert!(stored[0].definition.contains("\"app\""));
    assert!(
        outbox(&pool, ID).await.is_empty(),
        "an arrival is not echoed"
    );

    query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,'settings')")
        .bind(ID)
        .bind(&arrival.revision)
        .execute(&pool)
        .await
        .unwrap();
    let removal = received(&KEY, true, row, Some(arrival.revision.clone()));
    assert!(apply_received(&pool, &removal).await.unwrap());
    assert!(crate::studio_workflows::list(&pool)
        .await
        .unwrap()
        .is_empty());
    assert!(outbox(&pool, ID).await.is_empty());
}

#[tokio::test]
async fn a_received_graph_this_device_could_not_open_is_refused() {
    let pool = database().await;
    let arrival = received(&KEY, false, remote_row("Broken", "[1,2]"), None);
    let refused = apply_received(&pool, &arrival).await.unwrap_err();
    assert_eq!(refused.code, "sync_format_invalid");
    assert!(crate::studio_workflows::list(&pool)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn workflows_drawn_before_the_account_was_bound_leave_when_sync_turns_on() {
    let pool = database().await;
    query("UPDATE account_sync_control SET account_id=NULL WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    crate::studio_workflows::save(&pool, request(ID, "Older", 1))
        .await
        .unwrap();
    assert!(outbox(&pool, ID).await.is_empty());
    query("UPDATE account_sync_control SET account_id='account-one' WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    // An account that took its first inventory before workflows travelled.
    query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES('earlier','r','note')")
        .execute(&pool)
        .await
        .unwrap();
    set_enabled(&pool, true).await.unwrap();
    assert_eq!(outbox(&pool, ID).await.len(), 1);
    set_enabled(&pool, true).await.unwrap();
    assert_eq!(outbox(&pool, ID).await.len(), 1, "never queued twice");
}
