//! What the app can say about itself.
//!
//! Three questions a person asks a desktop app sooner or later, none of which
//! this one could answer until 2026-09-03:
//!
//! - *What works here?* Windows has no HUD, no global dictation, no Spotlight,
//!   no calendar; iPhone has no agent runtime. The shell used to know that
//!   through `cfg` gates scattered over a hundred sites and the webview
//!   through `navigator.platform`. [`platform_capabilities`] is the one map
//!   both read, computed where the truth is: in the binary that was compiled.
//! - *How much room does this take?* Five gigabytes of agent workspace, a
//!   305 MB runtime database and six hundred megabytes of recordings sat in
//!   the data directory with no view and no retention. [`storage_report`]
//!   measures the buckets; [`purge_transcribed_recordings`] is the one action
//!   that is safe to offer, because a transcribed note keeps its words.
//! - *What do I attach to a bug report?* Reports (ADR-0036) could name a file
//!   and never carry one. [`export_diagnostics`] writes a dated folder the
//!   user chooses in the native dialog (no path crosses IPC, see
//!   `tests/ipc_write_paths.rs`): the logs' tails, versions, the backend's
//!   state, the egress list, the capability map, the storage report. Every
//!   byte goes through [`redact`] first, and `tests/diagnostics.rs` proves a
//!   key planted in a log does not come out the other side.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::domain::types::AppError;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Milestones of this launch, in milliseconds since the first mark. The
/// first call sets the clock; each label is recorded once so a repeated
/// milestone (a sidecar restart) does not rewrite the launch story.
type Marks = Mutex<Vec<(String, u64)>>;
static STARTUP: OnceLock<(Instant, Marks)> = OnceLock::new();

/// Record a startup milestone. Cheap enough to call from anywhere.
pub fn mark(label: &str) {
    let (start, marks) = STARTUP.get_or_init(|| (Instant::now(), Mutex::new(Vec::new())));
    let elapsed = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    if let Ok(mut marks) = marks.lock() {
        if marks.iter().any(|(known, _)| known == label) {
            return;
        }
        tracing::info!("startup: {label} at {elapsed} ms");
        marks.push((label.to_string(), elapsed));
    }
}

/// The milestones recorded so far, in order.
pub fn startup_marks() -> Vec<(String, u64)> {
    STARTUP
        .get()
        .and_then(|(_, marks)| marks.lock().ok().map(|marks| marks.clone()))
        .unwrap_or_default()
}

/// What this build of the app can do on this platform. `false` is a fact,
/// not a failure: the settings screens replace a dead control with a
/// sentence, and the diagnostics bundle records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    /// A name the webview can show ("macOS", "Windows", "iOS").
    pub platform: &'static str,
    /// System-audio capture through the out-of-process helper (ADR-0004).
    pub system_audio: bool,
    /// The floating dictation / meeting / agent HUD windows.
    pub hud: bool,
    /// A global dictation shortcut that works in other apps.
    pub dictation_hotkey: bool,
    /// Notes indexed in the system search.
    pub spotlight: bool,
    /// Calendar context on a note (ADR-0025).
    pub calendar: bool,
    /// "A meeting seems to have started" from the microphone-in-use signal.
    pub meeting_detection: bool,
    /// The system share sheet.
    pub share: bool,
    /// The embedded agent runtime (Hermes); the phone runs agent-lite instead.
    pub hermes_agent: bool,
    /// Self-update through the Tauri updater.
    pub updater: bool,
}

/// The map for the platform this binary was compiled for.
pub const fn capabilities() -> PlatformCapabilities {
    #[cfg(target_os = "macos")]
    {
        PlatformCapabilities {
            platform: "macOS",
            system_audio: true,
            hud: true,
            dictation_hotkey: true,
            spotlight: true,
            calendar: true,
            meeting_detection: true,
            share: false,
            hermes_agent: true,
            updater: true,
        }
    }
    #[cfg(target_os = "ios")]
    {
        PlatformCapabilities {
            platform: "iOS",
            system_audio: false,
            hud: false,
            dictation_hotkey: false,
            spotlight: true,
            calendar: false,
            meeting_detection: false,
            share: true,
            hermes_agent: false,
            updater: false,
        }
    }
    #[cfg(target_os = "windows")]
    {
        PlatformCapabilities {
            platform: "Windows",
            system_audio: false,
            hud: false,
            dictation_hotkey: false,
            spotlight: false,
            calendar: false,
            meeting_detection: false,
            share: false,
            hermes_agent: true,
            updater: true,
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    {
        PlatformCapabilities {
            platform: "Linux",
            system_audio: false,
            hud: false,
            dictation_hotkey: false,
            spotlight: false,
            calendar: false,
            meeting_detection: false,
            share: false,
            hermes_agent: false,
            updater: false,
        }
    }
}

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    capabilities()
}

/// One thing on disk the app is responsible for, measured.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageBucket {
    pub id: &'static str,
    pub label: &'static str,
    /// Plain language: what is in it and whether the app may touch it.
    pub note: &'static str,
    pub bytes: u64,
    pub files: u64,
    /// Whether [`purge_transcribed_recordings`] applies to this bucket.
    pub purgeable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub buckets: Vec<StorageBucket>,
    pub total_bytes: u64,
    pub measured_at: String,
}

/// The buckets, in the order the screen lists them, with the path each one
/// measures relative to the data directory (or the log directory).
fn bucket_specs() -> Vec<(
    &'static str,
    &'static str,
    &'static str,
    &'static [&'static str],
    bool,
)> {
    vec![
        (
            "database",
            "Notes, transcripts and memories",
            "The SQLite database: everything you wrote, said and were told.",
            &["notes.sqlite3", "notes.sqlite3-wal", "notes.sqlite3-shm"],
            false,
        ),
        (
            "recordings",
            "Recordings",
            "The audio behind your notes. A transcribed note keeps its words without it.",
            &["recordings"],
            true,
        ),
        (
            "studio-media",
            "Studio gallery",
            "Images, clips and sound the Studio produced.",
            &["studio-media"],
            false,
        ),
        (
            "agent-workspace",
            "Agent workspace",
            "Files the agent made or was given. Yours; the app never deletes them.",
            &["hermes/workspace"],
            false,
        ),
        (
            "agent-state",
            "Agent sessions and state",
            "The agent runtime's own database, sessions and logs.",
            &[
                "hermes/state.db",
                "hermes/sessions",
                "hermes/logs",
                "hermes/images",
            ],
            false,
        ),
        (
            "agent-runtime",
            "Agent runtime",
            "The installed runtime and its tools; reinstalled by the app when needed.",
            &[
                "hermes-runtime",
                "hermes/bin",
                "hermes/node",
                "hermes/skills",
                "hermes-mcp",
            ],
            false,
        ),
        (
            "logs",
            "Logs",
            "The backend and dictation logs, capped and rotated by the app.",
            &["dictation-events.log"],
            false,
        ),
    ]
}

/// Bytes and files under a path, following no symlinks, never failing: a
/// directory that vanishes mid-walk counts what it had.
pub fn measure(path: &Path) -> (u64, u64) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return (0, 0);
    };
    if meta.is_file() {
        return (meta.len(), 1);
    }
    if !meta.is_dir() {
        return (0, 0);
    }
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut stack = vec![path.to_path_buf()];
    // A ceiling on the walk so a runaway tree cannot pin the app; the report
    // says "at least" through the count, which is enough for a settings screen.
    let mut visited = 0u32;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 400_000 {
                return (bytes, files);
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                bytes = bytes.saturating_add(meta.len());
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// The report for a data directory and a log directory; pure so a test can
/// hand it a temporary tree.
pub fn storage_report_for(data_dir: &Path, log_dir: Option<&Path>) -> StorageReport {
    let mut buckets = Vec::new();
    let mut total = 0u64;
    for (id, label, note, paths, purgeable) in bucket_specs() {
        let mut bytes = 0u64;
        let mut files = 0u64;
        for rel in paths {
            let (b, f) = measure(&data_dir.join(rel));
            bytes += b;
            files += f;
        }
        if id == "logs" {
            if let Some(log_dir) = log_dir {
                let (b, f) = measure(log_dir);
                bytes += b;
                files += f;
            }
        }
        total += bytes;
        buckets.push(StorageBucket {
            id,
            label,
            note,
            bytes,
            files,
            purgeable,
        });
    }
    StorageReport {
        buckets,
        total_bytes: total,
        measured_at: chrono::Utc::now().to_rfc3339(),
    }
}

#[tauri::command]
pub async fn storage_report(app: AppHandle) -> Result<StorageReport, AppError> {
    let data_dir = crate::app_paths::app_data_dir(&app)
        .map_err(|error| AppError::new("storage_report_failed", error.to_string()))?;
    let log_dir = app.path().app_log_dir().ok();
    tauri::async_runtime::spawn_blocking(move || storage_report_for(&data_dir, log_dir.as_deref()))
        .await
        .map_err(|error| AppError::new("storage_report_failed", error.to_string()))
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeRecordingsRequest {
    /// Recordings older than this are eligible. Never less than one day.
    pub older_than_days: u32,
    /// When true, nothing is deleted: the response says what would be.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PurgeRecordingsResult {
    pub recordings: u64,
    pub bytes: u64,
    pub dry_run: bool,
}

/// Delete the audio of notes that are done with it.
///
/// Eligible: an artifact older than the cutoff, on a note whose processing
/// reached `ready`, that has at least one transcript row of its own, and
/// that was not purged already. The rows stay (the transcript references
/// them and the timeline still knows the durations); the file goes, through
/// the confined recording-file remover, and the artifact records when.
#[tauri::command]
pub async fn purge_transcribed_recordings(
    app: AppHandle,
    request: PurgeRecordingsRequest,
) -> Result<PurgeRecordingsResult, AppError> {
    let days = request.older_than_days.max(1);
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(i64::from(days))).to_rfc3339();
    let repos = crate::commands::repositories(&app).await?;
    let candidates = repos.purgeable_recordings(&cutoff).await?;
    let paths = crate::commands::app_paths(&app)?;
    let mut removed = 0u64;
    let mut bytes = 0u64;
    for candidate in candidates {
        if request.dry_run {
            removed += 1;
            bytes = bytes.saturating_add(candidate.size_bytes.max(0) as u64);
            continue;
        }
        match paths.remove_recording_file(&candidate.path) {
            Ok(()) => {
                repos
                    .mark_audio_artifact_purged(&candidate.artifact_id)
                    .await?;
                removed += 1;
                bytes = bytes.saturating_add(candidate.size_bytes.max(0) as u64);
            }
            Err(error) => {
                tracing::warn!(artifact = %candidate.artifact_id, error = %error, "could not remove a recording");
            }
        }
    }
    Ok(PurgeRecordingsResult {
        recordings: removed,
        bytes,
        dry_run: request.dry_run,
    })
}

/// Strip what must never leave the machine in a bundle: Carpe Diem keys,
/// bearer tokens, GitHub tokens, and anything that looks like an
/// `Authorization` header value. Deliberately broad; a diagnostic that lost a
/// token-shaped word is still a diagnostic.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        out.push_str(&redact_line(line));
        out.push('\n');
    }
    out
}

fn redact_line(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut rest = line;
    while !rest.is_empty() {
        let candidates = [
            find_token(rest, "cdm_"),
            find_token(rest, "ghp_"),
            find_token(rest, "github_pat_"),
            find_token(rest, "sk-"),
            find_after(rest, "Bearer "),
            find_after(rest, "bearer "),
            find_after(rest, "token="),
            find_after(rest, "api_key="),
        ];
        let Some((start, end)) = candidates
            .into_iter()
            .flatten()
            .min_by_key(|(start, _)| *start)
        else {
            result.push_str(rest);
            break;
        };
        result.push_str(&rest[..start]);
        result.push_str("[redacted]");
        rest = &rest[end..];
    }
    result
}

/// A token that starts with `prefix` and runs to the next non-token byte.
fn find_token(text: &str, prefix: &str) -> Option<(usize, usize)> {
    let start = text.find(prefix)?;
    let end = start
        + text[start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(text.len() - start);
    Some((start, end))
}

/// The word after a marker such as `Bearer ` or `token=`, keeping the marker.
fn find_after(text: &str, marker: &str) -> Option<(usize, usize)> {
    let at = text.find(marker)?;
    let start = at + marker.len();
    let end = start
        + text[start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '&' || c == ',')
            .unwrap_or(text.len() - start);
    if end <= start {
        return None;
    }
    Some((start, end))
}

/// The last `max_bytes` of a text file, redacted; an absent file is a line
/// saying so, because "no log" is itself a finding.
pub fn log_tail(path: &Path, max_bytes: u64) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return format!("(no file at {})\n", path.display());
    };
    let start = bytes.len().saturating_sub(max_bytes as usize);
    let slice = &bytes[start..];
    let text = String::from_utf8_lossy(slice);
    redact(&text)
}

/// Everything a bundle is made of, gathered by the command and written by
/// [`write_bundle`], which is the part a test can drive with its own paths.
pub struct BundleInputs {
    pub report: String,
    pub logs: Vec<(String, PathBuf)>,
}

const LOG_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// Write the bundle into `dest` (created if needed). Returns the files written.
pub fn write_bundle(dest: &Path, inputs: &BundleInputs) -> std::io::Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dest)?;
    let mut written = Vec::new();
    let report_path = dest.join("report.md");
    std::fs::write(&report_path, redact(&inputs.report))?;
    written.push(report_path);
    for (name, path) in &inputs.logs {
        let target = dest.join(name);
        std::fs::write(&target, log_tail(path, LOG_TAIL_BYTES))?;
        written.push(target);
    }
    Ok(written)
}

/// The report's text: what a maintainer reads first.
pub fn report_text(app: &AppHandle) -> String {
    let caps = capabilities();
    let version = app.package_info().version.to_string();
    let mut out = String::new();
    out.push_str("# Sub Rosa diagnostics\n\n");
    out.push_str(&format!("- Version: {version}\n"));
    out.push_str(&format!("- Platform: {}\n", caps.platform));
    out.push_str(&format!("- Written: {}\n", chrono::Utc::now().to_rfc3339()));
    out.push_str(&format!(
        "- Carpe Diem base: {}\n",
        host_only(&crate::carpe_diem::settings::base_url())
    ));
    out.push_str(&format!(
        "- API key stored: {}\n\n",
        crate::carpe_diem::settings::api_key().is_some()
    ));
    out.push_str("## Local backend\n\n");
    match crate::carpe_diem::sidecar::status_for_diagnostics(app) {
        Some(status) => out.push_str(&format!("{status}\n\n")),
        None => out.push_str("(not available)\n\n"),
    }
    out.push_str("## Startup\n\n");
    for (label, ms) in startup_marks() {
        out.push_str(&format!("- {label}: {ms} ms\n"));
    }
    out.push('\n');
    out.push_str("## Capabilities\n\n");
    out.push_str(&format!(
        "{}\n\n",
        serde_json::to_string_pretty(&caps).unwrap_or_default()
    ));
    out.push_str("## Hosts this build may reach\n\n");
    for host in crate::egress::declared_egress() {
        out.push_str(&format!(
            "- {} ({:?}): {}\n",
            host.host, host.reach, host.reason
        ));
    }
    out.push('\n');
    if let Ok(data_dir) = crate::app_paths::app_data_dir(app) {
        let log_dir = app.path().app_log_dir().ok();
        let report = storage_report_for(&data_dir, log_dir.as_deref());
        out.push_str("## Storage\n\n");
        for bucket in &report.buckets {
            out.push_str(&format!(
                "- {}: {} MB in {} files\n",
                bucket.label,
                bucket.bytes / (1024 * 1024),
                bucket.files
            ));
        }
        out.push('\n');
    }
    out
}

fn host_only(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| "(unset)".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDiagnosticsResult {
    /// Where the folder went, for the UI to reveal; `None` when cancelled.
    pub path: Option<String>,
    pub files: u64,
}

/// Desktop: the user picks a folder in the native dialog and the bundle is
/// written into a dated subfolder there. No destination crosses IPC.
#[cfg(desktop)]
#[tauri::command]
pub async fn export_diagnostics(app: AppHandle) -> Result<ExportDiagnosticsResult, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx
        .await
        .map_err(|error| AppError::new("diagnostics_export_failed", error.to_string()))?;
    let Some(parent) = picked.and_then(|path| path.into_path().ok()) else {
        return Ok(ExportDiagnosticsResult {
            path: None,
            files: 0,
        });
    };
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let dest = parent.join(format!("sub-rosa-diagnostics-{stamp}"));
    let inputs = bundle_inputs(&app);
    let dest_for_write = dest.clone();
    let written =
        tauri::async_runtime::spawn_blocking(move || write_bundle(&dest_for_write, &inputs))
            .await
            .map_err(|error| AppError::new("diagnostics_export_failed", error.to_string()))?
            .map_err(|error| AppError::new("diagnostics_export_failed", error.to_string()))?;
    Ok(ExportDiagnosticsResult {
        path: Some(dest.display().to_string()),
        files: written.len() as u64,
    })
}

#[cfg(desktop)]
fn bundle_inputs(app: &AppHandle) -> BundleInputs {
    let mut logs = Vec::new();
    if let Ok(log_dir) = app.path().app_log_dir() {
        logs.push(("june-api.log".to_string(), log_dir.join("june-api.log")));
    }
    if let Ok(data_dir) = crate::app_paths::app_data_dir(app) {
        logs.push((
            "dictation-events.log".to_string(),
            data_dir.join("dictation-events.log"),
        ));
        logs.push((
            "hermes-runtime-install.log".to_string(),
            data_dir.join("hermes-runtime").join("install.log"),
        ));
    }
    BundleInputs {
        report: report_text(app),
        logs,
    }
}

#[cfg(test)]
mod tests {
    use super::{capabilities, measure, redact, storage_report_for, write_bundle, BundleInputs};

    #[test]
    fn the_map_is_consistent_with_itself() {
        let caps = capabilities();
        // A HUD without a place to draw it makes no sense; neither does a
        // global dictation hotkey on a platform with no HUD to show it.
        if caps.dictation_hotkey {
            assert!(caps.hud);
        }
        if caps.hermes_agent {
            assert_ne!(caps.platform, "iOS");
        }
        assert!(!caps.platform.is_empty());
    }

    #[test]
    fn measure_counts_files_and_bytes_and_skips_symlinks() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("bucket");
        std::fs::create_dir_all(root.join("nested")).expect("dirs");
        std::fs::write(root.join("a.bin"), [0u8; 100]).expect("a");
        std::fs::write(root.join("nested/b.bin"), [0u8; 50]).expect("b");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("a.bin"), root.join("link")).expect("symlink");
        assert_eq!(measure(&root), (150, 2));
        assert_eq!(measure(&temp.path().join("missing")), (0, 0));
    }

    #[test]
    fn the_report_names_every_bucket_and_sums_them() {
        let temp = tempfile::tempdir().expect("tempdir");
        let data = temp.path().join("data");
        std::fs::create_dir_all(data.join("recordings/n1/s1")).expect("dirs");
        std::fs::write(data.join("recordings/n1/s1/mic.wav"), [0u8; 1000]).expect("wav");
        std::fs::write(data.join("notes.sqlite3"), [0u8; 10]).expect("db");
        let report = storage_report_for(&data, None);
        let recordings = report
            .buckets
            .iter()
            .find(|b| b.id == "recordings")
            .expect("recordings bucket");
        assert_eq!(recordings.bytes, 1000);
        assert!(recordings.purgeable);
        assert_eq!(report.total_bytes, 1010);
        assert_eq!(report.buckets.len(), 7);
    }

    #[test]
    fn redact_removes_keys_and_bearers_and_keeps_the_rest() {
        let text = "GET /v1/models key=cdm_AbC123xyz ok\nAuthorization: Bearer eyJhbGciOi.payload.sig done\nplain line\n";
        let out = redact(text);
        assert!(!out.contains("cdm_AbC123xyz"), "{out}");
        assert!(!out.contains("eyJhbGciOi"), "{out}");
        assert!(out.contains("key=[redacted] ok"), "{out}");
        assert!(out.contains("Bearer [redacted] done"), "{out}");
        assert!(out.contains("plain line"), "{out}");
    }

    #[test]
    fn a_bundle_never_carries_a_planted_key() {
        let temp = tempfile::tempdir().expect("tempdir");
        let log = temp.path().join("june-api.log");
        std::fs::write(
            &log,
            "starting with JUNE__UPSTREAMS__VENICE__API_KEY=cdm_secret99\nrequest token=abc.def\n",
        )
        .expect("log");
        let dest = temp.path().join("out");
        let written = write_bundle(
            &dest,
            &BundleInputs {
                report: "# report\nkey cdm_alsoSecret here\n".into(),
                logs: vec![("june-api.log".into(), log)],
            },
        )
        .expect("bundle");
        assert_eq!(written.len(), 2);
        for file in written {
            let body = std::fs::read_to_string(&file).expect("read");
            assert!(!body.contains("cdm_"), "{}: {body}", file.display());
            assert!(!body.contains("abc.def"), "{}: {body}", file.display());
        }
    }

    #[test]
    fn marks_are_recorded_once_each_in_order_of_arrival() {
        // The clock is process-wide, and other tests mark too, so the check
        // is on this test's own labels among whatever else is there.
        super::mark("test first");
        super::mark("test second");
        super::mark("test first");
        let marks = super::startup_marks();
        let ours: Vec<(&str, u64)> = marks
            .iter()
            .filter(|(label, _)| label.starts_with("test "))
            .map(|(label, ms)| (label.as_str(), *ms))
            .collect();
        assert_eq!(
            ours.iter().map(|(l, _)| *l).collect::<Vec<_>>(),
            vec!["test first", "test second"]
        );
        assert!(ours[0].1 <= ours[1].1);
    }
}
