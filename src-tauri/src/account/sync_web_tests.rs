//! What a browser device writes for WP20 (projects, custom assistants, saved
//! items, gallery files) must apply here as ordinary rows. The fixture is
//! written by the web client's own writer (`src/test/website-sync-wp20.test.ts`,
//! `SUBROSA_WRITE_WEB_FIXTURE=1`), sealed with WebCrypto, and passes this
//! device's authentication and codec before it lands.
use super::*;
use sqlx_sqlite::SqlitePoolOptions;

async fn database() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

#[tokio::test]
async fn a_browsers_projects_assistants_and_library_apply_as_ordinary_rows() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/web-client-objects-v2.json"
    ))
    .unwrap();
    let pool = database().await;
    let s = Session {
        base: "https://localhost".into(),
        account: Account {
            id: fixture["account"].as_str().unwrap().to_string(),
            email: "one@example.test".into(),
            created_at: "now".into(),
        },
        token: Redacted::new("opaque-test-session".into()),
    };
    let key = crypto::decode_key(fixture["key"].as_str().unwrap()).unwrap();
    let mut tx = pool.begin().await.unwrap();
    for raw in fixture["changes"].as_array().unwrap() {
        let mut raw = raw.clone();
        raw.as_object_mut().unwrap().remove("device_id");
        let c: Change = serde_json::from_value(raw).unwrap();
        let body = verify(&s, &key, &c).expect("a browser's revision authenticates");
        assert!(
            apply(&mut tx, &c, &body).await.unwrap(),
            "{} {}",
            c.kind,
            body["table"]
        );
    }
    tx.commit().await.unwrap();

    // A project: its folder and its settings are one object, two rows.
    let folder: String = query("SELECT id FROM folders WHERE name='Garden'")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("id");
    let settings = query("SELECT instructions, memory_mode FROM project_settings WHERE id=?")
        .bind(&folder)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        settings.get::<String, _>("instructions"),
        "Answer as a gardener."
    );
    assert_eq!(settings.get::<String, _>("memory_mode"), "project");
    let file = query("SELECT name, status, text FROM project_files WHERE folder_id=?")
        .bind(&folder)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(file.get::<String, _>("status"), "ready");
    assert_eq!(file.get::<String, _>("text"), "Tomatoes south.");
    let scoped: String = query("SELECT text FROM memories WHERE scope=?")
        .bind(&folder)
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("text");
    assert_eq!(scoped, "Soil is clay.");

    // A custom assistant, its reference, and a conversation with its snapshot.
    let assistant = query("SELECT id, tools_json, allow_memory FROM assistants WHERE name='Coach'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(assistant.get::<String, _>("tools_json"), "[\"web\"]");
    assert_eq!(assistant.get::<i64, _>("allow_memory"), 1);
    let assistant_id: String = assistant.get("id");
    let snapshot: String =
        query("SELECT snapshot_json FROM assistant_conversations WHERE assistant_id=?")
            .bind(&assistant_id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("snapshot_json");
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(snapshot["references"][0]["name"], "Plan");
    let task: String = query("SELECT safety_profile FROM agent_tasks")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("safety_profile");
    assert_eq!(task, "custom_assistant");

    // The library: a saved link and a gallery picture with its manifest.
    let saved: String = query("SELECT source_key FROM saved_items")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("source_key");
    assert_eq!(saved, "link:https://example.com/a");
    let picture = query("SELECT f.format, m.source_kind FROM account_studio_files f JOIN account_file_manifests m ON m.artifact_id=f.id")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(picture.get::<String, _>("format"), "png");
    assert_eq!(picture.get::<String, _>("source_kind"), "studio");
}
