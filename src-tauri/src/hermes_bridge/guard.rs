//! The runtime's own memory, guarded (ADR-0083 and ADR-0084 addenda).
//!
//! The pinned Hermes has a memory tool and a skill writer of its own, and no
//! per-session way to switch them off: `config.set` has no such key,
//! `tools.configure` rewrites the shared `config.yaml` for every chat, and
//! `skip_memory` is read from the process environment. What it does have is a
//! `pre_tool_call` plugin hook, asked on every dispatch path with the id of
//! the session the call belongs to. So the app installs a plugin
//! (`hermes/subrosa_guard.py`), enables it in the `config.yaml` it writes, and
//! keeps a ledger next to it: the temporary chats open right now and the
//! protected-mode switches. The plugin refuses the guarded tools from it.

use std::path::Path;

use crate::domain::types::AppError;

const PLUGIN_NAME: &str = "subrosa_guard";
const PLUGIN_SOURCE: &str = include_str!("../hermes/subrosa_guard.py");
const PLUGIN_MANIFEST: &str = "name: subrosa_guard\n\
version: \"1\"\n\
description: \"Sub Rosa: no memory or skill writes from a temporary chat, and the protected mode switches.\"\n\
author: Sub Rosa\n\
hooks:\n  - pre_tool_call\n";
const LEDGER_NAME: &str = "subrosa-guard.json";

/// What the app adds to the `config.yaml` it writes: the plugin enabled
/// (Hermes plugins are opt-in), and, while protected mode holds memory off,
/// the runtime's own memory switched off too, so it is not even read into a
/// new chat's prompt.
pub(super) fn config_block(memory_off: bool) -> String {
    let mut block = format!("plugins:\n  enabled:\n    - {PLUGIN_NAME}\n");
    if memory_off {
        block.push_str("memory:\n  memory_enabled: false\n  user_profile_enabled: false\n");
    }
    block
}

/// Writes the plugin under `$HERMES_HOME/plugins/`. Rewritten at every
/// runtime start, so an app update carries its guard with it.
pub(super) fn install_plugin(hermes_home: &Path) -> std::io::Result<()> {
    let dir = hermes_home.join("plugins").join(PLUGIN_NAME);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("plugin.yaml"), PLUGIN_MANIFEST)?;
    std::fs::write(dir.join("__init__.py"), PLUGIN_SOURCE)
}

pub fn render_ledger(
    temporary_sessions: &[String],
    restrictions: &crate::protected_mode::Restrictions,
) -> String {
    serde_json::json!({
        "temporarySessions": temporary_sessions,
        "memoryOff": restrictions.memory_off,
        "pastChatsOff": restrictions.past_chats_off,
    })
    .to_string()
}

/// Rewrites the ledger from the database and the protected switches. A
/// temporary chat is registered only once this has succeeded, so its first
/// message never reaches a runtime that does not know it is temporary.
pub async fn publish(app: &tauri::AppHandle) -> Result<(), AppError> {
    let hermes_home = super::resolve_june_hermes_home(app)?;
    let pool = crate::commands::repositories(app).await?.pool.clone();
    let sessions = crate::temporary_chat::session_ids(&pool).await?;
    write_ledger(
        &hermes_home,
        &render_ledger(&sessions, &crate::protected_mode::restrictions()),
    )
}

/// The plugin and a fresh ledger, before a runtime starts.
pub(super) async fn install(app: &tauri::AppHandle, hermes_home: &Path) -> Result<(), AppError> {
    install_plugin(hermes_home).map_err(failed)?;
    publish(app).await
}

fn write_ledger(hermes_home: &Path, contents: &str) -> Result<(), AppError> {
    super::write_june_web_proxy_coordinates(&hermes_home.join(LEDGER_NAME), contents)
        .map_err(failed)
}

fn failed(error: std::io::Error) -> AppError {
    AppError::new("hermes_guard_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protected_mode::Restrictions;
    use std::process::Command;

    #[test]
    fn the_config_enables_the_plugin_and_can_switch_the_runtime_memory_off() {
        let block = config_block(false);
        assert_eq!(block, "plugins:\n  enabled:\n    - subrosa_guard\n");
        let off = config_block(true);
        assert!(off.starts_with(&block));
        assert!(off.contains("memory:\n  memory_enabled: false\n  user_profile_enabled: false\n"));
        // Appended after the rest of the file, it adds top-level keys only.
        let config = format!(
            "{}{}",
            super::super::render_hermes_config(
                "glm",
                "http://127.0.0.1:9/v1",
                "tok",
                "web",
                &[],
                None,
                None,
                None,
                None,
                None
            ),
            off
        );
        assert!(config.contains("\nplugins:\n  enabled:\n    - subrosa_guard\nmemory:\n"));
    }

    #[test]
    fn the_ledger_names_the_temporary_sessions_and_the_switches() {
        let ledger: serde_json::Value = serde_json::from_str(&render_ledger(
            &["20261007_101010_abc123".to_string()],
            &Restrictions {
                memory_off: true,
                ..Restrictions::default()
            },
        ))
        .unwrap();
        assert_eq!(
            ledger,
            serde_json::json!({
                "temporarySessions": ["20261007_101010_abc123"],
                "memoryOff": true,
                "pastChatsOff": false,
            })
        );
    }

    #[test]
    fn the_plugin_is_installed_where_hermes_discovers_user_plugins() {
        let home = tempfile::tempdir().unwrap();
        install_plugin(home.path()).unwrap();
        let dir = home.path().join("plugins").join(PLUGIN_NAME);
        let manifest = std::fs::read_to_string(dir.join("plugin.yaml")).unwrap();
        assert!(manifest.starts_with("name: subrosa_guard\n"));
        assert!(manifest.contains("  - pre_tool_call\n"));
        let source = std::fs::read_to_string(dir.join("__init__.py")).unwrap();
        assert!(source.contains("def register(ctx)"));
        write_ledger(home.path(), &render_ledger(&[], &Restrictions::default())).unwrap();
        assert!(home.path().join(LEDGER_NAME).exists());
    }

    /// Runs the installed plugin's hook against a ledger and a `state.db`, in
    /// a real Python, the way the runtime calls it. Skipped where no
    /// `python3` is on the path.
    #[test]
    fn the_plugin_refuses_memory_writes_in_temporary_chats_only() {
        if Command::new("python3").arg("--version").output().is_err() {
            eprintln!("python3 not found: the plugin's own test is skipped");
            return;
        }
        let home = tempfile::tempdir().unwrap();
        install_plugin(home.path()).unwrap();
        // A temporary chat, and a continuation the runtime forked from it.
        let state = write_state_db(home.path());
        assert!(state, "state.db fixture");
        write_ledger(
            home.path(),
            &render_ledger(&["temp-1".to_string()], &Restrictions::default()),
        )
        .unwrap();
        let verdicts = run_plugin(
            home.path(),
            &[
                ("memory", "temp-1"),
                ("skill_manage", "temp-1"),
                ("memory", "temp-1-child"),
                ("memory", "ordinary"),
                ("session_search", "temp-1"),
                ("web_search", "temp-1"),
                ("memory", ""),
            ],
        );
        assert_eq!(
            verdicts,
            ["block", "block", "block", "allow", "allow", "allow", "block"]
        );

        // Protected mode: memory and past chats off everywhere.
        write_ledger(
            home.path(),
            &render_ledger(
                &[],
                &Restrictions {
                    memory_off: true,
                    past_chats_off: true,
                    ..Restrictions::default()
                },
            ),
        )
        .unwrap();
        let verdicts = run_plugin(
            home.path(),
            &[
                ("memory", "ordinary"),
                ("mcp__june_context__search_user_memories", "ordinary"),
                ("session_search", "ordinary"),
                ("mcp__june_context__search_past_chats", "ordinary"),
                ("skill_manage", "ordinary"),
                ("memory", ""),
            ],
        );
        assert_eq!(
            verdicts,
            ["block", "block", "block", "block", "allow", "block"]
        );

        // No ledger: nothing is refused. A damaged one refuses the guarded tools.
        std::fs::remove_file(home.path().join(LEDGER_NAME)).unwrap();
        assert_eq!(run_plugin(home.path(), &[("memory", "temp-1")]), ["allow"]);
        std::fs::write(home.path().join(LEDGER_NAME), "{not json").unwrap();
        assert_eq!(
            run_plugin(home.path(), &[("memory", "x"), ("web_search", "x")]),
            ["block", "allow"]
        );
    }

    /// The `sessions` table the plugin walks for a session's parents, with a
    /// child forked from `temp-1`. Built by Python's own sqlite3 so the test
    /// needs no SQLite crate of its own.
    fn write_state_db(home: &Path) -> bool {
        Command::new("python3")
            .arg("-c")
            .arg(
                "import sqlite3, sys\n\
                 c = sqlite3.connect(sys.argv[1])\n\
                 c.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)')\n\
                 c.executemany('INSERT INTO sessions VALUES (?, ?)', [('temp-1', None), ('temp-1-child', 'temp-1'), ('ordinary', None)])\n\
                 c.commit()\n",
            )
            .arg(home.join("state.db"))
            .status()
            .is_ok_and(|status| status.success())
    }

    fn run_plugin(home: &Path, calls: &[(&str, &str)]) -> Vec<String> {
        let calls = serde_json::to_string(calls).unwrap();
        let output = Command::new("python3")
            .arg("-c")
            .arg(
                "import json, sys, importlib.util\n\
                 spec = importlib.util.spec_from_file_location('guard', sys.argv[1])\n\
                 guard = importlib.util.module_from_spec(spec)\n\
                 spec.loader.exec_module(guard)\n\
                 for tool, session in json.loads(sys.argv[2]):\n\
                 \x20   verdict = guard._pre_tool_call(tool_name=tool, session_id=session)\n\
                 \x20   print('block' if verdict and verdict['action'] == 'block' else 'allow')\n",
            )
            .arg(home.join("plugins").join(PLUGIN_NAME).join("__init__.py"))
            .arg(calls)
            .env("HERMES_HOME", home)
            .output()
            .expect("run python3");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }
}
