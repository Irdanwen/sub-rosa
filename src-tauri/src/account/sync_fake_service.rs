//! A journal service in memory behind a real socket, for tests that put two
//! devices on either side of one. It mirrors what the account service does
//! with a push and a pull (`subrosa-cloud/crates/persistence`): one sequence
//! per account, heads per object, a sibling head when a parent is stale,
//! idempotent operation ids, pages, the heads-only bootstrap and the long
//! wait. Nothing here is cryptographic: ciphertext is carried as given.
use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};

#[derive(Clone, Debug)]
pub(super) struct Revision {
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
pub(super) struct Journal {
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
}

pub(super) struct Service {
    pub base: String,
    pub journal: Arc<Mutex<Journal>>,
    pub changed: Arc<Notify>,
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
        Service {
            base,
            journal,
            changed,
        }
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
    pub async fn gets(&self) -> usize {
        self.journal.lock().await.gets
    }
}

async fn serve(mut stream: tokio::net::TcpStream, journal: Arc<Mutex<Journal>>, changed: Arc<Notify>) {
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
                            if code == "conflict" {
                                "409 Conflict"
                            } else {
                                "400 Bad Request"
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
            let after: i64 = params.get("after").and_then(|v| v.parse().ok()).unwrap_or(0);
            let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(100);
            let heads = params.get("heads").is_some_and(|v| v == "1") && !j.without_heads;
            match changes(&j, after, limit, params.get("kind").map(String::as_str), heads) {
                Ok(page) => ("200 OK", Ok(page)),
                Err(code) => ("400 Bad Request", Err(code)),
            }
        }
        ("GET", "/api/v1/sync/wait") => {
            let after: i64 = params.get("after").and_then(|v| v.parse().ok()).unwrap_or(0);
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
                    Some(
                        tokio::time::timeout(wait_for, notified)
                            .await
                            .is_ok(),
                    )
                };
                match changed {
                    None => ("400 Bad Request", Err("invalid_request")),
                    Some(changed) => ("200 OK", Ok(json!({"changed":changed}))),
                }
            }
        }
        _ => ("404 Not Found", Err("not_found")),
    };
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

fn append(j: &mut Journal, ops: &[Value], device: Option<String>) -> Result<Vec<Value>, &'static str> {
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
    // The whole batch is one transaction: work on a copy, keep it on success.
    let mut revisions = j.revisions.clone();
    let mut next = j.next_sequence;
    let mut results = Vec::new();
    for op in ops {
        let operation_id = op["operation_id"].as_str().ok_or("invalid_request")?.to_string();
        let object_id = op["object_id"].as_str().ok_or("invalid_request")?.to_string();
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
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
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
        let conflict = revisions
            .iter()
            .any(|r| r.object_id == object_id && r.is_head && !acknowledged.contains(&r.revision));
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
    Ok(results)
}

fn changes(j: &Journal, after: i64, limit: i64, kind: Option<&str>, heads: bool) -> Result<Value, &'static str> {
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
