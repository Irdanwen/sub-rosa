//! Opt-in integration proof against the real account service. The fixture is
//! disposable and injected through a path, never credentials in environment.
//! No OS keychain is read or written by this test.
use super::*;
use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::path::Path;
async fn database(path: &Path, account: &Account, device: &str) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    query("UPDATE account_sync_control SET account_id=?,device_id=? WHERE id=1")
        .bind(&account.id)
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    sync::set_enabled(&pool, true).await.unwrap();
    pool
}
fn session(f: &Value, device: &str) -> Session {
    Session {
        base: f["base"].as_str().unwrap().into(),
        account: serde_json::from_value(f["account"].clone()).unwrap(),
        token: Redacted::new(f[device]["access_token"].as_str().unwrap().into()),
    }
}
async fn title(pool: &SqlitePool, id: &str) -> String {
    query("SELECT title FROM notes WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
        .get("title")
}
#[tokio::test]
#[ignore = "requires disposable local account-service fixture; set SUBROSA_TEST_FIXTURE to its protected JSON path"]
async fn two_durable_stores_converge_preserve_resolve_and_transfer_real_files() {
    let path = std::env::var("SUBROSA_TEST_FIXTURE").unwrap();
    let bytes = Zeroizing::new(std::fs::read(path).unwrap());
    let fixture: Value = serde_json::from_slice(&bytes).unwrap();
    let a = session(&fixture, "device_a");
    let b = session(&fixture, "device_b");
    let key = crypto::decode_key(fixture["key"].as_str().unwrap()).unwrap();
    let da = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let pa = database(
        &da.path().join("notes.sqlite3"),
        &a.account,
        fixture["device_a"]["device_id"].as_str().unwrap(),
    )
    .await;
    let pb_path = db.path().join("notes.sqlite3");
    let pb = database(
        &pb_path,
        &b.account,
        fixture["device_b"]["device_id"].as_str().unwrap(),
    )
    .await;
    let note = uuid::Uuid::new_v4().to_string();
    query("INSERT INTO notes(id,title,edited_content,created_at,updated_at) VALUES(?,'First note','Private body','2026-09-14T12:00:00Z','2026-09-14T12:00:00Z')").bind(&note).execute(&pa).await.unwrap();
    query("INSERT INTO note_summaries(note_id,status,short_summary,detailed_summary,model,prompt_version,created_at,updated_at) VALUES(?,'ready','Shared summary','A finished reading','model','v1','now','now')").bind(&note).execute(&pa).await.unwrap();
    sync::synchronize(&pa, &a, &key).await.unwrap();
    sync::synchronize(&pb, &b, &key).await.unwrap();
    assert_eq!(title(&pb, &note).await, "First note");
    assert_eq!(
        query("SELECT short_summary FROM note_summaries WHERE note_id=?")
            .bind(&note)
            .fetch_one(&pb)
            .await
            .unwrap()
            .get::<String, _>("short_summary"),
        "Shared summary"
    );
    query("UPDATE notes SET title='Desktop edit' WHERE id=?")
        .bind(&note)
        .execute(&pa)
        .await
        .unwrap();
    query("UPDATE notes SET title='Phone edit' WHERE id=?")
        .bind(&note)
        .execute(&pb)
        .await
        .unwrap();
    query("UPDATE note_summaries SET short_summary='Desktop summary' WHERE note_id=?")
        .bind(&note)
        .execute(&pa)
        .await
        .unwrap();
    query("UPDATE note_summaries SET short_summary='Phone summary' WHERE note_id=?")
        .bind(&note)
        .execute(&pb)
        .await
        .unwrap();
    sync::synchronize(&pa, &a, &key).await.unwrap();
    sync::synchronize(&pb, &b, &key).await.unwrap();
    sync::synchronize(&pa, &a, &key).await.unwrap();
    assert_eq!(title(&pa, &note).await, "Desktop edit");
    assert_eq!(title(&pb, &note).await, "Phone edit");
    let conflict: String =
        query("SELECT id FROM account_sync_conflicts WHERE object_id=? AND resolved=0")
            .bind(&note)
            .fetch_one(&pb)
            .await
            .unwrap()
            .get("id");
    sync::resolve_in_store(&pb, &b, &key, &conflict, "use_remote")
        .await
        .unwrap();
    sync::synchronize(&pb, &b, &key).await.unwrap();
    sync::synchronize(&pa, &a, &key).await.unwrap();
    assert_eq!(title(&pa, &note).await, title(&pb, &note).await);
    for store in [&pa, &pb] {
        assert_eq!(
            query("SELECT short_summary FROM note_summaries WHERE note_id=?")
                .bind(&note)
                .fetch_one(store)
                .await
                .unwrap()
                .get::<String, _>("short_summary"),
            "Desktop summary"
        );
    }
    assert_eq!(
        query("SELECT count(*) AS n FROM account_sync_conflicts WHERE object_id=? AND resolved=0")
            .bind(&note)
            .fetch_one(&pa)
            .await
            .unwrap()
            .get::<i64, _>("n"),
        0
    );
    // Audio dependencies are ordinary replicated rows; the file is chunked.
    let paths = crate::app_paths::AppPaths::from_data_dir(da.path().to_path_buf()).unwrap();
    let recording = uuid::Uuid::new_v4().to_string();
    let artifact = uuid::Uuid::new_v4().to_string();
    let audio_path = paths.recordings_dir.join("fixture.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wav = hound::WavWriter::create(&audio_path, spec).unwrap();
    for n in 0..600_000 {
        wav.write_sample((n % 3000) as i16).unwrap();
    }
    wav.finalize().unwrap();
    let original = std::fs::read(&audio_path).unwrap();
    let meta = std::fs::metadata(&audio_path).unwrap();
    let modified = meta
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .to_string();
    query("INSERT INTO recording_sessions(id,note_id,status,started_at) VALUES(?,?,'completed','2026-09-14T12:00:00Z')").bind(&recording).bind(&note).execute(&pa).await.unwrap();
    query("INSERT INTO audio_artifacts(id,note_id,recording_session_id,path,format,duration_ms,size_bytes,checksum,created_at) VALUES(?,?,?,?,'wav',37500,?,'fixture','2026-09-14T12:00:00Z')").bind(&artifact).bind(&note).bind(&recording).bind(audio_path.to_string_lossy().as_ref()).bind(original.len()as i64).execute(&pa).await.unwrap();
    let manifest = uuid::Uuid::new_v4().to_string();
    query(
        "INSERT INTO account_file_uploads(artifact_id,manifest_id,bytes,modified) VALUES(?,?,?,?)",
    )
    .bind(&artifact)
    .bind(&manifest)
    .bind(original.len() as i64)
    .bind(modified)
    .execute(&pa)
    .await
    .unwrap();
    let ga = da.path().join("gallery");
    let gb = db.path().join("gallery");
    std::fs::create_dir_all(&ga).unwrap();
    std::fs::create_dir_all(&gb).unwrap();
    files::upload_one(&pa, &a, &key, &paths, &ga).await.unwrap();
    files::upload_one(&pa, &a, &key, &paths, &ga).await.unwrap();
    sync::synchronize(&pa, &a, &key).await.unwrap();
    sync::synchronize(&pb, &b, &key).await.unwrap();
    files::download_one(&pb, &b, &key, db.path(), &gb)
        .await
        .unwrap();
    // Close/reopen after the first chunk: progress and cursor survive process loss.
    let cursor: i64 = query("SELECT cursor FROM account_sync_control WHERE id=1")
        .fetch_one(&pb)
        .await
        .unwrap()
        .get("cursor");
    pb.close().await;
    let pb = database(
        &pb_path,
        &b.account,
        fixture["device_b"]["device_id"].as_str().unwrap(),
    )
    .await;
    assert_eq!(
        query("SELECT cursor FROM account_sync_control WHERE id=1")
            .fetch_one(&pb)
            .await
            .unwrap()
            .get::<i64, _>("cursor"),
        cursor
    );
    for _ in 0..32 {
        files::download_one(&pb, &b, &key, db.path(), &gb)
            .await
            .unwrap();
        if !query("SELECT path FROM audio_artifacts WHERE id=?")
            .bind(&artifact)
            .fetch_one(&pb)
            .await
            .unwrap()
            .get::<String, _>("path")
            .is_empty()
        {
            break;
        }
    }
    sync::synchronize(&pb, &b, &key).await.unwrap();
    let downloaded: String = query("SELECT path FROM audio_artifacts WHERE id=?")
        .bind(&artifact)
        .fetch_one(&pb)
        .await
        .unwrap()
        .get("path");
    assert_eq!(std::fs::read(downloaded).unwrap(), original);
    assert_eq!(
        query("SELECT count(*) AS n FROM account_sync_outbox")
            .fetch_one(&pb)
            .await
            .unwrap()
            .get::<i64, _>("n"),
        0
    );
    let ciphertext: String =
        query("SELECT ciphertext FROM account_sync_inbox WHERE object_id=? LIMIT 1")
            .bind(&note)
            .fetch_one(&pb)
            .await
            .unwrap()
            .get("ciphertext");
    assert!(!ciphertext.contains("Private body"));
    // Generated Studio images use the same encrypted chunks, with gallery
    // metadata and safe relative names; no remote job is ever queued.
    let studio_id = uuid::Uuid::new_v4().to_string();
    let studio_path = ga.join(format!("{studio_id}.png"));
    image::RgbaImage::from_pixel(20, 20, image::Rgba([12, 34, 56, 255]))
        .save(&studio_path)
        .unwrap();
    let studio_bytes = std::fs::read(&studio_path).unwrap();
    studio::register(&pa, &ga, &studio_path).await.unwrap();
    files::upload_one(&pa, &a, &key, &paths, &ga).await.unwrap();
    sync::synchronize(&pa, &a, &key).await.unwrap();
    sync::synchronize(&pb, &b, &key).await.unwrap();
    for _ in 0..32 {
        files::download_one(&pb, &b, &key, db.path(), &gb)
            .await
            .unwrap();
        if gb.join(format!("{studio_id}.png")).exists() {
            break;
        }
    }
    assert_eq!(
        std::fs::read(gb.join(format!("{studio_id}.png"))).unwrap(),
        studio_bytes
    );
    assert_eq!(
        query("SELECT count(*) AS n FROM media_jobs")
            .fetch_one(&pb)
            .await
            .unwrap()
            .get::<i64, _>("n"),
        0
    );
    // A delete on one offline device must not erase another device's edit.
    query("UPDATE notes SET title='Edited before remote deletion' WHERE id=?")
        .bind(&note)
        .execute(&pb)
        .await
        .unwrap();
    query("DELETE FROM notes WHERE id=?")
        .bind(&note)
        .execute(&pa)
        .await
        .unwrap();
    sync::synchronize(&pa, &a, &key).await.unwrap();
    sync::synchronize(&pb, &b, &key).await.unwrap();
    assert_eq!(title(&pb, &note).await, "Edited before remote deletion");
    assert!(query(
        "SELECT 1 FROM account_sync_conflicts WHERE object_id=? AND deleted=1 AND resolved=0"
    )
    .bind(&note)
    .fetch_optional(&pb)
    .await
    .unwrap()
    .is_some());
    pa.close().await;
    pb.close().await;
}
