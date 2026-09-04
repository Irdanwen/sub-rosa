//! What left the machine: the promise kept, not only stated.
//!
//! Settings › Privacy shows the hosts this binary can reach and why
//! (`egress::declared_egress`, held by `tests/egress.rs`). That is the
//! promise as a sentence. This ledger is the promise as a record: one row per
//! outbound request, written by the process that sent it, with the host, the
//! purpose, the byte counts, the status, the duration and the model, so a
//! person can read what went where and when without taking anyone's word.
//!
//! Shapes, never contents. The prompt, the audio and the reply are not here,
//! by design: the ledger has to be safe to show on a screen and safe to leave
//! on disk, and a byte count already says what a person wants to know.
//!
//! Writes never block a request. `record` pushes into a bounded buffer from
//! any thread; a flusher started at setup drains it into `egress_ledger`
//! every few seconds. A request the buffer could not hold is a lost row, not a
//! failed request, and the row says so through `dropped`.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use crate::domain::types::AppError;

/// One outbound request, as the ledger keeps it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EgressEntry {
    pub at: String,
    pub host: String,
    pub purpose: String,
    pub method: String,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub status: Option<u16>,
    pub duration_ms: u64,
    pub model: Option<String>,
    pub note_id: Option<String>,
}

const BUFFER_CAP: usize = 2_000;
const FLUSH_EVERY: Duration = Duration::from_secs(4);
/// Rows older than this are pruned at launch. The count is the point.
pub const RETENTION_DAYS: i64 = 90;

struct Buffer {
    entries: VecDeque<EgressEntry>,
    dropped: u64,
}

fn buffer() -> &'static Mutex<Buffer> {
    static BUFFER: OnceLock<Mutex<Buffer>> = OnceLock::new();
    BUFFER.get_or_init(|| {
        Mutex::new(Buffer {
            entries: VecDeque::new(),
            dropped: 0,
        })
    })
}

/// The purpose a person reads for a request path. The paths are the sidecar's
/// `/v1/*` contract and the fork's direct calls; anything unknown keeps its
/// path, which is still more honest than "other".
pub fn purpose_for_path(path: &str) -> String {
    let path = path.split('?').next().unwrap_or(path);
    let purpose = match path {
        p if p.contains("/audio/transcriptions") => "transcription",
        p if p.contains("/chat/completions") => "chat",
        p if p.contains("/embeddings") => "embeddings",
        p if p.contains("/notes/generate") || p.contains("/generate") => "note generation",
        p if p.contains("/dictate") || p.contains("/cleanup") => "dictation",
        p if p.contains("/image") => "image",
        p if p.contains("/video") => "video",
        p if p.contains("/audio/speech") || p.contains("/tts") => "speech",
        p if p.contains("/music") || p.contains("/sfx") => "sound",
        p if p.contains("/models") || p.contains("/pricing") => "catalog",
        p if p.contains("/credits") || p.contains("/billing") => "credits",
        p if p.contains("/places") => "places",
        p if p.contains("/web") => "web",
        p if p.contains("/issues") => "report",
        p if p.contains("/livez") || p.contains("/healthz") => "health",
        _ => "",
    };
    if purpose.is_empty() {
        path.trim_start_matches('/').to_string()
    } else {
        purpose.to_string()
    }
}

/// Push one row. Never blocks for long, never fails the caller.
pub fn record(entry: EgressEntry) {
    if let Ok(mut buffer) = buffer().lock() {
        if buffer.entries.len() >= BUFFER_CAP {
            buffer.entries.pop_front();
            buffer.dropped = buffer.dropped.saturating_add(1);
        }
        buffer.entries.push_back(entry);
    }
}

/// Take everything buffered so far.
pub fn drain() -> (Vec<EgressEntry>, u64) {
    match buffer().lock() {
        Ok(mut buffer) => {
            let dropped = std::mem::take(&mut buffer.dropped);
            (buffer.entries.drain(..).collect(), dropped)
        }
        Err(_) => (Vec::new(), 0),
    }
}

/// Start the flusher: prune what is older than the retention, then drain the
/// buffer into the table every few seconds for the life of the process.
pub fn spawn_flusher(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(repos) = crate::commands::repositories(&app).await {
            let cutoff = (chrono::Utc::now() - chrono::Duration::days(RETENTION_DAYS)).to_rfc3339();
            let _ = repos.prune_egress_ledger(&cutoff).await;
        }
        loop {
            tokio::time::sleep(FLUSH_EVERY).await;
            let (entries, dropped) = drain();
            if entries.is_empty() && dropped == 0 {
                continue;
            }
            let Ok(repos) = crate::commands::repositories(&app).await else {
                continue;
            };
            if let Err(error) = repos.insert_egress_entries(&entries).await {
                tracing::warn!(error = %error, "could not write the egress ledger");
            }
            if dropped > 0 {
                tracing::warn!(dropped, "egress ledger rows were dropped under load");
            }
        }
    });
}

/// A stored row, as the screen reads it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EgressRow {
    pub id: i64,
    #[serde(flatten)]
    pub entry: EgressEntry,
}

/// Totals over a window, for the sentence above the timeline.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EgressSummary {
    pub requests: u64,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub hosts: Vec<String>,
    pub purposes: Vec<(String, u64)>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressLedgerRequest {
    /// Rows to return, newest first (the screen pages by asking for more).
    pub limit: Option<i64>,
    /// Only rows about this note.
    pub note_id: Option<String>,
    /// The summary window, in days; default 7.
    pub days: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressLedgerResponse {
    pub rows: Vec<EgressRow>,
    pub summary: EgressSummary,
    pub retention_days: i64,
}

#[tauri::command]
pub async fn egress_ledger(
    app: AppHandle,
    request: EgressLedgerRequest,
) -> Result<EgressLedgerResponse, AppError> {
    // Show what is buffered too: a request made two seconds ago should be
    // on the screen that claims to list every request.
    let (pending, _) = drain();
    let repos = crate::commands::repositories(&app).await?;
    if !pending.is_empty() {
        repos.insert_egress_entries(&pending).await?;
    }
    let days = request.days.unwrap_or(7).clamp(1, RETENTION_DAYS);
    let since = (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339();
    let rows = repos
        .list_egress_ledger(
            request.limit.unwrap_or(100).clamp(1, 1000),
            request.note_id.as_deref(),
        )
        .await?;
    let summary = repos.summarize_egress_ledger(&since).await?;
    Ok(EgressLedgerResponse {
        rows,
        summary,
        retention_days: RETENTION_DAYS,
    })
}

#[cfg(test)]
mod tests {
    use super::{drain, purpose_for_path, record, EgressEntry};

    fn entry(host: &str) -> EgressEntry {
        EgressEntry {
            at: "2026-09-03T08:00:00Z".into(),
            host: host.into(),
            purpose: "chat".into(),
            method: "POST".into(),
            request_bytes: 10,
            response_bytes: 20,
            status: Some(200),
            duration_ms: 5,
            model: None,
            note_id: None,
        }
    }

    #[test]
    fn purposes_read_as_words_and_unknown_paths_keep_their_name() {
        assert_eq!(purpose_for_path("/v1/chat/completions"), "chat");
        assert_eq!(
            purpose_for_path("/v1/audio/transcriptions?x=1"),
            "transcription"
        );
        assert_eq!(purpose_for_path("/v1/embeddings"), "embeddings");
        assert_eq!(purpose_for_path("/v1/models"), "catalog");
        assert_eq!(purpose_for_path("/something/odd"), "something/odd");
    }

    #[test]
    fn the_buffer_keeps_the_newest_and_counts_what_it_dropped() {
        let _ = drain();
        for index in 0..super::BUFFER_CAP + 5 {
            record(entry(&format!("h{index}")));
        }
        let (entries, dropped) = drain();
        assert_eq!(entries.len(), super::BUFFER_CAP);
        assert_eq!(dropped, 5);
        assert_eq!(entries.last().map(|e| e.host.as_str()), Some("h2004"));
        assert!(drain().0.is_empty());
    }
}
