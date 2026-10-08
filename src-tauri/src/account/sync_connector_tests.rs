//! A connector's definition travels under a UUID derived from its id, since
//! the service refuses any other object id, while its row keeps the catalog
//! name its tokens and tools are filed under (ADR-0092 addendum).
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

fn connector(id: &str) -> crate::connectors::Connector {
    crate::connectors::Connector {
        id: id.into(),
        name: "Sentry".into(),
        url: "https://mcp.sentry.dev/mcp".into(),
        catalog_id: id.into(),
        auth: "oauth".into(),
        enabled: true,
        tool_policy: Default::default(),
    }
}

fn row(id: &str) -> Value {
    json!({"id":id,"name":"GitHub","url":"https://api.githubcopilot.com/mcp/","catalog_id":id,"auth":"github","enabled":1,"tool_policy":"{\"create_issue\":\"ask\"}","created_at":"2026-10-08T09:00:00.000Z","updated_at":"2026-10-08T09:00:00.000Z"})
}

fn received(key: &[u8; 32], object: &str, deleted: bool, row: Value) -> Change {
    let s = session();
    let op = uuid::Uuid::new_v4().to_string();
    let body = json!({"v":1,"operation_id":op,"parent_revision":null,"deleted":deleted,"resolved_revisions":[],"table":"connectors","row":row});
    Change {
        sequence: 1,
        resolved_revisions: Vec::new(),
        object_id: object.into(),
        revision: uuid::Uuid::now_v7().to_string(),
        parent_revision: None,
        kind: "settings".into(),
        ciphertext: crypto::seal(
            key,
            &aad(&s, "settings", object),
            &serde_json::to_vec(&body).unwrap(),
        )
        .unwrap(),
        deleted,
        operation_id: Some(op),
    }
}

async fn queued(pool: &SqlitePool) -> Vec<(String, Value)> {
    query("SELECT object_id, body FROM account_sync_outbox ORDER BY sequence")
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|r| {
            (
                r.get::<String, _>("object_id"),
                serde_json::from_str(&r.get::<String, _>("body")).unwrap(),
            )
        })
        .collect()
}

#[test]
fn the_object_id_is_a_name_based_uuid_every_shell_derives_alike() {
    // The same vectors are asserted by the web client's test
    // (`src/test/website-connector-sync.test.ts`).
    assert_eq!(
        crate::connectors::object_id("sentry"),
        "30d6d457-5215-5277-8982-cdf85fe0357b"
    );
    assert_eq!(
        crate::connectors::object_id("github"),
        "e102780d-6272-5361-a478-76b2594a99b2"
    );
    assert_eq!(
        crate::connectors::object_id("my_server-a1b2c3"),
        "8f16ae94-67db-5fcb-8c30-3b9e91299e73"
    );
}

#[tokio::test]
async fn an_added_connector_leaves_under_its_uuid_and_keeps_its_id() {
    let pool = database().await;
    crate::connectors::insert(&pool, &connector("sentry"))
        .await
        .unwrap();
    query("UPDATE connectors SET enabled=0 WHERE id='sentry'")
        .execute(&pool)
        .await
        .unwrap();
    let rows = queued(&pool).await;
    assert_eq!(rows.len(), 1, "an edit rewrites the unsent snapshot");
    let (object, body) = &rows[0];
    assert!(uuid::Uuid::parse_str(object).is_ok());
    assert_eq!(object, &crate::connectors::object_id("sentry"));
    assert_eq!(body["table"], "connectors");
    assert_eq!(body["row"]["id"], "sentry");
    assert_eq!(body["row"]["enabled"], 0);
    assert!(
        body["row"].get("object_id").is_none(),
        "the object id never travels as a column"
    );

    crate::connectors::remove_rows(&pool, "sentry")
        .await
        .unwrap();
    let rows = queued(&pool).await;
    let (object, body) = rows.last().unwrap();
    assert_eq!(object, &crate::connectors::object_id("sentry"));
    assert_eq!(body["row"]["id"], "sentry");
}

#[tokio::test]
async fn a_received_connector_is_filed_under_its_id_and_an_edit_returns_to_its_object() {
    let pool = database().await;
    let key = [7u8; 32];
    let object = crate::connectors::object_id("github");
    let c = received(&key, &object, false, row("github"));
    let body = verify(&session(), &key, &c).expect("a connector authenticates");
    let mut tx = pool.begin().await.unwrap();
    assert!(apply(&mut tx, &c, &body).await.unwrap());
    tx.commit().await.unwrap();
    let stored = query("SELECT object_id, tool_policy FROM connectors WHERE id='github'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored.get::<String, _>("object_id"), object);
    assert_eq!(
        stored.get::<String, _>("tool_policy"),
        "{\"create_issue\":\"ask\"}"
    );
    assert!(queued(&pool).await.is_empty(), "applying echoes nothing");

    query("UPDATE connectors SET enabled=0 WHERE id='github'")
        .execute(&pool)
        .await
        .unwrap();
    let rows = queued(&pool).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, object);

    let connector = crate::connectors::get(&pool, "github").await.unwrap();
    assert!(!connector.enabled);
}

#[tokio::test]
async fn a_connector_under_any_other_object_is_refused() {
    let key = [7u8; 32];
    for object in [
        uuid::Uuid::new_v4().to_string(),
        crate::connectors::object_id("sentry"),
    ] {
        let c = received(&key, &object, false, row("github"));
        assert!(verify(&session(), &key, &c).is_err(), "{object}");
    }
}

#[tokio::test]
async fn a_remote_deletion_removes_the_connector_by_its_object() {
    let pool = database().await;
    let key = [7u8; 32];
    let object = crate::connectors::object_id("github");
    let mut tx = pool.begin().await.unwrap();
    let c = received(&key, &object, false, row("github"));
    let body = verify(&session(), &key, &c).unwrap();
    assert!(apply(&mut tx, &c, &body).await.unwrap());
    tx.commit().await.unwrap();
    crate::connectors::set_status(&pool, "github", "connected", None).await;

    let c = received(&key, &object, true, row("github"));
    let body = verify(&session(), &key, &c).unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert!(apply(&mut tx, &c, &body).await.unwrap());
    tx.commit().await.unwrap();
    for sql in [
        "SELECT count(*) AS n FROM connectors",
        "SELECT count(*) AS n FROM connector_state",
    ] {
        let n: i64 = query(sql).fetch_one(&pool).await.unwrap().get("n");
        assert_eq!(n, 0, "{sql}");
    }
    assert!(queued(&pool).await.is_empty());
}

#[tokio::test]
async fn what_was_queued_under_the_old_id_is_queued_again_under_the_uuid() {
    let pool = database().await;
    // A row from before migration 075, and the refused snapshot it queued.
    query("INSERT INTO connectors(id,name,url,catalog_id,auth,enabled,tool_policy,created_at,updated_at) VALUES('sentry','Sentry','https://mcp.sentry.dev/mcp','sentry','oauth',1,'{}','t','t')")
        .execute(&pool)
        .await
        .unwrap();
    assert!(queued(&pool).await.is_empty(), "an unnamed row waits");
    query("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) VALUES('op-old','sentry','settings','{\"table\":\"connectors\",\"row\":{\"id\":\"sentry\"}}',0)")
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted) VALUES('op-gone','linear','settings','{\"table\":\"connectors\",\"row\":{\"id\":\"linear\"}}',1)")
        .execute(&pool)
        .await
        .unwrap();
    record_issue(&pool, "outbox", "op-old", "sync_format_invalid")
        .await
        .unwrap();

    // The migration's clean-up, then what the app does as it opens.
    for statement in crate::db::migrations::split_sql_statements(include_str!(
        "../../migrations/075_connector_object_ids.sql"
    )) {
        if statement.trim_start().starts_with("DELETE") {
            query(&statement).execute(&pool).await.unwrap();
        }
    }
    assert_eq!(
        crate::connectors::assign_object_ids(&pool).await.unwrap(),
        1
    );
    enqueue_existing(&pool, "connectors", "1").await.unwrap();

    let rows = queued(&pool).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, crate::connectors::object_id("sentry"));
    assert_eq!(rows[0].1["row"]["id"], "sentry");
    let issues: i64 = query("SELECT count(*) AS n FROM account_sync_issues")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
    assert_eq!(issues, 0);
    assert_eq!(
        crate::connectors::assign_object_ids(&pool).await.unwrap(),
        0
    );
}

#[tokio::test]
async fn connectors_a_browser_wrote_apply_here_under_their_ids() {
    // Written by the web client's own writer
    // (`src/test/website-connector-sync.test.ts`, `SUBROSA_WRITE_WEB_FIXTURE=1`).
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/web-client-connectors-v1.json"
    ))
    .unwrap();
    let pool = database().await;
    let mut s = session();
    s.account.id = fixture["account"].as_str().unwrap().to_string();
    let key = crypto::decode_key(fixture["key"].as_str().unwrap()).unwrap();
    let mut tx = pool.begin().await.unwrap();
    for raw in fixture["changes"].as_array().unwrap() {
        let mut raw = raw.clone();
        raw.as_object_mut().unwrap().remove("device_id");
        let c: Change = serde_json::from_value(raw).unwrap();
        let body = verify(&s, &key, &c).expect("a browser's connector authenticates");
        assert!(apply(&mut tx, &c, &body).await.unwrap());
    }
    tx.commit().await.unwrap();
    let rows = query("SELECT id, object_id, tool_policy FROM connectors ORDER BY created_at")
        .fetch_all(&pool)
        .await
        .unwrap();
    let ids: Vec<String> = rows.iter().map(|r| r.get("id")).collect();
    assert_eq!(ids, ["sentry", "team_wiki-a1b2c3"]);
    for row in &rows {
        assert_eq!(
            row.get::<String, _>("object_id"),
            crate::connectors::object_id(&row.get::<String, _>("id"))
        );
    }
    let sentry = crate::connectors::get(&pool, "sentry").await.unwrap();
    assert_eq!(
        sentry.tool_policy.get("search_issues").map(String::as_str),
        Some("deny")
    );
}
