//! Two devices, one account, a service between them (`fake_service`). Each
//! device is an ordinary library: migrations, triggers, outbox, inbox, heads.
//! The scenarios here are the ones a person lives: an edit on one machine
//! and a deletion on the other, a phone that was away, a build that is older
//! than its sibling. They drive `synchronize` exactly as the app does.
use super::*;
use fake_service::Service;
use sqlx_sqlite::SqlitePoolOptions;

mod fake_service {
    //! A journal service in memory behind a real socket, for tests that put two
    //! devices on either side of one. It mirrors what the account service does
    //! with a push and a pull (`subrosa-cloud/crates/persistence`): one sequence
    //! per account, heads per object, a sibling head when a parent is stale,
    //! idempotent operation ids, pages, the heads-only bootstrap and the long
    //! wait. Nothing here is cryptographic: ciphertext is carried as given.
    use super::super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::{Mutex, Notify};

    #[derive(Clone, Debug)]
    pub struct Revision {
        pub sequence: i64,
        pub operation_id: String,
        pub operation_hash: String,
        pub object_id: String,
        pub revision: String,
        pub parent_revision: Option<String>,
        pub kind: String,
        pub ciphertext: String,
        pub deleted: bool,
        pub conflict: bool,
        pub device_id: Option<String>,
        pub is_head: bool,
        pub resolved_revisions: Vec<String>,
    }

    #[derive(Default)]
    pub struct Journal {
        pub next_sequence: i64,
        pub revisions: Vec<Revision>,
        /// Requests seen, by route, so a test can say how many trips a change
        /// cost.
        pub posts: usize,
        pub gets: usize,
        pub waits: usize,
        /// What an older service would not know.
        pub without_wait: bool,
        pub without_heads: bool,
        /// Every push answered 503, for the test that leaves a sealed row behind.
        pub refuse_posts: bool,
        /// How long a wait holds before answering "nothing changed".
        pub wait_for: Duration,
        /// The account's quota, as the service keeps it (ADR-0110): `None`
        /// is unlimited. A revision costs its ciphertext and 256 bytes; files
        /// stop `reserve` short of the quota.
        pub quota: Option<i64>,
        pub reserve: i64,
        pub used: i64,
        pub blobs: std::collections::BTreeMap<String, Blob>,
        /// What `/api/v1/devices` lists, app versions included.
        pub devices: Vec<Value>,
        pub blob_gets: usize,
        pub blob_puts: usize,
        pub blob_deletes: usize,
    }

    #[derive(Clone, Debug)]
    pub struct Blob {
        pub bytes: Vec<u8>,
        pub created_at: chrono::DateTime<chrono::Utc>,
        pub shared: bool,
    }

    pub struct Service {
        pub base: String,
        pub journal: Arc<Mutex<Journal>>,
    }

    impl Service {
        pub async fn start() -> Service {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let journal = Arc::new(Mutex::new(Journal {
                wait_for: Duration::from_secs(2),
                ..Journal::default()
            }));
            let changed = Arc::new(Notify::new());
            let (shared, wake) = (journal.clone(), changed.clone());
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    let (journal, changed) = (shared.clone(), wake.clone());
                    tokio::spawn(async move { serve(stream, journal, changed).await });
                }
            });
            drop(changed);
            Service { base, journal }
        }
        pub async fn heads(&self, object_id: &str) -> Vec<Revision> {
            self.journal
                .lock()
                .await
                .revisions
                .iter()
                .filter(|r| r.object_id == object_id && r.is_head)
                .cloned()
                .collect()
        }
        pub async fn revisions(&self, object_id: &str) -> Vec<Revision> {
            self.journal
                .lock()
                .await
                .revisions
                .iter()
                .filter(|r| r.object_id == object_id)
                .cloned()
                .collect()
        }
        pub async fn posts(&self) -> usize {
            self.journal.lock().await.posts
        }
        #[allow(dead_code)]
        pub async fn gets(&self) -> usize {
            self.journal.lock().await.gets
        }
    }

    async fn serve(
        mut stream: tokio::net::TcpStream,
        journal: Arc<Mutex<Journal>>,
        changed: Arc<Notify>,
    ) {
        let mut received = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            if let Some(at) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => received.extend_from_slice(&chunk[..read]),
            }
        };
        let head = String::from_utf8_lossy(&received[..header_end]).into_owned();
        let mut lines = head.lines();
        let request_line = lines.next().unwrap_or_default().to_string();
        let mut parts = request_line.split(' ');
        let method = parts.next().unwrap_or_default().to_string();
        let target = parts.next().unwrap_or_default().to_string();
        let mut length = 0usize;
        let mut device = None;
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match name.to_ascii_lowercase().as_str() {
                "content-length" => length = value.parse().unwrap_or(0),
                "authorization" => device = value.strip_prefix("Bearer ").map(str::to_string),
                _ => {}
            }
        }
        while received.len() < header_end + length {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => received.extend_from_slice(&chunk[..read]),
            }
        }
        let body = &received[header_end..header_end + length];
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        let mut raw: Option<Vec<u8>> = None;
        let params: std::collections::HashMap<String, String> = query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let (status, payload) = match (method.as_str(), path) {
            ("POST", "/api/v1/sync") => {
                let parsed: Result<Value, _> = serde_json::from_slice(body);
                let mut j = journal.lock().await;
                j.posts += 1;
                if j.refuse_posts {
                    ("503 Service Unavailable", Err("unavailable"))
                } else {
                    match parsed.ok().and_then(|v| v.get("operations").cloned()) {
                        Some(Value::Array(ops)) => match append(&mut j, &ops, device) {
                            Ok(results) => {
                                drop(j);
                                changed.notify_waiters();
                                ("200 OK", Ok(json!({"results":results})))
                            }
                            Err(code) => (
                                match code {
                                    "conflict" => "409 Conflict",
                                    "quota_exceeded" => "413 Payload Too Large",
                                    _ => "400 Bad Request",
                                },
                                Err(code),
                            ),
                        },
                        _ => ("400 Bad Request", Err("invalid_request")),
                    }
                }
            }
            ("GET", "/api/v1/sync") => {
                let mut j = journal.lock().await;
                j.gets += 1;
                let after: i64 = params
                    .get("after")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let limit: i64 = params
                    .get("limit")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(100);
                let heads = params.get("heads").is_some_and(|v| v == "1") && !j.without_heads;
                match changes(
                    &j,
                    after,
                    limit,
                    params.get("kind").map(String::as_str),
                    heads,
                ) {
                    Ok(page) => ("200 OK", Ok(page)),
                    Err(code) => ("400 Bad Request", Err(code)),
                }
            }
            ("GET", "/api/v1/sync/wait") => {
                let after: i64 = params
                    .get("after")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let (unsupported, wait_for) = {
                    let mut j = journal.lock().await;
                    j.waits += 1;
                    (j.without_wait, j.wait_for)
                };
                if unsupported {
                    ("404 Not Found", Err("not_found"))
                } else {
                    let notified = changed.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    let now = journal.lock().await.next_sequence;
                    let changed = if after > now {
                        None
                    } else if now > after {
                        Some(true)
                    } else {
                        Some(tokio::time::timeout(wait_for, notified).await.is_ok())
                    };
                    match changed {
                        None => ("400 Bad Request", Err("invalid_request")),
                        Some(changed) => ("200 OK", Ok(json!({"changed":changed}))),
                    }
                }
            }
            ("GET", "/api/v1/me") => {
                let j = journal.lock().await;
                let files: i64 = j.blobs.values().map(|b| b.bytes.len() as i64).sum();
                let storage = j.quota.map(|quota| {
                    json!({"used_bytes":j.used,"quota_bytes":quota,"file_bytes":files,"journal_reserve_bytes":j.reserve})
                });
                (
                    "200 OK",
                    Ok(
                        json!({"id":"account-one","email":"one@example.test","created_at":"now","storage":storage}),
                    ),
                )
            }
            ("GET", "/api/v1/devices") => ("200 OK", Ok(json!(journal.lock().await.devices))),
            ("GET", "/api/v1/blobs") => {
                let j = journal.lock().await;
                let limit: usize = params
                    .get("limit")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(500);
                let named: Option<Vec<String>> = params
                    .get("ids")
                    .map(|ids| ids.split(',').map(str::to_string).collect());
                let after = params.get("after").cloned().unwrap_or_default();
                let listed: Vec<Value> = j
                    .blobs
                    .iter()
                    .filter(|(id, _)| named.as_ref().map_or(id.as_str() > after.as_str(), |n| n.contains(id)))
                    .take(if named.is_some() { usize::MAX } else { limit })
                    .map(|(id, b)| json!({"id":id,"bytes":b.bytes.len(),"created_at":b.created_at.to_rfc3339(),"shared":b.shared}))
                    .collect();
                let has_more = named.is_none() && listed.len() == limit;
                ("200 OK", Ok(json!({"blobs":listed,"has_more":has_more})))
            }
            (method, blob) if blob.starts_with("/api/v1/blobs/") => {
                let id = blob.trim_start_matches("/api/v1/blobs/").to_string();
                let mut j = journal.lock().await;
                match method {
                    "GET" => {
                        j.blob_gets += 1;
                        match j.blobs.get(&id) {
                            Some(b) => {
                                raw = Some(b.bytes.clone());
                                ("200 OK", Ok(Value::Null))
                            }
                            None => ("404 Not Found", Err("not_found")),
                        }
                    }
                    "PUT" => {
                        j.blob_puts += 1;
                        let limit = j.quota.map(|q| q - j.reserve);
                        match j.blobs.get(&id) {
                            Some(b) if b.bytes == body => {
                                ("200 OK", Ok(json!({"id":id,"bytes":body.len()})))
                            }
                            Some(_) => ("409 Conflict", Err("conflict")),
                            None if limit.is_some_and(|l| j.used + body.len() as i64 > l) => {
                                ("413 Payload Too Large", Err("storage_files_full"))
                            }
                            None => {
                                j.used += body.len() as i64;
                                j.blobs.insert(
                                    id.clone(),
                                    Blob {
                                        bytes: body.to_vec(),
                                        created_at: chrono::Utc::now(),
                                        shared: false,
                                    },
                                );
                                ("200 OK", Ok(json!({"id":id,"bytes":body.len()})))
                            }
                        }
                    }
                    "DELETE" => match j.blobs.get(&id).cloned() {
                        None => ("404 Not Found", Err("not_found")),
                        Some(b) if b.shared => ("409 Conflict", Err("conflict")),
                        Some(b) => {
                            j.blob_deletes += 1;
                            j.blobs.remove(&id);
                            j.used -= b.bytes.len() as i64;
                            ("200 OK", Ok(json!({"id":id,"freed_bytes":b.bytes.len()})))
                        }
                    },
                    _ => ("404 Not Found", Err("not_found")),
                }
            }
            _ => ("404 Not Found", Err("not_found")),
        };
        if let Some(bytes) = raw {
            let mut response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                bytes.len()
            )
            .into_bytes();
            response.extend_from_slice(&bytes);
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
            return;
        }
        let body = match payload {
            Ok(data) => json!({"data":data}).to_string(),
            Err(code) => json!({"error":{"code":code,"message":code}}).to_string(),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    fn append(
        j: &mut Journal,
        ops: &[Value],
        device: Option<String>,
    ) -> Result<Vec<Value>, &'static str> {
        if ops.is_empty() || ops.len() > 100 {
            return Err("invalid_request");
        }
        let mut total = 0usize;
        for op in ops {
            let bytes = op["ciphertext"].as_str().map_or(0, str::len);
            if bytes > 1024 * 1024 {
                return Err("invalid_request");
            }
            total += bytes;
        }
        if total > 4 * 1024 * 1024 {
            return Err("invalid_request");
        }
        let cost = total as i64 + 256 * ops.len() as i64;
        if j.quota.is_some_and(|quota| j.used + cost > quota) {
            return Err("quota_exceeded");
        }
        // The whole batch is one transaction: work on a copy, keep it on success.
        let mut revisions = j.revisions.clone();
        let mut next = j.next_sequence;
        let mut results = Vec::new();
        for op in ops {
            let operation_id = op["operation_id"]
                .as_str()
                .ok_or("invalid_request")?
                .to_string();
            let object_id = op["object_id"]
                .as_str()
                .ok_or("invalid_request")?
                .to_string();
            let hash = op.to_string();
            if let Some(old) = revisions.iter().find(|r| r.operation_id == operation_id) {
                if old.operation_hash != hash {
                    return Err("conflict");
                }
                results.push(json!({"operation_id":operation_id,"revision":old.revision,"sequence":old.sequence,"conflict":old.conflict}));
                continue;
            }
            let parent = op["parent_revision"].as_str().map(str::to_string);
            let resolved: Vec<String> = op["resolved_revisions"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if resolved.len() > 64 {
                return Err("invalid_request");
            }
            let known = |revision: &str| {
                revisions
                    .iter()
                    .any(|r| r.object_id == object_id && r.revision == revision)
            };
            if parent.as_deref().is_some_and(|p| !known(p)) || resolved.iter().any(|r| !known(r)) {
                return Err("conflict");
            }
            let mut acknowledged = resolved.clone();
            acknowledged.extend(parent.clone());
            let conflict = revisions.iter().any(|r| {
                r.object_id == object_id && r.is_head && !acknowledged.contains(&r.revision)
            });
            for r in revisions.iter_mut() {
                if r.object_id == object_id && acknowledged.contains(&r.revision) {
                    r.is_head = false;
                }
            }
            next += 1;
            let revision = uuid::Uuid::now_v7().to_string();
            revisions.push(Revision {
                sequence: next,
                operation_id: operation_id.clone(),
                operation_hash: hash,
                object_id,
                revision: revision.clone(),
                parent_revision: parent,
                kind: op["kind"].as_str().unwrap_or_default().to_string(),
                ciphertext: op["ciphertext"].as_str().unwrap_or_default().to_string(),
                deleted: op["deleted"].as_bool().unwrap_or(false),
                conflict,
                device_id: device.clone(),
                is_head: true,
                resolved_revisions: resolved,
            });
            results.push(json!({"operation_id":operation_id,"revision":revision,"sequence":next,"conflict":conflict}));
        }
        j.revisions = revisions;
        j.next_sequence = next;
        j.used += cost;
        Ok(results)
    }

    fn changes(
        j: &Journal,
        after: i64,
        limit: i64,
        kind: Option<&str>,
        heads: bool,
    ) -> Result<Value, &'static str> {
        if after < 0 || !(1..=500).contains(&limit) {
            return Err("invalid_request");
        }
        let watermark = j.next_sequence;
        if after > watermark {
            return Err("invalid_request");
        }
        // Heads only, plus the direct parent of every head of an object with
        // several heads (a merge needs its ancestor) and of every tombstone head
        // (what a deletion took is listed from it).
        let mut wanted = std::collections::HashSet::new();
        if heads {
            for r in &j.revisions {
                if !r.is_head {
                    continue;
                }
                let siblings = j
                    .revisions
                    .iter()
                    .filter(|o| o.object_id == r.object_id && o.is_head)
                    .count();
                if (siblings > 1 || r.deleted) && r.parent_revision.is_some() {
                    wanted.insert(r.parent_revision.clone().unwrap());
                }
            }
        }
        let mut rows: Vec<&Revision> = j
            .revisions
            .iter()
            .filter(|r| r.sequence > after && r.sequence <= watermark)
            .filter(|r| kind.map_or(true, |k| r.kind == k))
            .filter(|r| !heads || r.is_head || wanted.contains(&r.revision))
            .collect();
        rows.sort_by_key(|r| r.sequence);
        let has_more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let cursor = if has_more {
            rows.last().map_or(after, |r| r.sequence)
        } else {
            watermark
        };
        let changes: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({"sequence":r.sequence,"operation_id":r.operation_id,"object_id":r.object_id,"revision":r.revision,"parent_revision":r.parent_revision,"resolved_revisions":r.resolved_revisions,"kind":r.kind,"ciphertext":r.ciphertext,"deleted":r.deleted,"device_id":r.device_id})
            })
            .collect();
        Ok(json!({"changes":changes,"cursor":cursor,"has_more":has_more}))
    }
}

struct Device {
    pub pool: SqlitePool,
    pub session: Session,
}

async fn device(service: &Service, name: &str) -> Device {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    query("UPDATE account_sync_control SET account_id='account-one',device_id=?,recovery_confirmed=1 WHERE id=1")
        .bind(name)
        .execute(&pool)
        .await
        .unwrap();
    set_enabled(&pool, true).await.unwrap();
    Device {
        pool,
        session: Session {
            base: service.base.clone(),
            account: Account {
                id: "account-one".into(),
                email: "one@example.test".into(),
                created_at: "now".into(),
            },
            token: Redacted::new(name.into()),
        },
    }
}

impl Device {
    pub async fn sync(&self, key: &[u8; 32]) -> Result<Summary, AppError> {
        synchronize(&self.pool, &self.session, key).await
    }
    pub async fn create_note(&self, id: &str, title: &str) {
        query("INSERT INTO notes(id,title,created_at,updated_at) VALUES(?,?,?,?)")
            .bind(id)
            .bind(title)
            .bind("2026-10-11T12:00:00Z")
            .bind("2026-10-11T12:00:00Z")
            .execute(&self.pool)
            .await
            .unwrap();
    }
    pub async fn edit_note(&self, id: &str, title: &str) {
        query("UPDATE notes SET title=?,updated_at=? WHERE id=?")
            .bind(title)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await
            .unwrap();
    }
    pub async fn delete_note(&self, id: &str) {
        let mut tx = self.pool.begin().await.unwrap();
        crate::db::repositories::delete_note_records(&mut tx, id)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    pub async fn title(&self, id: &str) -> Option<String> {
        query("SELECT title FROM notes WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
            .map(|r| r.get("title"))
    }
    pub async fn cards(&self, id: &str) -> i64 {
        self.count(
            "SELECT count(*) AS n FROM account_sync_conflicts WHERE resolved=0 AND object_id=?",
            id,
        )
        .await
    }
    pub async fn outbox(&self, id: &str) -> i64 {
        self.count(
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=?",
            id,
        )
        .await
    }
    pub async fn head(&self, id: &str) -> Option<String> {
        query("SELECT revision FROM account_sync_heads WHERE object_id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
            .map(|r| r.get("revision"))
    }
    pub async fn cursor(&self) -> i64 {
        query("SELECT cursor FROM account_sync_control WHERE id=1")
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .get("cursor")
    }
    pub async fn applying(&self) -> i64 {
        query("SELECT applying FROM account_sync_control WHERE id=1")
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .get("applying")
    }
    pub async fn count(&self, sql: &str, id: &str) -> i64 {
        query(sql)
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .get::<i64, _>("n")
    }
}

fn note() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[tokio::test]
async fn a_note_written_on_one_device_reaches_the_other() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.title(&id).await.as_deref(), Some("Monday"));
    assert_eq!(phone.head(&id).await, mac.head(&id).await);
    assert_eq!(phone.cards(&id).await, 0);
}

#[tokio::test]
async fn a_stale_phones_deletion_after_the_macs_edit_deletes_everywhere_without_a_card() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    // The phone goes away. The Mac edits, and the service has that edit.
    mac.edit_note(&id, "Monday, revised").await;
    mac.sync(&key).await.unwrap();
    // The phone comes back and the person deletes the note before it caught
    // up. What the person did is the later decision.
    phone.delete_note(&id).await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.title(&id).await, None, "the Mac still has the note");
    assert_eq!(phone.title(&id).await, None);
    assert_eq!(mac.cards(&id).await, 0, "the Mac was asked to review");
    assert_eq!(phone.cards(&id).await, 0, "the phone was asked to review");
    let heads = service.heads(&id).await;
    assert_eq!(heads.len(), 1, "the service holds one head");
    assert!(heads[0].deleted);
    // Nothing is left to say about it on either side.
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.outbox(&id).await + phone.outbox(&id).await, 0);
}

#[tokio::test]
async fn two_devices_deleting_the_same_note_leave_one_tombstone_and_no_card() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    mac.delete_note(&id).await;
    phone.delete_note(&id).await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.cards(&id).await + phone.cards(&id).await, 0);
    assert_eq!(service.heads(&id).await.len(), 1);
    assert_eq!(
        service
            .revisions(&id)
            .await
            .iter()
            .filter(|r| r.deleted)
            .count(),
        1,
        "one deletion was enough"
    );
}

#[tokio::test]
async fn an_edit_not_yet_sent_keeps_a_card_on_the_device_that_holds_it_only() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    // The phone deletes and sends it. The Mac edits meanwhile, unsent.
    phone.delete_note(&id).await;
    phone.sync(&key).await.unwrap();
    mac.edit_note(&id, "Monday, kept").await;
    mac.sync(&key).await.unwrap();
    // The Mac holds work the phone never saw: that is a question for a
    // person, on the device that has the content.
    assert_eq!(mac.title(&id).await.as_deref(), Some("Monday, kept"));
    assert_eq!(mac.cards(&id).await, 1);
    // Answering it on the Mac converges both.
    let card: String =
        query("SELECT id FROM account_sync_conflicts WHERE resolved=0 AND object_id=?")
            .bind(&id)
            .fetch_one(&mac.pool)
            .await
            .unwrap()
            .get("id");
    resolve_in_store(&mac.pool, &mac.session, &key, &card, "use_remote")
        .await
        .unwrap();
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(mac.title(&id).await, None);
    assert_eq!(phone.title(&id).await, None);
    assert_eq!(mac.cards(&id).await + phone.cards(&id).await, 0);
    assert_eq!(service.heads(&id).await.len(), 1);
}

/// A revision as a newer build would write it: a column this build does not
/// know, under the same table.
fn unreadable_note(s: &Session, key: &[u8; 32], id: &str, parent: Option<String>) -> Value {
    let op = uuid::Uuid::new_v4().to_string();
    let body = json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":false,"table":"notes","row":{"id":id,"title":"From the future","mood_colour":"teal","created_at":"now","updated_at":"now"}});
    json!({"operation_id":op,"object_id":id,"parent_revision":parent,"kind":"note","ciphertext":crypto::seal(key,&aad(s,"note",id),&serde_json::to_vec(&body).unwrap()).unwrap(),"deleted":false})
}

#[tokio::test]
async fn an_unreadable_revision_is_parked_the_cursor_advances_and_applying_is_back_to_zero() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let (future, ordinary) = (note(), note());
    // The phone, on a newer build, writes a note this Mac cannot read, then
    // an ordinary one, then deletes the ordinary one.
    let op = unreadable_note(&phone.session, &key, &future, None);
    let data = call(
        &phone.session,
        reqwest::Method::POST,
        "/api/v1/sync",
        Some(json!({"operations":[op]})),
    )
    .await
    .unwrap();
    assert_eq!(data["results"].as_array().unwrap().len(), 1);
    phone.create_note(&ordinary, "Ordinary").await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(
        mac.title(&ordinary).await.as_deref(),
        Some("Ordinary"),
        "the stream froze on the unreadable revision"
    );
    assert_eq!(mac.title(&future).await, None);
    assert_eq!(mac.applying().await, 0, "applying was left set");
    assert_eq!(mac.cursor().await, 2);
    let parked = mac
        .count(
            "SELECT count(*) AS n FROM account_sync_issues WHERE lane='inbox' AND item_id<>?",
            "",
        )
        .await;
    assert_eq!(parked, 1);
    // A deletion decided on the phone still reaches the Mac.
    phone.delete_note(&ordinary).await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.title(&ordinary).await, None);
    assert_eq!(mac.cards(&ordinary).await, 0);
    // The Mac still writes: its triggers were not silenced.
    let own = note();
    mac.create_note(&own, "Still mine").await;
    assert_eq!(mac.outbox(&own).await, 1);
}

#[tokio::test]
async fn a_child_of_a_parked_revision_waits_instead_of_becoming_a_card() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    // A library with history: a fresh one would be handed the heads only,
    // and the parked parent would not be among them.
    mac.create_note(&note(), "Earlier").await;
    mac.sync(&key).await.unwrap();
    let id = note();
    let op = unreadable_note(&phone.session, &key, &id, None);
    let data = call(
        &phone.session,
        reqwest::Method::POST,
        "/api/v1/sync",
        Some(json!({"operations":[op]})),
    )
    .await
    .unwrap();
    let first = data["results"][0]["revision"].as_str().unwrap().to_string();
    // An ordinary edit of the same note, child of the unreadable one.
    let op2 = {
        let op = uuid::Uuid::new_v4().to_string();
        let body = json!({"v":1,"operation_id":op,"parent_revision":first,"deleted":false,"table":"notes","row":{"id":id,"title":"Readable again","created_at":"now","updated_at":"now"}});
        json!({"operation_id":op,"object_id":id,"parent_revision":first,"kind":"note","ciphertext":crypto::seal(&key,&aad(&phone.session,"note",&id),&serde_json::to_vec(&body).unwrap()).unwrap(),"deleted":false})
    };
    call(
        &phone.session,
        reqwest::Method::POST,
        "/api/v1/sync",
        Some(json!({"operations":[op2]})),
    )
    .await
    .unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(
        mac.cards(&id).await,
        0,
        "a child of a parked parent became a card"
    );
    assert_eq!(mac.title(&id).await, None);
    assert_eq!(
        mac.count(
            "SELECT count(*) AS n FROM account_sync_inbox WHERE applied=0 AND object_id=?",
            &id
        )
        .await,
        2
    );
    // Once the parked parent is retried (after an update that reads it, here
    // the issue is simply lifted and the parent is still unreadable), the
    // child keeps waiting rather than jumping ahead.
    retry_issues(&mac.pool).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.cards(&id).await, 0);
}

#[tokio::test]
async fn old_deletion_cards_are_settled_by_revision_order_and_the_head_moves_to_the_tombstone() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    mac.edit_note(&id, "Monday, revised").await;
    mac.sync(&key).await.unwrap();
    // The phone, behind a build that sent before receiving, pushed a
    // tombstone with a stale parent: the service holds two heads.
    let stale = mac.head(&id).await.unwrap();
    let parent: String = query("SELECT parent_revision FROM account_sync_inbox WHERE revision=?")
        .bind(&stale)
        .fetch_one(&mac.pool)
        .await
        .unwrap()
        .get("parent_revision");
    let op = uuid::Uuid::new_v4().to_string();
    let body = json!({"v":1,"operation_id":op,"parent_revision":parent,"deleted":true,"table":"notes","row":{"id":id}});
    let tomb = json!({"operation_id":op,"object_id":id,"parent_revision":parent,"kind":"note","ciphertext":crypto::seal(&key,&aad(&phone.session,"note",&id),&serde_json::to_vec(&body).unwrap()).unwrap(),"deleted":true});
    call(
        &phone.session,
        reqwest::Method::POST,
        "/api/v1/sync",
        Some(json!({"operations":[tomb]})),
    )
    .await
    .unwrap();
    assert_eq!(service.heads(&id).await.len(), 2);
    // And the Mac, on the old rule, wrote a card for it. Reproduce that card.
    let tombstone_revision = service
        .revisions(&id)
        .await
        .into_iter()
        .find(|r| r.deleted)
        .unwrap()
        .revision;
    query("INSERT INTO account_sync_conflicts(id,object_id,kind,ciphertext,parent_revision,operation_id,deleted,created_at,resolved_revisions) SELECT revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,'2026-10-01T00:00:00Z','[]' FROM account_sync_inbox WHERE revision=?")
        .bind(&tombstone_revision)
        .execute(&mac.pool)
        .await
        .ok();
    // The inbox row may not exist yet on the Mac: pull it as a card the old way.
    if mac.cards(&id).await == 0 {
        let data = call(
            &mac.session,
            reqwest::Method::GET,
            &format!("/api/v1/sync?after={}&limit=100", mac.cursor().await),
            None,
        )
        .await
        .unwrap();
        let change = data["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["deleted"] == true)
            .unwrap();
        query("INSERT INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,sequence,applied,resolved_revisions) VALUES(?,?,?,?,?,?,1,?,1,'[]')")
            .bind(change["revision"].as_str()).bind(&id).bind("note").bind(change["ciphertext"].as_str()).bind(change["parent_revision"].as_str()).bind(change["operation_id"].as_str()).bind(change["sequence"].as_i64())
            .execute(&mac.pool).await.unwrap();
        query("INSERT INTO account_sync_conflicts(id,object_id,kind,ciphertext,parent_revision,operation_id,deleted,created_at,resolved_revisions) VALUES(?,?,'note',?,?,?,1,'2026-10-01T00:00:00Z','[]')")
            .bind(change["revision"].as_str()).bind(&id).bind(change["ciphertext"].as_str()).bind(change["parent_revision"].as_str()).bind(change["operation_id"].as_str())
            .execute(&mac.pool).await.unwrap();
        query("UPDATE account_sync_control SET cursor=? WHERE id=1")
            .bind(data["cursor"].as_i64())
            .execute(&mac.pool)
            .await
            .unwrap();
    }
    assert_eq!(mac.cards(&id).await, 1);
    assert_eq!(mac.title(&id).await.as_deref(), Some("Monday, revised"));
    // The new rule settles it on the next pass: the deletion is later than
    // the head, nothing is unsent.
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.cards(&id).await, 0);
    assert_eq!(mac.title(&id).await, None);
    assert_eq!(
        mac.head(&id).await.as_deref(),
        Some(tombstone_revision.as_str())
    );
    assert_eq!(mac.outbox(&id).await, 0, "settling sent something");
}

#[tokio::test]
async fn a_recently_deleted_note_is_listed_and_restored_on_every_device() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    phone.delete_note(&id).await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(mac.title(&id).await, None);
    let listed = recently_deleted(&mac.pool, &mac.session, &key)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].object_id, id);
    assert_eq!(listed[0].title, "Monday");
    assert_eq!(listed[0].kind, "note");
    // The device that deleted it lists it too: the journal is the same.
    assert_eq!(
        recently_deleted(&phone.pool, &phone.session, &key)
            .await
            .unwrap()
            .len(),
        1
    );
    restore_deleted(&mac.pool, &mac.session, &key, &id)
        .await
        .unwrap();
    assert_eq!(mac.title(&id).await.as_deref(), Some("Monday"));
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(
        phone.title(&id).await.as_deref(),
        Some("Monday"),
        "the restore did not reach the phone"
    );
    assert_eq!(phone.cards(&id).await + mac.cards(&id).await, 0);
    assert_eq!(service.heads(&id).await.len(), 1);
    assert!(recently_deleted(&mac.pool, &mac.session, &key)
        .await
        .unwrap()
        .is_empty());
    assert!(recently_deleted(&phone.pool, &phone.session, &key)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_deleted_conversation_is_not_recreated_by_the_hermes_mirror() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    // The Mac mirrors a Hermes session into a portable conversation.
    let mut response = json!([{"role":"user","content":"Hello","id":"m1"},{"role":"assistant","content":"Hi","id":"m2"}]);
    super::super::conversations::mirror_history(
        &mac.pool,
        "account-one",
        "session-42",
        &mut response,
    )
    .await
    .unwrap();
    let task: String = query("SELECT id FROM agent_tasks WHERE hermes_session_id='session-42'")
        .fetch_one(&mac.pool)
        .await
        .unwrap()
        .get("id");
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(
        phone
            .count("SELECT count(*) AS n FROM agent_tasks WHERE id=?", &task)
            .await,
        1
    );
    // The phone deletes the conversation.
    for sql in [
        "DELETE FROM agent_messages WHERE task_id=?",
        "DELETE FROM agent_tasks WHERE id=?",
    ] {
        query(sql).bind(&task).execute(&phone.pool).await.unwrap();
    }
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(
        mac.count("SELECT count(*) AS n FROM agent_tasks WHERE id=?", &task)
            .await,
        0
    );
    // The desktop runtime still has the session; reading it again must not
    // bring the conversation back.
    let mut again = json!([{"role":"user","content":"Hello","id":"m1"},{"role":"assistant","content":"Hi","id":"m2"}]);
    super::super::conversations::mirror_history(&mac.pool, "account-one", "session-42", &mut again)
        .await
        .unwrap();
    assert_eq!(
        mac.count("SELECT count(*) AS n FROM agent_tasks WHERE id=?", &task)
            .await,
        0
    );
    assert_eq!(mac.outbox(&task).await, 0);
    // And the runtime is asked to forget it.
    assert_eq!(mac.count("SELECT count(*) AS n FROM account_sync_removed_files WHERE lane='hermes-session' AND path=?", "session-42").await, 1);
}

#[tokio::test]
async fn a_hundred_rows_leave_in_two_posts_in_outbox_order() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let ids: Vec<String> = (0..100).map(|_| note()).collect();
    for (i, id) in ids.iter().enumerate() {
        mac.create_note(id, &format!("Note {i}")).await;
    }
    let before = service.posts().await;
    let summary = mac.sync(&key).await.unwrap();
    assert_eq!(summary.pushed, 100);
    assert_eq!(
        service.posts().await - before,
        2,
        "a hundred rows cost more than two trips"
    );
    // Sequence order on the service is outbox order.
    let mut last = 0;
    for id in &ids {
        let revisions = service.revisions(id).await;
        assert_eq!(revisions.len(), 1);
        assert!(revisions[0].sequence > last);
        last = revisions[0].sequence;
    }
    phone.sync(&key).await.unwrap();
    assert_eq!(phone.title(&ids[99]).await.as_deref(), Some("Note 99"));
    assert_eq!(
        mac.count(
            "SELECT count(*) AS n FROM account_sync_outbox WHERE object_id<>?",
            ""
        )
        .await,
        0
    );
}

#[tokio::test]
async fn a_refused_batch_falls_back_one_by_one_and_parks_only_the_refused_row() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let mac = device(&service, "mac").await;
    let (good, bad, other) = (note(), note(), note());
    mac.create_note(&good, "Good").await;
    mac.create_note(&bad, "Bad").await;
    mac.create_note(&other, "Other").await;
    // One row already sealed against a parent the service never saw.
    query("UPDATE account_sync_outbox SET ciphertext='x',parent_revision=? WHERE object_id=?")
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(&bad)
        .execute(&mac.pool)
        .await
        .unwrap();
    let before = service.posts().await;
    let summary = mac.sync(&key).await.unwrap();
    assert_eq!(summary.pushed, 2);
    // One batch refused, then one request per row.
    assert_eq!(service.posts().await - before, 4);
    assert_eq!(service.revisions(&good).await.len(), 1);
    assert_eq!(service.revisions(&other).await.len(), 1);
    assert_eq!(service.revisions(&bad).await.len(), 0);
    let parked = issues(&mac.pool).await.unwrap();
    assert_eq!(parked.len(), 1);
    assert_eq!(parked[0].code, "sync_parent_unknown");
    // Retried, the row is sealed again against the current head and leaves.
    retry_issues(&mac.pool).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(service.revisions(&bad).await.len(), 1);
    assert_eq!(mac.outbox(&bad).await, 0);
}

#[tokio::test]
async fn the_wait_answers_at_once_after_an_append_and_otherwise_times_out() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    mac.create_note(&note(), "First").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    let cursor = phone.cursor().await;
    // Nothing new: the wait holds for the service's window, then says so.
    let started = std::time::Instant::now();
    let answer = request_within(
        &phone.session.base,
        Some(&phone.session.token),
        reqwest::Method::GET,
        &format!("/api/v1/sync/wait?after={cursor}"),
        None,
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert_eq!(answer["changed"], false);
    assert!(started.elapsed() >= Duration::from_secs(1));
    // Something new on the Mac: the wait returns within the second.
    let waiting = {
        let s = Session {
            base: phone.session.base.clone(),
            account: phone.session.account.clone(),
            token: Redacted::new("phone".into()),
        };
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let answer = request_within(
                &s.base,
                Some(&s.token),
                reqwest::Method::GET,
                &format!("/api/v1/sync/wait?after={cursor}"),
                None,
                Duration::from_secs(30),
            )
            .await
            .unwrap();
            (answer, started.elapsed())
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    mac.create_note(&note(), "Second").await;
    mac.sync(&key).await.unwrap();
    let (answer, elapsed) = waiting.await.unwrap();
    assert_eq!(answer["changed"], true);
    assert!(
        elapsed < Duration::from_secs(1),
        "the wait took {elapsed:?}"
    );
    // An older service answers 404, which the client reads as "not offered".
    service.journal.lock().await.without_wait = true;
    let refused = request_within(
        &phone.session.base,
        Some(&phone.session.token),
        reqwest::Method::GET,
        &format!("/api/v1/sync/wait?after={cursor}"),
        None,
        Duration::from_secs(30),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, "vault_not_found");
}

#[tokio::test]
async fn a_fresh_library_is_handed_the_heads_and_ends_with_the_same_rows() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let mac = device(&service, "mac").await;
    let (kept, edited, deleted) = (note(), note(), note());
    mac.create_note(&kept, "Kept").await;
    mac.create_note(&edited, "Edited once").await;
    mac.create_note(&deleted, "Deleted").await;
    mac.sync(&key).await.unwrap();
    mac.edit_note(&edited, "Edited twice").await;
    mac.sync(&key).await.unwrap();
    mac.edit_note(&edited, "Edited thrice").await;
    mac.delete_note(&deleted).await;
    mac.sync(&key).await.unwrap();
    assert_eq!(service.journal.lock().await.revisions.len(), 6);
    // A new phone: heads, plus the live revision a tombstone retired.
    let phone = device(&service, "phone").await;
    let summary = phone.sync(&key).await.unwrap();
    assert_eq!(phone.title(&kept).await.as_deref(), Some("Kept"));
    assert_eq!(phone.title(&edited).await.as_deref(), Some("Edited thrice"));
    assert_eq!(phone.title(&deleted).await, None);
    assert_eq!(
        phone
            .count(
                "SELECT count(*) AS n FROM account_sync_inbox WHERE object_id<>?",
                ""
            )
            .await,
        4,
        "the phone received history, not heads"
    );
    assert!(summary.applied >= 3);
    assert_eq!(phone.cursor().await, 6);
    // And it can still list what was deleted.
    let listed = recently_deleted(&phone.pool, &phone.session, &key)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title, "Deleted");
}

#[tokio::test]
async fn a_row_the_service_refuses_with_400_is_parked_and_the_rows_behind_it_leave() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let mac = device(&service, "mac").await;
    let (bad, after) = (note(), note());
    mac.create_note(&bad, "Bad").await;
    mac.create_note(&after, "After").await;
    // A row sealed with more acknowledgements than the service takes.
    let too_many = json!((0..65)
        .map(|_| uuid::Uuid::now_v7().to_string())
        .collect::<Vec<_>>())
    .to_string();
    query("UPDATE account_sync_outbox SET ciphertext='x',resolved_revisions=? WHERE object_id=?")
        .bind(&too_many)
        .bind(&bad)
        .execute(&mac.pool)
        .await
        .unwrap();
    let summary = mac.sync(&key).await.unwrap();
    assert_eq!(summary.pushed, 1);
    assert_eq!(
        service.revisions(&after).await.len(),
        1,
        "the row behind the refused one was held back"
    );
    let parked = issues(&mac.pool).await.unwrap();
    assert_eq!(parked.len(), 1);
    assert_eq!(parked[0].code, "sync_request_refused");
    // The next pass does not stall on it either.
    let summary = mac.sync(&key).await.unwrap();
    assert_eq!(summary.pushed, 0);
    // Retried, it is sealed again from its body and leaves.
    retry_issues(&mac.pool).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(service.revisions(&bad).await.len(), 1);
}

#[tokio::test]
async fn two_deletions_crossing_a_failed_push_still_settle_without_a_card() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    // The Mac deletes; its tombstone is sealed but the push fails.
    mac.delete_note(&id).await;
    service.journal.lock().await.refuse_posts = true;
    assert!(mac.sync(&key).await.is_err());
    service.journal.lock().await.refuse_posts = false;
    assert_eq!(mac.count("SELECT count(*) AS n FROM account_sync_outbox WHERE object_id=? AND ciphertext IS NOT NULL", &id).await, 1);
    // The phone deletes too and sends it first.
    phone.delete_note(&id).await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    assert_eq!(
        mac.cards(&id).await + phone.cards(&id).await,
        0,
        "a deletion both devices made was left for review"
    );
    assert_eq!(mac.title(&id).await, None);
    assert_eq!(mac.outbox(&id).await + phone.outbox(&id).await, 0);
}

#[tokio::test]
async fn a_remote_edit_over_a_parked_local_edit_is_kept_for_review_not_applied() {
    let service = Service::start().await;
    let key = crypto::random_key();
    let (mac, phone) = (
        device(&service, "mac").await,
        device(&service, "phone").await,
    );
    let id = note();
    mac.create_note(&id, "Monday").await;
    mac.sync(&key).await.unwrap();
    phone.sync(&key).await.unwrap();
    // The Mac's next edit is parked (too large, say); the phone edits too.
    mac.edit_note(&id, "Monday, Mac").await;
    let op: String = query("SELECT operation_id FROM account_sync_outbox WHERE object_id=?")
        .bind(&id)
        .fetch_one(&mac.pool)
        .await
        .unwrap()
        .get("operation_id");
    record_issue(&mac.pool, "outbox", &op, "sync_object_too_large")
        .await
        .unwrap();
    phone.edit_note(&id, "Monday, phone").await;
    phone.sync(&key).await.unwrap();
    mac.sync(&key).await.unwrap();
    assert_eq!(
        mac.title(&id).await.as_deref(),
        Some("Monday, Mac"),
        "the parked edit was written over"
    );
    assert_eq!(mac.cards(&id).await, 1);
}

#[tokio::test]
async fn a_library_with_sync_off_reports_no_local_work() {
    let service = Service::start().await;
    let mac = device(&service, "mac").await;
    mac.create_note(&note(), "Local").await;
    assert!(has_local_work(&mac.pool).await.unwrap());
    set_enabled(&mac.pool, false).await.unwrap();
    assert!(!has_local_work(&mac.pool).await.unwrap());
}

#[path = "sync_storage_tests.rs"]
mod storage_tests;
