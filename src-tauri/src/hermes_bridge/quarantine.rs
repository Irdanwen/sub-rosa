//! What a jailed process could plant before ADR-0140, set aside once.
//!
//! Until 1.97.0 the sandboxed runtime could write its whole home, including
//! what the gateway, launched by the system service manager outside the
//! jail, runs: hooks, scripts, routines that run a script, plugins, installed
//! MCP servers, the scanner binary, other profiles. The kernel refuses those
//! writes now, but an installation compromised before the fix would keep
//! them. So at the first start under ADR-0140 the app moves into
//! `<app data>/quarantine/<date>/` everything there that is not its own (it
//! wrote none of it: it writes only the guard plugin, and it never creates a
//! routine with a script), records the list, and tells the person once.
//! Nothing is deleted; the runtime downloads its scanner again.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::domain::types::AppError;

use super::admin_settings;

/// The folders whose content the app never writes (the guard plugin aside).
const FOREIGN_DIRS: &[&str] = &["hooks", "scripts", "mcp-installs", "plugins", "profiles"];
/// The one plugin the app installs.
const APP_PLUGIN: &str = "plugins/subrosa_guard";

/// What was set aside, as the record keeps it.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineRecord {
    /// The folder the items were moved into.
    pub dir: String,
    /// Each item, relative to the home (`cron/jobs.json#<id>` for a routine).
    pub items: Vec<String>,
    /// Whether the person has seen the notice.
    pub seen: bool,
    /// Whether the gateway, which may have loaded what was set aside before
    /// this start, still has to be restarted.
    #[serde(default)]
    pub restart_gateway: bool,
}

/// Sets aside, once, what is not the app's. `date` names the folder.
/// Returns the record (also kept in the settings record), `None` when it had
/// already run.
pub(super) fn run_once(
    hermes_home: &Path,
    date: &str,
) -> std::io::Result<Option<QuarantineRecord>> {
    let mut settings = admin_settings::load(hermes_home);
    if settings.quarantine_done {
        return Ok(None);
    }
    let data_dir = hermes_home.parent().unwrap_or(hermes_home);
    let dir = data_dir.join("quarantine").join(date);
    let mut items = Vec::new();

    let tirith = hermes_home.join("bin").join("tirith");
    if tirith.symlink_metadata().is_ok() {
        move_aside(&tirith, &dir.join("bin/tirith"))?;
        items.push("bin/tirith".to_string());
    }
    for folder in FOREIGN_DIRS {
        let Ok(entries) = std::fs::read_dir(hermes_home.join(folder)) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            let relative = format!("{folder}/{name}");
            if relative == APP_PLUGIN {
                continue;
            }
            move_aside(&hermes_home.join(&relative), &dir.join(&relative))?;
            items.push(relative);
        }
    }
    items.extend(set_aside_script_routines(hermes_home, &dir)?);

    let record = QuarantineRecord {
        dir: dir.to_string_lossy().into_owned(),
        items: items.clone(),
        // Nothing to say when nothing was there.
        seen: items.is_empty(),
        restart_gateway: !items.is_empty(),
    };
    if !items.is_empty() {
        std::fs::create_dir_all(&dir)?;
        let manifest = serde_json::json!({
            "reason": "Set aside at the first start under ADR-0140: written where only the app may write now, and run or read outside the sandbox.",
            "items": items,
        });
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        )?;
        eprintln!(
            "hermes home: set aside {} item(s) in {}",
            items.len(),
            dir.display()
        );
    }
    settings.quarantine_done = true;
    settings.quarantine = Some(record.clone());
    admin_settings::save(hermes_home, &settings)?;
    Ok(Some(record))
}

/// Whether the gateway must be restarted once because something was set
/// aside (it may still hold a hook or a plugin it loaded before). Answers
/// `true` once.
pub(super) fn take_gateway_restart(hermes_home: &Path) -> bool {
    let mut settings = admin_settings::load(hermes_home);
    let Some(record) = settings.quarantine.as_mut() else {
        return false;
    };
    if !record.restart_gateway {
        return false;
    }
    record.restart_gateway = false;
    admin_settings::save(hermes_home, &settings).is_ok()
}

/// Moves one entry (a file, a folder, a link: never followed) aside.
fn move_aside(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(from, to)
}

/// Removes from `cron/jobs.json` the routines that run a script or no agent
/// (the app creates neither), keeping them in the quarantine folder.
fn set_aside_script_routines(hermes_home: &Path, dir: &Path) -> std::io::Result<Vec<String>> {
    let path = hermes_home.join("cron").join("jobs.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        // Not readable as the runtime writes it: set the whole file aside.
        move_aside(&path, &dir.join("cron/jobs.json"))?;
        return Ok(vec!["cron/jobs.json".to_string()]);
    };
    let Some(jobs) = value.get_mut("jobs").and_then(Value::as_array_mut) else {
        return Ok(Vec::new());
    };
    let runs_a_script = |job: &Value| {
        job.get("no_agent")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || job
                .get("script")
                .and_then(Value::as_str)
                .is_some_and(|script| !script.trim().is_empty())
    };
    let (removed, kept): (Vec<Value>, Vec<Value>) = jobs.drain(..).partition(runs_a_script);
    if removed.is_empty() {
        *jobs = kept;
        return Ok(Vec::new());
    }
    *jobs = kept;
    std::fs::create_dir_all(dir.join("cron"))?;
    std::fs::write(
        dir.join("cron/jobs-set-aside.json"),
        serde_json::to_string_pretty(&serde_json::json!({ "jobs": removed })).unwrap_or_default(),
    )?;
    super::home_prep::write_owned(
        &path,
        &serde_json::to_string_pretty(&value).unwrap_or_default(),
    )?;
    Ok(removed
        .iter()
        .map(|job| {
            let id = job.get("id").and_then(Value::as_str).unwrap_or("?");
            format!("cron/jobs.json#{id}")
        })
        .collect())
}

/// What the Settings show once: how many items were set aside, and where.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineNotice {
    pub dir: String,
    pub count: usize,
}

fn record_home(app: &AppHandle) -> Result<PathBuf, AppError> {
    super::resolve_june_hermes_home(app)
}

/// The notice, while the person has not seen it.
#[tauri::command]
pub fn hermes_quarantine_notice(app: AppHandle) -> Result<Option<QuarantineNotice>, AppError> {
    let home = record_home(&app)?;
    Ok(admin_settings::load(&home)
        .quarantine
        .filter(|record| !record.seen && !record.items.is_empty())
        .map(|record| QuarantineNotice {
            count: record.items.len(),
            dir: record.dir,
        }))
}

/// The person has seen it.
#[tauri::command]
pub fn dismiss_hermes_quarantine_notice(app: AppHandle) -> Result<(), AppError> {
    let home = record_home(&app)?;
    let mut settings = admin_settings::load(&home);
    if let Some(record) = settings.quarantine.as_mut() {
        record.seen = true;
    }
    admin_settings::save(&home, &settings)
        .map_err(|error| AppError::new("hermes_settings_failed", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plant(home: &Path, relative: &str, text: &str) {
        let path = home.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn what_is_not_the_apps_is_set_aside_once_never_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        plant(&home, "bin/tirith", "#!/bin/sh\n");
        plant(&home, "bin/uv", "kept\n");
        plant(&home, "hooks/x/HOOK.yaml", "name: x\n");
        plant(&home, "hooks/x/handler.py", "import os\n");
        plant(&home, "scripts/x.sh", "touch /tmp/owned\n");
        plant(&home, "mcp-installs/srv/run.sh", "x\n");
        plant(&home, "plugins/planted/plugin.yaml", "name: planted\n");
        plant(
            &home,
            "plugins/subrosa_guard/plugin.yaml",
            "name: subrosa_guard\n",
        );
        plant(&home, "profiles/p/config.yaml", "approvals:\n  mode: off\n");
        plant(
            &home,
            "cron/jobs.json",
            r#"{"jobs": [{"id": "keep", "prompt": "hi"}, {"id": "script", "script": "x.sh"}, {"id": "bare", "no_agent": true}]}"#,
        );

        let record = run_once(&home, "2026-10-31").unwrap().unwrap();
        let aside = PathBuf::from(&record.dir);
        for gone in [
            "bin/tirith",
            "hooks/x",
            "scripts/x.sh",
            "mcp-installs/srv",
            "plugins/planted",
            "profiles/p",
        ] {
            assert!(home.join(gone).symlink_metadata().is_err(), "{gone} kept");
            assert!(aside.join(gone).exists(), "{gone} not set aside");
        }
        assert!(home.join("bin/uv").exists(), "only the scanner leaves bin/");
        assert!(home.join("plugins/subrosa_guard/plugin.yaml").exists());
        let jobs: Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("cron/jobs.json")).unwrap())
                .unwrap();
        assert_eq!(jobs["jobs"].as_array().unwrap().len(), 1);
        assert_eq!(jobs["jobs"][0]["id"], "keep");
        assert!(record.items.contains(&"cron/jobs.json#script".to_string()));
        assert!(record.items.contains(&"cron/jobs.json#bare".to_string()));
        assert!(aside.join("manifest.json").exists());
        assert!(aside.join("cron/jobs-set-aside.json").exists());
        assert!(!record.seen);
        // The gateway is restarted once, so nothing it loaded before stays.
        assert!(take_gateway_restart(&home));
        assert!(!take_gateway_restart(&home));

        // Once: a later start leaves what the app now writes alone.
        plant(&home, "scripts/later.sh", "x\n");
        assert!(run_once(&home, "2026-11-01").unwrap().is_none());
        assert!(home.join("scripts/later.sh").exists());
    }

    #[test]
    fn a_clean_home_has_nothing_to_say() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(home.join("hooks")).unwrap();
        let record = run_once(&home, "2026-10-31").unwrap().unwrap();
        assert!(record.items.is_empty() && record.seen);
        assert!(!dir.path().join("quarantine").exists());
    }
}
