//! Keeping the account inside its quota (ADR-0110), on the two-device bench
//! of `sync_devices_tests`: its fake service, now with a quota, chunks, `/me`
//! and `/devices`, and two libraries on one account.
use super::*;
use crate::account::{compaction, files, storage};
use crate::app_paths::AppPaths;

/// Where one device keeps its files: data, recordings and gallery.
struct Place {
    _dir: tempfile::TempDir,
    paths: AppPaths,
    gallery: std::path::PathBuf,
}
fn place() -> Place {
    let dir = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_data_dir(dir.path().join("data")).unwrap();
    let gallery = dir.path().join("gallery");
    std::fs::create_dir_all(&gallery).unwrap();
    Place {
        _dir: dir,
        paths,
        gallery,
    }
}
fn soon() -> Instant {
    Instant::now() + Duration::from_secs(120)
}
/// Bytes that do not compress and are the same on every run.
fn content(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u32).wrapping_mul(2_654_435_761).to_le_bytes()[2] ^ seed)
        .collect()
}
/// Every device on the account announces a version that reads compact copies.
async fn every_app_is_current(service: &Service) {
    let seen = chrono::Utc::now().to_rfc3339();
    service.journal.lock().await.devices = ["mac", "phone"]
        .iter()
        .map(|name| json!({"id":name,"name":name,"kind":"native","revoked_at":null,"last_seen_at":seen,"app_version":"1.91.0"}))
        .collect();
}
impl Device {
    async fn room(&self, key: &[u8; 32], full: bool) -> i64 {
        storage::room(&self.pool, &self.session, key, soon(), full, true)
            .await
            .unwrap()
    }
    /// A Studio file made on this device, filed for the account.
    async fn studio_file(&self, place: &Place, len: usize, seed: u8) -> (String, Vec<u8>) {
        let id = note();
        let bytes = content(len, seed);
        let path = place.gallery.join(format!("{id}.png"));
        std::fs::write(&path, &bytes).unwrap();
        assert!(
            super::super::studio::register(&self.pool, &place.gallery, &path)
                .await
                .unwrap()
        );
        (id, bytes)
    }
    async fn upload_all(&self, key: &[u8; 32], place: &Place) {
        for _ in 0..100 {
            if self
                .count(
                    "SELECT count(*) AS n FROM account_file_uploads WHERE completed=0 AND ?<>''",
                    "x",
                )
                .await
                == 0
            {
                return;
            }
            files::upload_one(&self.pool, &self.session, key, &place.paths, &place.gallery)
                .await
                .unwrap();
        }
        panic!("the upload never finished");
    }
    async fn download_all(&self, key: &[u8; 32], place: &Place) {
        for _ in 0..50 {
            files::download_one(
                &self.pool,
                &self.session,
                key,
                &place.paths.data_dir,
                &place.gallery,
            )
            .await
            .unwrap();
        }
    }
    async fn compact(&self, key: &[u8; 32], place: &Place) {
        for _ in 0..10 {
            compaction::step(
                &self.pool,
                &self.session,
                key,
                &place.paths,
                &place.gallery,
                soon(),
            )
            .await
            .unwrap();
        }
    }
    async fn manifest_of(&self, artifact: &str) -> Option<(String, String)> {
        query("SELECT id,chunks_json FROM account_file_manifests WHERE artifact_id=?")
            .bind(artifact)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
            .map(|r| (r.get("id"), r.get("chunks_json")))
    }
    async fn release_now(&self) {
        query("UPDATE account_blob_releases SET not_before=0")
            .execute(&self.pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn a_full_account_keeps_receiving_waits_without_asking_again_and_leaves_once_room_is_back() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    every_app_is_current(&service).await;
    let first = note();
    phone.create_note(&first, "From the phone").await;
    phone.sync(&key).await.unwrap();
    // Something nobody names, stored long ago, and an account with no room
    // left for the mac's next edit.
    {
        let mut j = service.journal.lock().await;
        j.blobs.insert(
            "0b0b0b0b-0000-4000-8000-000000000001".into(),
            fake_service::Blob {
                bytes: vec![1; 4096],
                created_at: chrono::Utc::now() - chrono::Duration::days(9),
                shared: false,
            },
        );
        j.used += 4096;
        j.quota = Some(j.used + 10);
    }
    let second = note();
    mac.create_note(&second, "From the mac").await;
    let summary = mac.sync(&key).await.unwrap();
    assert!(summary.full);
    assert_eq!(mac.title(&first).await.as_deref(), Some("From the phone"));
    assert_eq!(mac.outbox(&second).await, 1);
    // Held: the next pass asks nothing, and the tick sees no work.
    let posts = service.posts().await;
    assert!(mac.sync(&key).await.unwrap().full);
    assert_eq!(service.posts().await, posts);
    assert!(!has_local_work(&mac.pool).await.unwrap());
    // The sweep finds the unnamed chunk, gives it back an hour later from a
    // pass that has read the whole journal, and that lifts the hold.
    assert_eq!(mac.room(&key, true).await, 0);
    mac.release_now().await;
    assert_eq!(mac.room(&key, true).await, 4096);
    assert!(!storage::push_held(&mac.pool).await.unwrap());
    assert!(!mac.sync(&key).await.unwrap().full);
    assert_eq!(mac.outbox(&second).await, 0);
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.title(&second).await.as_deref(), Some("From the mac"));
}

#[tokio::test]
async fn a_file_that_does_not_fit_waits_while_a_note_still_leaves() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let mac = device(&service, "mac").await;
    let here = place();
    {
        let mut j = service.journal.lock().await;
        j.quota = Some(2 * 1024 * 1024);
        j.reserve = 1024 * 1024;
    }
    mac.studio_file(&here, 1_500_000, 1).await;
    let mut refused = None;
    for _ in 0..3 {
        if let Err(e) =
            files::upload_one(&mac.pool, &mac.session, &key, &here.paths, &here.gallery).await
        {
            refused = Some(e.code);
            break;
        }
    }
    assert_eq!(refused.as_deref(), Some("account_storage_full"));
    let id = note();
    mac.create_note(&id, "Still leaves").await;
    assert!(!mac.sync(&key).await.unwrap().full);
    assert_eq!(mac.outbox(&id).await, 0);
}

#[tokio::test]
async fn a_deleted_files_chunks_are_released_a_day_later_and_only_once() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let here = place();
    let (file, _) = mac.studio_file(&here, 2_500_000, 2).await;
    mac.upload_all(&key, &here).await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    let stored = service.journal.lock().await.blobs.len();
    assert_eq!(stored, 3);
    crate::studio_library::forget_in(&mac.pool, &file)
        .await
        .unwrap();
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    // Planned for tomorrow: nothing goes today.
    phone.room(&key, false).await;
    assert_eq!(service.journal.lock().await.blobs.len(), 3);
    assert_eq!(
        phone
            .count(
                "SELECT count(*) AS n FROM account_blob_releases WHERE ?<>''",
                "x"
            )
            .await,
        3
    );
    phone.release_now().await;
    assert!(phone.room(&key, false).await > 0);
    assert!(service.journal.lock().await.blobs.is_empty());
    // The other device plans the same chunks and finds them gone already.
    let deletes = service.journal.lock().await.blob_deletes;
    mac.room(&key, false).await;
    mac.release_now().await;
    assert_eq!(mac.room(&key, false).await, 0);
    assert_eq!(service.journal.lock().await.blob_deletes, deletes);
    assert_eq!(
        mac.count(
            "SELECT count(*) AS n FROM account_blob_releases WHERE ?<>''",
            "x"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn the_sweep_spares_young_and_shared_chunks_and_a_manifest_it_raced_repairs_itself() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    every_app_is_current(&service).await;
    let (on_mac, on_phone) = (place(), place());
    // The phone sends its file's chunks, then cannot send the manifest.
    service.journal.lock().await.refuse_posts = true;
    let (file, bytes) = phone.studio_file(&on_phone, 1_200_000, 3).await;
    phone.upload_all(&key, &on_phone).await;
    assert!(phone.sync(&key).await.is_err());
    {
        let mut j = service.journal.lock().await;
        for blob in j.blobs.values_mut() {
            blob.created_at = chrono::Utc::now() - chrono::Duration::days(8);
        }
        let now = chrono::Utc::now();
        let old = now - chrono::Duration::days(30);
        j.blobs.insert(
            "0c0c0c0c-0000-4000-8000-000000000001".into(),
            fake_service::Blob {
                bytes: vec![2; 10],
                created_at: now,
                shared: false,
            },
        );
        j.blobs.insert(
            "0c0c0c0c-0000-4000-8000-000000000002".into(),
            fake_service::Blob {
                bytes: vec![3; 10],
                created_at: old,
                shared: true,
            },
        );
        j.refuse_posts = false;
    }
    // A week on, the mac sweeps: the phone's chunks are named nowhere it knows.
    mac.sync(&key).await.unwrap();
    mac.room(&key, false).await;
    mac.release_now().await;
    mac.room(&key, false).await;
    let left: Vec<String> = service.journal.lock().await.blobs.keys().cloned().collect();
    assert_eq!(
        left,
        vec![
            "0c0c0c0c-0000-4000-8000-000000000001".to_string(),
            "0c0c0c0c-0000-4000-8000-000000000002".to_string()
        ]
    );
    // The phone holds its manifest back rather than name lost chunks...
    phone.sync(&key).await.unwrap();
    assert_eq!(
        phone
            .count(
                "SELECT count(*) AS n FROM account_chunk_repairs WHERE ?<>''",
                "x"
            )
            .await,
        1
    );
    // ...sends them again from its copy, and then lets it go.
    compaction::repair(
        &phone.pool,
        &phone.session,
        &key,
        &on_phone.paths,
        &on_phone.gallery,
        soon(),
    )
    .await
    .unwrap();
    assert_eq!(
        phone
            .count(
                "SELECT count(*) AS n FROM account_sync_issues WHERE ?<>''",
                "x"
            )
            .await,
        0
    );
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    mac.download_all(&key, &on_mac).await;
    assert_eq!(
        std::fs::read(on_mac.gallery.join(format!("{file}.png"))).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn a_studio_file_is_sent_again_compact_and_a_device_that_holds_it_fetches_nothing() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let (on_mac, on_phone) = (place(), place());
    let (file, bytes) = mac.studio_file(&on_mac, 2_200_000, 4).await;
    mac.upload_all(&key, &on_mac).await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    phone.download_all(&key, &on_phone).await;
    let before = service.journal.lock().await.used;
    // The phone is old: nothing is rewritten until it is not.
    mac.room(&key, false).await;
    mac.compact(&key, &on_mac).await;
    let (old, _) = mac.manifest_of(&file).await.unwrap();
    assert_eq!(mac.manifest_of(&file).await.unwrap().0, old);
    every_app_is_current(&service).await;
    query("UPDATE account_storage_state SET gate_checked_at=0")
        .execute(&mac.pool)
        .await
        .unwrap();
    mac.room(&key, false).await;
    mac.compact(&key, &on_mac).await;
    let (new, chunks) = mac.manifest_of(&file).await.unwrap();
    assert_eq!(new, compaction::replacement_id(&old));
    assert!(storage::chunk_ids(&chunks)
        .iter()
        .all(|id| &id[14..15] == "5"));
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.manifest_of(&file).await.unwrap().0, new);
    let gets = service.journal.lock().await.blob_gets;
    phone.download_all(&key, &on_phone).await;
    assert_eq!(service.journal.lock().await.blob_gets, gets);
    assert_eq!(
        std::fs::read(on_phone.gallery.join(format!("{file}.png"))).unwrap(),
        bytes
    );
    // A day later the first form goes, and the account is lighter by a quarter.
    mac.room(&key, false).await;
    mac.release_now().await;
    mac.room(&key, false).await;
    let j = service.journal.lock().await;
    assert!(j
        .blobs
        .values()
        .all(|b| b.bytes[0] == crypto::BINARY_ENVELOPE));
    assert!(j.used < before * 80 / 100, "{} of {before}", j.used);
}

#[tokio::test]
async fn two_devices_compacting_one_file_leave_it_to_the_first_and_free_nothing_of_its() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    every_app_is_current(&service).await;
    let (on_mac, on_phone) = (place(), place());
    let (file, _) = mac.studio_file(&on_mac, 2_100_000, 5).await;
    // Sent in the first form while the gate was still closed on the mac.
    mac.upload_all(&key, &on_mac).await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    phone.download_all(&key, &on_phone).await;
    phone.room(&key, false).await;
    mac.room(&key, false).await;
    phone.compact(&key, &on_phone).await;
    let (copy, chunks) = phone.manifest_of(&file).await.unwrap();
    // The mac reaches the same copy's first chunk and finds it taken.
    mac.compact(&key, &on_mac).await;
    assert_eq!(
        mac.count(
            "SELECT count(*) AS n FROM account_file_compactions WHERE held_until>0 AND id=?",
            &copy
        )
        .await,
        1
    );
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.manifest_of(&file).await.unwrap().0, copy);
    query("UPDATE account_file_compactions SET held_until=0")
        .execute(&mac.pool)
        .await
        .unwrap();
    mac.compact(&key, &on_mac).await;
    assert_eq!(
        mac.count(
            "SELECT count(*) AS n FROM account_file_compactions WHERE ?<>''",
            "x"
        )
        .await,
        0
    );
    let releasing: Vec<String> = query("SELECT blob_id FROM account_blob_releases")
        .fetch_all(&mac.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.get("blob_id"))
        .collect();
    let blobs = service.journal.lock().await.blobs.clone();
    for id in storage::chunk_ids(&chunks) {
        assert!(!releasing.contains(&id));
        assert!(blobs.contains_key(&id));
    }
}

#[tokio::test]
async fn a_recording_leaves_as_a_16_khz_copy_and_plays_on_the_other_device() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    every_app_is_current(&service).await;
    let (on_mac, on_phone) = (place(), place());
    let (id, session, artifact) = (note(), note(), note());
    let recording = on_mac.paths.recordings_dir.join("take.wav");
    {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&recording, spec).unwrap();
        for i in 0..48_000 * 3 {
            let t = i as f32 / 48_000.0;
            writer
                .write_sample(((t * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16)
                .unwrap();
        }
        writer.finalize().unwrap();
    }
    let original = std::fs::metadata(&recording).unwrap().len();
    mac.create_note(&id, "A meeting").await;
    query("INSERT INTO recording_sessions(id,note_id,status,started_at) VALUES(?,?,'completed','now')")
        .bind(&session)
        .bind(&id)
        .execute(&mac.pool)
        .await
        .unwrap();
    query("INSERT INTO audio_artifacts(id,note_id,recording_session_id,path,format,duration_ms,size_bytes,checksum,created_at) VALUES(?,?,?,?,'wav',3000,?,'sum','now')")
        .bind(&artifact)
        .bind(&id)
        .bind(&session)
        .bind(recording.to_string_lossy().as_ref())
        .bind(original as i64)
        .execute(&mac.pool)
        .await
        .unwrap();
    mac.room(&key, false).await;
    mac.compact(&key, &on_mac).await;
    let (_, chunks) = mac.manifest_of(&artifact).await.unwrap();
    let sent: usize = {
        let j = service.journal.lock().await;
        storage::chunk_ids(&chunks)
            .iter()
            .map(|c| j.blobs[c].bytes.len())
            .sum()
    };
    assert!((sent as u64) < original / 2, "{sent} of {original}");
    // The original stays where it was recorded.
    assert_eq!(std::fs::metadata(&recording).unwrap().len(), original);
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    phone.download_all(&key, &on_phone).await;
    let path: String = query("SELECT path FROM audio_artifacts WHERE id=?")
        .bind(&artifact)
        .fetch_one(&phone.pool)
        .await
        .unwrap()
        .get("path");
    let reader = hound::WavReader::open(&path).unwrap();
    assert_eq!(reader.spec().sample_rate, 16_000);
    assert_eq!(reader.spec().channels, 1);
    assert!((reader.duration() as i64 - 48_000).abs() < 1_600);
}

#[tokio::test]
async fn a_device_that_cannot_send_even_a_note_gives_back_its_own_unfinished_upload() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let mac = device(&service, "mac").await;
    let here = place();
    mac.studio_file(&here, 3_000_000, 6).await;
    // Two of three chunks sent, then the account is full to the byte.
    for _ in 0..2 {
        files::upload_one(&mac.pool, &mac.session, &key, &here.paths, &here.gallery)
            .await
            .unwrap();
    }
    {
        let mut j = service.journal.lock().await;
        j.quota = Some(j.used);
    }
    let id = note();
    mac.create_note(&id, "Must leave").await;
    assert!(mac.sync(&key).await.unwrap().full);
    assert!(mac.room(&key, true).await >= 2 * 1024 * 1024);
    assert!(service.journal.lock().await.blobs.is_empty());
    assert!(!mac.sync(&key).await.unwrap().full);
    assert_eq!(mac.outbox(&id).await, 0);
    // The upload starts over from its first byte, under a new manifest id.
    assert_eq!(
        mac.count("SELECT count(*) AS n FROM account_file_uploads WHERE next_offset=0 AND completed=0 AND ?<>''", "x")
            .await,
        1
    );
}

/// The case a review found: the tombstone of a file's first form leaves while
/// its compact copy is held back (a chunk went missing). The other device,
/// which holds a downloaded copy and now no manifest, must not send that copy
/// as a new recording, and nothing the journal still holds as live is ever
/// released.
#[tokio::test]
async fn a_tombstone_that_outruns_its_replacement_starts_no_copy_elsewhere() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let (on_mac, on_phone) = (place(), place());
    let (id, session, artifact) = (note(), note(), note());
    let recording = on_mac.paths.recordings_dir.join("take.wav");
    {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&recording, spec).unwrap();
        for i in 0..48_000 * 20 {
            writer.write_sample(((i % 97) as i16 - 48) * 300).unwrap();
        }
        writer.finalize().unwrap();
    }
    mac.create_note(&id, "Interview").await;
    query("INSERT INTO recording_sessions(id,note_id,status,started_at) VALUES(?,?,'completed','now')")
        .bind(&session)
        .bind(&id)
        .execute(&mac.pool)
        .await
        .unwrap();
    query("INSERT INTO audio_artifacts(id,note_id,recording_session_id,path,format,duration_ms,size_bytes,checksum,created_at) VALUES(?,?,?,?,'wav',20000,1,'sum','now')")
        .bind(&artifact)
        .bind(&id)
        .bind(&session)
        .bind(recording.to_string_lossy().as_ref())
        .execute(&mac.pool)
        .await
        .unwrap();
    // First form, sent while an older app was still on the account.
    query("INSERT INTO account_file_uploads(artifact_id,manifest_id,bytes,modified) SELECT a.id,?,?,? FROM audio_artifacts a WHERE a.id=?")
        .bind(note())
        .bind(std::fs::metadata(&recording).unwrap().len() as i64)
        .bind(files::modified(&std::fs::metadata(&recording).unwrap()).unwrap())
        .bind(&artifact)
        .execute(&mac.pool)
        .await
        .unwrap();
    mac.upload_all(&key, &on_mac).await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    phone.download_all(&key, &on_phone).await;
    let (first, _) = phone.manifest_of(&artifact).await.unwrap();
    // Every app is current now: the mac makes the compact copy.
    every_app_is_current(&service).await;
    mac.room(&key, false).await;
    phone.room(&key, false).await;
    mac.compact(&key, &on_mac).await;
    let (copy, chunks) = mac.manifest_of(&artifact).await.unwrap();
    assert_ne!(copy, first);
    // One of its chunks goes missing before it leaves: the copy is held, the
    // tombstone of the first form is not.
    let lost = storage::chunk_ids(&chunks)[0].clone();
    {
        let mut j = service.journal.lock().await;
        let gone = j.blobs.remove(&lost).unwrap();
        j.used -= gone.bytes.len() as i64;
    }
    mac.sync(&key).await.unwrap();
    assert!(service.heads(&copy).await.is_empty());
    phone.sync(&key).await.unwrap();
    assert!(phone.manifest_of(&artifact).await.is_none());
    // The phone holds the recording and no manifest, and sends nothing.
    let held: String = query("SELECT path FROM audio_artifacts WHERE id=?")
        .bind(&artifact)
        .fetch_one(&phone.pool)
        .await
        .unwrap()
        .get("path");
    assert!(!held.is_empty());
    assert!(storage::format_v2(&phone.pool).await.unwrap());
    phone.compact(&key, &on_phone).await;
    assert!(phone.manifest_of(&artifact).await.is_none());
    // The mac sends the lost chunk again from its recording, then the copy.
    compaction::repair(
        &mac.pool,
        &mac.session,
        &key,
        &on_mac.paths,
        &on_mac.gallery,
        soon(),
    )
    .await
    .unwrap();
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.manifest_of(&artifact).await.unwrap().0, copy);
    assert_eq!(service.heads(&copy).await.len(), 1);
}

/// A recording leaves N days after its note is transcribed (ADR-0112): the
/// choice made on one device reaches the other, each deletes its own copy,
/// the account's copy is released, nothing is sent again, and both notes
/// keep their transcript.
#[tokio::test]
async fn a_recording_past_the_chosen_age_leaves_every_device_and_the_account() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let (on_mac, on_phone) = (place(), place());
    let (id, session, artifact) = (note(), note(), note());
    let recording = on_mac.paths.recordings_dir.join("meeting.wav");
    std::fs::write(&recording, content(1_500_000, 9)).unwrap();
    mac.create_note(&id, "Weekly meeting").await;
    for sql in [
        "UPDATE notes SET processing_status='ready' WHERE id=?1",
        "INSERT INTO recording_sessions(id,note_id,status,started_at) VALUES(?2,?1,'completed','2026-09-18T09:00:00Z')",
        "INSERT INTO audio_artifacts(id,note_id,recording_session_id,path,format,duration_ms,size_bytes,checksum,created_at) VALUES(?3,?1,?2,?4,'wav',60000,1500000,'sum','2026-09-18T09:00:00Z')",
        "INSERT INTO transcripts(id,note_id,audio_artifact_id,text,provider,status,created_at,updated_at) VALUES(?5,?1,?3,'What was said','test','completed','2026-09-18T09:30:00Z','2026-09-18T09:30:00Z')",
    ] {
        query(sql)
            .bind(&id)
            .bind(&session)
            .bind(&artifact)
            .bind(recording.to_string_lossy().as_ref())
            .bind(note())
            .execute(&mac.pool)
            .await
            .unwrap();
    }
    query(
        "INSERT INTO account_file_uploads(artifact_id,manifest_id,bytes,modified) VALUES(?,?,?,?)",
    )
    .bind(&artifact)
    .bind(note())
    .bind(1_500_000_i64)
    .bind(files::modified(&std::fs::metadata(&recording).unwrap()).unwrap())
    .execute(&mac.pool)
    .await
    .unwrap();
    mac.upload_all(&key, &on_mac).await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    phone.download_all(&key, &on_phone).await;
    let fetched: String = query("SELECT path FROM audio_artifacts WHERE id=?")
        .bind(&artifact)
        .fetch_one(&phone.pool)
        .await
        .unwrap()
        .get("path");
    assert!(std::path::Path::new(&fetched).is_file());
    assert_eq!(service.journal.lock().await.blobs.len(), 2);

    // Chosen on the phone, a week: the mac receives the same choice.
    query("INSERT INTO account_preferences(id,audio_retention_days,updated_at) VALUES(?,7,'now')")
        .bind(crate::recording_retention::PREFERENCES_ID)
        .execute(&phone.pool)
        .await
        .unwrap();
    let repos = |d: &Device| crate::db::repositories::Repositories::new(d.pool.clone());
    let gone = crate::recording_retention::purge_in(&repos(&phone), &on_phone.paths, 7, false)
        .await
        .unwrap();
    assert_eq!(gone.recordings, 1);
    assert!(!std::path::Path::new(&fetched).exists());
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(
        crate::recording_retention::retention_days(&mac.pool)
            .await
            .unwrap(),
        Some(7)
    );
    assert!(mac.manifest_of(&artifact).await.is_none());
    crate::recording_retention::purge_in(&repos(&mac), &on_mac.paths, 7, false)
        .await
        .unwrap();
    assert!(!recording.exists());
    // Nothing is sent again, by either device, in either form.
    for (dev, at) in [(&mac, &on_mac), (&phone, &on_phone)] {
        query("UPDATE account_storage_state SET format_v2=1")
            .execute(&dev.pool)
            .await
            .unwrap();
        dev.compact(&key, at).await;
        dev.sync(&key).await.unwrap();
        assert!(dev.manifest_of(&artifact).await.is_none());
        assert_eq!(
            dev.count("SELECT count(*) AS n FROM account_file_uploads WHERE completed=0 AND artifact_id=?", &artifact)
                .await,
            0
        );
        // The note keeps what was said.
        assert_eq!(
            dev.count(
                "SELECT count(*) AS n FROM transcripts WHERE audio_artifact_id=?",
                &artifact
            )
            .await,
            1
        );
    }
    // A day later the account's copy goes.
    phone.room(&key, false).await;
    phone.release_now().await;
    phone.room(&key, false).await;
    assert!(service.journal.lock().await.blobs.is_empty());
}
