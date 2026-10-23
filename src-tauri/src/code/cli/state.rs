//! What a run keeps between invocations, and the one-run-at-a-time lock.
//!
//! A run is a small JSON file under `<data>/code-cli/runs/`, written before
//! the first turn and after each one: the folder, the model, the mode, the
//! budget, what it spent, the Hermes session it continues and the last line
//! number it wrote. `--resume` reads it back and opens a new turn on the same
//! session. The file sits outside the runtime's write jail.

use std::{
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::code::event::{RunMode, RunStatus};

pub const RUN_STATE_SCHEMA: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub schema: u32,
    pub run_id: String,
    pub dir: PathBuf,
    pub model: String,
    pub mode: RunMode,
    pub budget_usd: f64,
    /// Every invocation of the run, as the operator metered it.
    pub spent_usd: f64,
    /// Hermes' stored session id (`stored_session_id`), for `session.resume`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hermes_session_id: Option<String>,
    pub turns: u32,
    pub last_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<RunStatus>,
    pub created_at: String,
    pub updated_at: String,
}

impl RunState {
    #[must_use]
    pub fn new(
        run_id: String,
        dir: PathBuf,
        model: String,
        mode: RunMode,
        budget_usd: f64,
    ) -> Self {
        let now = now();
        Self {
            schema: RUN_STATE_SCHEMA,
            run_id,
            dir,
            model,
            mode,
            budget_usd,
            spent_usd: 0.0,
            hermes_session_id: None,
            turns: 0,
            last_seq: 0,
            status: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}

/// A fresh run id: `run_` and a UUIDv7, so ids sort by creation.
#[must_use]
pub fn new_run_id() -> String {
    format!("run_{}", uuid::Uuid::now_v7().simple())
}

pub fn runs_dir(data_dir: &Path) -> PathBuf {
    data_dir
        .join(crate::hermes_bridge::headless::CODE_CLI_DIR)
        .join("runs")
}

fn state_path(data_dir: &Path, run_id: &str) -> PathBuf {
    runs_dir(data_dir).join(format!("{run_id}.json"))
}

pub fn load(data_dir: &Path, run_id: &str) -> Result<RunState, String> {
    let path = state_path(data_dir, run_id);
    let raw = fs::read_to_string(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!("No run `{run_id}` in {}.", runs_dir(data_dir).display())
        } else {
            format!("The run `{run_id}` cannot be read: {error}")
        }
    })?;
    let state: RunState = serde_json::from_str(&raw)
        .map_err(|error| format!("The run `{run_id}` is damaged: {error}"))?;
    if state.schema != RUN_STATE_SCHEMA || state.run_id != run_id {
        return Err(format!(
            "The run `{run_id}` was written by another version."
        ));
    }
    Ok(state)
}

/// Writes the state atomically (temporary file, then rename), owner-only.
pub fn save(data_dir: &Path, state: &mut RunState) -> io::Result<()> {
    state.updated_at = now();
    let dir = runs_dir(data_dir);
    fs::create_dir_all(&dir)?;
    let path = state_path(data_dir, &state.run_id);
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&serde_json::to_vec_pretty(state).map_err(io::Error::other)?)?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// One run at a time per data folder: the CLI's Hermes home has one
/// `config.yaml`, and a second run rewriting it would point the first
/// runtime at the second run's proxy. Held for the life of the value.
#[derive(Debug)]
pub struct RunLock {
    path: PathBuf,
}

impl RunLock {
    pub fn acquire(data_dir: &Path) -> Result<Self, String> {
        let dir = data_dir.join(crate::hermes_bridge::headless::CODE_CLI_DIR);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let path = dir.join("run.lock");
        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    let _ = write!(file, "{}", std::process::id());
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let holder = fs::read_to_string(&path)
                        .ok()
                        .and_then(|pid| pid.trim().parse::<u32>().ok());
                    match holder {
                        Some(pid) if process_alive(pid) => {
                            return Err(format!(
                                "Another code run is in progress in this data folder (process {pid}). Wait for it, or use another --data-dir."
                            ));
                        }
                        // A crashed run left it behind.
                        _ => {
                            let _ = fs::remove_file(&path);
                        }
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("The run lock could not be taken.".into())
    }
}

impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // Signal 0 checks existence; EPERM still means it exists.
    // SAFETY: kill(2) with signal 0 sends nothing; it only reads the process
    // table for a pid that came from a file we wrote.
    #[allow(unsafe_code)]
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    // Without a cheap check, a lock is assumed live; remove it by hand after
    // a crash (docs/code-cli.md).
    true
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn a_run_state_round_trips_through_its_file() {
        let data = tempfile::tempdir().unwrap();
        let mut state = RunState::new(
            new_run_id(),
            PathBuf::from("/work/repo"),
            "kimi-k2-7-code".into(),
            RunMode::Build,
            2.0,
        );
        state.hermes_session_id = Some("20261023_101500_ab12cd".into());
        state.spent_usd = 0.0125;
        state.turns = 1;
        state.last_seq = 42;
        state.status = Some(RunStatus::Completed);
        save(data.path(), &mut state).unwrap();
        let back = load(data.path(), &state.run_id).unwrap();
        assert_eq!(back, state);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(state_path(data.path(), &state.run_id))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn an_unknown_or_foreign_run_is_refused() {
        let data = tempfile::tempdir().unwrap();
        assert!(load(data.path(), "run_missing")
            .unwrap_err()
            .contains("No run"));
        let mut state = RunState::new("run_a".into(), "/w".into(), "m".into(), RunMode::Plan, 1.0);
        save(data.path(), &mut state).unwrap();
        fs::copy(
            state_path(data.path(), "run_a"),
            state_path(data.path(), "run_b"),
        )
        .unwrap();
        assert!(load(data.path(), "run_b").is_err());
    }

    #[test]
    fn run_ids_are_plain_and_sort_by_creation() {
        let first = new_run_id();
        let second = new_run_id();
        assert!(first.starts_with("run_"));
        assert!(crate::code::cli::args::parse_run_id(&first).is_ok());
        assert!(first < second);
    }

    #[test]
    fn the_lock_admits_one_run_and_recovers_from_a_dead_holder() {
        let data = tempfile::tempdir().unwrap();
        let held = RunLock::acquire(data.path()).unwrap();
        assert!(RunLock::acquire(data.path())
            .unwrap_err()
            .contains("Another code run"));
        drop(held);
        let again = RunLock::acquire(data.path()).unwrap();
        drop(again);
        // A lock left by a process that no longer exists is taken over.
        let lock = data.path().join("code-cli/run.lock");
        fs::write(&lock, "999999999").unwrap();
        #[cfg(unix)]
        assert!(RunLock::acquire(data.path()).is_ok());
    }
}
