//! Settings changes, made by the app outside the jail (ADR-0140).
//!
//! The sandboxed runtime can no longer write its settings (`config.yaml`,
//! `.env`, `skills/`, `cron/`, `mcp-installs/`): processes outside the jail
//! read them with authority. So a change a person makes in Settings (an MCP
//! server, a skill switched off, a toolset, a skill's key, a routine) is not
//! sent to the jailed runtime's dashboard: the app runs the runtime's own
//! route once, in a short-lived process of its own, with the same home and
//! the runtime's interpreter (`hermes/subrosa_admin.py`), then keeps the
//! settings a person owns so they survive the next start
//! (`admin_settings::capture`).
//!
//! Reads, tests of a server and everything else still go to the runtime.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use reqwest::Method;
use serde::Deserialize;
use serde_json::Value;

use crate::domain::types::AppError;

use super::{
    admin_settings, apply_isolated_hermes_env, hermes_python_command, random_token,
    wait_with_timeout, HermesBridgeConnection, JUNE_CONTEXT_MCP_DIR_NAME,
};

const ADMIN_SCRIPT: &str = include_str!("../hermes/subrosa_admin.py");
const ADMIN_SCRIPT_NAME: &str = "subrosa_admin.py";
/// A catalog install runs a package manager; give it room.
const ADMIN_TIMEOUT: Duration = Duration::from_secs(300);

/// One change at a time: each reads the files the last one wrote (the
/// runtime's own routes read, modify and save the whole `config.yaml`), and
/// the app's record is copied from them right after.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Whether a dashboard request changes something the jail can no longer
/// write, and so runs here rather than in the runtime. Matched on the path
/// without its query. A route not listed (a server's test, revealing a key,
/// sessions, the gateway, profiles) keeps going to the runtime: profiles in
/// particular stay out of reach, since the app runs only the default one.
pub(super) fn runs_outside_jail(method: &Method, path: &str) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return false;
    }
    let path = path.split('?').next().unwrap_or(path);
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["api", "mcp", "servers"] => true,
        ["api", "mcp", "servers", _] => *method == Method::DELETE,
        ["api", "mcp", "servers", _, "enabled"] => true,
        ["api", "mcp", "catalog", "install"] => true,
        ["api", "skills"] => true,
        ["api", "skills", "toggle" | "content"] => true,
        ["api", "skills", "hub", "install" | "uninstall" | "update"] => true,
        ["api", "tools", "toolsets", _] => true,
        ["api", "tools", "toolsets", _, "model" | "provider" | "env" | "post-setup"] => true,
        ["api", "config"] => true,
        ["api", "env"] => true,
        ["api", "messaging", "platforms", _] => true,
        ["api", "cron", "jobs"] => true,
        ["api", "cron", "jobs", _] => true,
        ["api", "cron", "jobs", _, "pause" | "resume" | "trigger"] => true,
        _ => false,
    }
}

/// What a settings change may not do, refused before it runs, with the
/// reason (ADR-0140): a key written by `PUT /api/env` (a skill's setup)
/// must be a credential the runtime declares (anything else would be
/// dropped at the next start, or would reshape the gateway), and no
/// setting switches on one of the gateway's network doors (its agent API,
/// its webhooks, a relay).
fn refuse_undeclared_key(
    hermes_home: &Path,
    method: &Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(), AppError> {
    let path = path.split('?').next().unwrap_or(path).trim_end_matches('/');
    if *method != Method::PUT {
        return Ok(());
    }
    if let Some(platform) = path.strip_prefix("/api/messaging/platforms/") {
        if admin_settings::NETWORK_PLATFORMS.contains(&platform) {
            return Err(refused(
                format!("Sub Rosa does not open the {platform} door of the gateway."),
                "setting_platform_not_offered",
            ));
        }
        return Ok(());
    }
    if path != "/api/env" {
        return Ok(());
    }
    let key = body
        .and_then(|body| body.get("key"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let settings = admin_settings::load(hermes_home);
    if admin_settings::env_key_allowed(key, admin_settings::KeyUse::Credential, &settings) {
        return Ok(());
    }
    Err(refused(
        format!("{key} is not a key Sub Rosa's settings can set."),
        "setting_key_not_declared",
    ))
}

fn refused(detail: String, code: &str) -> AppError {
    let body = serde_json::json!({ "detail": detail, "code": code });
    AppError::new(
        "hermes_bridge_api_failed",
        format!("Hermes API returned 422 Unprocessable Entity: {body}"),
    )
}

#[derive(Debug, Deserialize)]
struct AdminResult {
    status: u16,
    #[serde(default)]
    body: Value,
    #[serde(default)]
    config: Option<Value>,
    /// The keys the runtime declares Settings can write into `.env`.
    #[serde(default)]
    env_schema: Option<Vec<String>>,
    /// Among them, the credentials.
    #[serde(default)]
    env_secrets: Option<Vec<String>>,
}

impl AdminResult {
    fn schema(&mut self) -> Option<admin_settings::EnvSchemaLists> {
        let declared = self.env_schema.take()?;
        Some(admin_settings::EnvSchemaLists {
            declared,
            secrets: self.env_secrets.take().unwrap_or_default(),
        })
    }
}

/// Runs one settings change outside the jail, with the interpreter of the
/// runtime `connection` serves, always on the shared home: the settings a
/// person owns are kept once, for both homes, and the sandboxed home's
/// `config.yaml` and `.env` are written again from them right after
/// (ADR-0140). Answers like the dashboard would: the route's JSON on
/// success, `Hermes API returned <status>: <body>` as the error otherwise,
/// which the webview's transport reads back.
pub(super) async fn run(
    connection: &HermesBridgeConnection,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let hermes_home = super::home_split::shared_home(Path::new(&connection.hermes_home));
    refuse_undeclared_key(&hermes_home, &method, path, body.as_ref())?;
    let python = hermes_python_command(&connection.command);
    let request = serde_json::json!({
        "method": method.as_str(),
        "path": path,
        "body": body,
    });
    let _turn = ONE_AT_A_TIME.lock().await;
    let home = hermes_home.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || run_blocking(&python, &home, &request))
            .await
            .map_err(|error| failed(error.to_string()))??;
    let answer = respond(&hermes_home, result)?;
    if method != Method::GET {
        let sandboxed = super::home_split::sandboxed_home(&hermes_home);
        if let Err(error) = admin_settings::reapply(&sandboxed) {
            eprintln!("hermes settings: the sandboxed home keeps its last settings: {error}");
        }
    }
    Ok(answer)
}

/// A request on one home with no runtime running there (ADR-0140, the
/// merged list of conversations, a transcript): the runtime's own route,
/// once, in a process of the app, under the jail's profile when `jail` is
/// given (the sandboxed home). Nothing is kept from it.
pub(super) async fn read_on(
    hermes_command: &str,
    hermes_home: &Path,
    jail: Option<PathBuf>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let python = hermes_python_command(hermes_command);
    let request = serde_json::json!({
        "method": method.as_str(),
        "path": path,
        "body": body,
    });
    let home = hermes_home.to_path_buf();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_blocking_in(&python, &home, &request, jail.as_deref())
    })
    .await
    .map_err(|error| failed(error.to_string()))??;
    answer_only(result.0)
}

/// Before a start: copies the runtime's bundled skills into its home (the
/// runtime does it itself when it starts, which the jail now refuses), and
/// records the keys it declares Settings can write into `.env` (ADR-0140).
/// Best effort: a failure leaves the skills and the keys already known, and
/// is logged.
pub(super) async fn sync_bundled_skills(hermes_command: &str, hermes_home: &Path) {
    let python = hermes_python_command(hermes_command);
    let home = hermes_home.to_path_buf();
    let _turn = ONE_AT_A_TIME.lock().await;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_blocking(&python, &home, &serde_json::json!({ "op": "sync_skills" }))
    })
    .await;
    match outcome {
        Ok(Ok(mut result)) if result.0.status == 200 => {
            if let Some(schema) = result.0.schema() {
                if let Err(error) = admin_settings::record_schema(hermes_home, schema) {
                    eprintln!("hermes settings: could not record the keys: {error}");
                }
            }
        }
        Ok(Ok(result)) => eprintln!("hermes skills: sync answered {}", result.0.status),
        Ok(Err(error)) => eprintln!("hermes skills: sync failed: {}", error.message),
        Err(error) => eprintln!("hermes skills: sync failed: {error}"),
    }
}

/// The blocking half, also what the real-runtime tests call.
pub(super) fn run_blocking(
    python: &str,
    hermes_home: &Path,
    request: &Value,
) -> Result<AdminResultFile, AppError> {
    run_blocking_in(python, hermes_home, request, None)
}

/// [`run_blocking`], under the Seatbelt profile at `jail` when given: the
/// result then goes to the temp folder, the one place the jail may write it.
pub(super) fn run_blocking_in(
    python: &str,
    hermes_home: &Path,
    request: &Value,
    jail: Option<&Path>,
) -> Result<AdminResultFile, AppError> {
    let data_dir = hermes_home.parent().unwrap_or(hermes_home);
    let script_dir = data_dir.join(JUNE_CONTEXT_MCP_DIR_NAME);
    std::fs::create_dir_all(&script_dir).map_err(|error| failed(error.to_string()))?;
    let script = script_dir.join(ADMIN_SCRIPT_NAME);
    std::fs::write(&script, ADMIN_SCRIPT).map_err(|error| failed(error.to_string()))?;
    let token = random_token();
    let out_dir = if jail.is_some() {
        std::env::temp_dir()
    } else {
        script_dir.clone()
    };
    let out = out_dir.join(format!(
        "admin-result-{}.json",
        &token[..16.min(token.len())]
    ));
    let _ = std::fs::remove_file(&out);

    let mut cmd = match jail {
        Some(profile) => {
            let mut cmd = Command::new(super::SANDBOX_EXEC_PATH);
            cmd.arg("-f").arg(profile).arg(python);
            cmd
        }
        None => Command::new(python),
    };
    cmd.arg(&script).arg("--out").arg(&out);
    apply_isolated_hermes_env(&mut cmd, hermes_home, &token, None);
    cmd.env("HERMES_NONINTERACTIVE", "1")
        .current_dir(hermes_home)
        .stdin(Stdio::piped());
    match open_admin_log(hermes_home) {
        Some((stdout, stderr)) => cmd.stdout(stdout).stderr(stderr),
        None => cmd.stdout(Stdio::null()).stderr(Stdio::null()),
    };
    if jail.is_some() {
        super::sandbox_profile::own_session(&mut cmd);
    }
    let mut child = cmd.spawn().map_err(|error| failed(error.to_string()))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(request.to_string().as_bytes());
    }
    let finished = wait_with_timeout(child, ADMIN_TIMEOUT)?;
    let text = std::fs::read_to_string(&out);
    let _ = std::fs::remove_file(&out);
    if finished.timed_out {
        return Err(failed("the change did not finish in time".to_string()));
    }
    let text = text.map_err(|_| failed("the change did not report back".to_string()))?;
    let result: AdminResult =
        serde_json::from_str(&text).map_err(|error| failed(error.to_string()))?;
    Ok(AdminResultFile(result))
}

/// What the script reported, opaque outside this module.
pub(super) struct AdminResultFile(AdminResult);

impl AdminResultFile {
    #[cfg(test)]
    pub(super) fn status(&self) -> u16 {
        self.0.status
    }
}

/// The route's answer, as the dashboard would give it, nothing kept.
fn answer_only(result: AdminResult) -> Result<Value, AppError> {
    if !(200..300).contains(&result.status) {
        let reason = reqwest::StatusCode::from_u16(result.status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or("");
        let body = match &result.body {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        return Err(AppError::new(
            "hermes_bridge_api_failed",
            format!("Hermes API returned {} {reason}: {body}", result.status),
        ));
    }
    Ok(result.body)
}

/// Keeps the person's settings after a change that worked, and answers.
pub(super) fn respond(hermes_home: &Path, result: AdminResultFile) -> Result<Value, AppError> {
    let mut result = result.0;
    if !(200..300).contains(&result.status) {
        let reason = reqwest::StatusCode::from_u16(result.status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or("");
        let body = match &result.body {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        return Err(AppError::new(
            "hermes_bridge_api_failed",
            format!("Hermes API returned {} {reason}: {body}", result.status),
        ));
    }
    let schema = result.schema();
    if let Err(error) = admin_settings::capture(hermes_home, result.config.as_ref(), schema) {
        // The change is made; only its survival across a restart is lost.
        eprintln!("hermes settings: could not keep the change: {error}");
    }
    Ok(result.body)
}

fn open_admin_log(hermes_home: &Path) -> Option<(std::fs::File, std::fs::File)> {
    let dir = super::home_prep::app_log_dir(hermes_home);
    std::fs::create_dir_all(&dir).ok()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("settings-changes.log"))
        .ok()?;
    let clone = file.try_clone().ok()?;
    Some((file, clone))
}

/// A change that never got an answer from the runtime's route reads, to the
/// webview's transport, as the server error it is (a 500): the screen then
/// says the change was not made, not that the assistant is unreachable.
fn failed(detail: String) -> AppError {
    AppError::new(
        "hermes_bridge_api_failed",
        format!("Hermes API returned 500 Internal Server Error: the setting could not be changed. {detail}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_changes_run_outside_the_jail_and_the_rest_does_not() {
        let outside = [
            (Method::POST, "/api/mcp/servers"),
            (Method::PUT, "/api/mcp/servers?profile=default"),
            (Method::DELETE, "/api/mcp/servers/notion"),
            (Method::PUT, "/api/mcp/servers/notion/enabled"),
            (Method::POST, "/api/mcp/catalog/install"),
            (Method::PUT, "/api/skills/toggle"),
            (Method::POST, "/api/skills"),
            (Method::PUT, "/api/skills/content"),
            (Method::POST, "/api/skills/hub/install"),
            (Method::PUT, "/api/tools/toolsets/web"),
            (Method::PUT, "/api/tools/toolsets/web/env"),
            (Method::PUT, "/api/config"),
            (Method::PUT, "/api/env"),
            (Method::DELETE, "/api/env"),
            (Method::PUT, "/api/messaging/platforms/telegram"),
            (Method::POST, "/api/cron/jobs?profile=default"),
            (Method::PUT, "/api/cron/jobs/abc?profile=default"),
            (Method::DELETE, "/api/cron/jobs/abc"),
            (Method::POST, "/api/cron/jobs/abc/trigger"),
        ];
        for (method, path) in outside {
            assert!(runs_outside_jail(&method, path), "{method} {path}");
        }
        let inside = [
            (Method::GET, "/api/mcp/servers"),
            (Method::GET, "/api/config"),
            (Method::POST, "/api/mcp/servers/notion/test"),
            (Method::POST, "/api/mcp/servers/notion/auth"),
            (Method::POST, "/api/env/reveal"),
            (Method::DELETE, "/api/sessions/abc"),
            (Method::POST, "/api/gateway/start"),
            (Method::POST, "/api/profiles/active"),
            (Method::POST, "/api/profiles"),
            (Method::PUT, "/api/config/raw"),
            (Method::POST, "/api/cron/jobs/abc/run-now-in-process"),
        ];
        for (method, path) in inside {
            assert!(!runs_outside_jail(&method, path), "{method} {path}");
        }
    }

    #[test]
    fn a_key_the_runtime_does_not_declare_is_refused_before_the_change() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(&home).unwrap();
        admin_settings::record_schema(
            &home,
            admin_settings::EnvSchemaLists {
                declared: vec!["NOTION_API_KEY".into(), "TELEGRAM_HOME_CHANNEL".into()],
                secrets: vec!["NOTION_API_KEY".into()],
            },
        )
        .unwrap();
        let put = |key: &str| {
            refuse_undeclared_key(
                &home,
                &Method::PUT,
                "/api/env?profile=default",
                Some(&serde_json::json!({"key": key, "value": "v"})),
            )
        };
        assert!(put("NOTION_API_KEY").is_ok());
        for key in [
            "PIP_INDEX_URL",
            "SOME_UNKNOWN_KEY",
            "HERMES_YOLO_MODE",
            "API_SERVER_KEY",
            "TELEGRAM_HOME_CHANNEL",
        ] {
            let error = put(key).unwrap_err();
            assert!(
                error.message.starts_with("Hermes API returned 422"),
                "{}",
                error.message
            );
            assert!(error.message.contains(key));
            assert!(error.message.contains("setting_key_not_declared"));
        }
        // No setting opens the gateway's agent API or webhooks.
        for platform in ["api_server", "webhook"] {
            let error = refuse_undeclared_key(
                &home,
                &Method::PUT,
                &format!("/api/messaging/platforms/{platform}"),
                Some(&serde_json::json!({"enabled": true, "env": {}})),
            )
            .unwrap_err();
            assert!(error.message.contains("setting_platform_not_offered"));
        }
        assert!(refuse_undeclared_key(
            &home,
            &Method::PUT,
            "/api/messaging/platforms/telegram",
            Some(&serde_json::json!({"enabled": true, "env": {}})),
        )
        .is_ok());
        // Other routes are not this check's business.
        assert!(refuse_undeclared_key(&home, &Method::DELETE, "/api/env", None).is_ok());
    }

    #[test]
    fn a_refused_change_answers_like_the_dashboard() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(&home).unwrap();
        let error = respond(
            &home,
            AdminResultFile(AdminResult {
                status: 409,
                body: serde_json::json!({"detail": "Server 'x' already exists"}),
                config: None,
                env_schema: None,
                env_secrets: None,
            }),
        )
        .unwrap_err();
        assert!(error
            .message
            .starts_with("Hermes API returned 409 Conflict: "));
        // Nothing kept from a change that did not happen.
        assert!(!admin_settings::settings_path(&home).exists());
    }

    #[test]
    fn a_change_that_worked_is_kept_for_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".env"), "NOTION_API_KEY=k\nHERMES_YOLO_MODE=1\n").unwrap();
        let body = respond(
            &home,
            AdminResultFile(AdminResult {
                status: 200,
                body: serde_json::json!({"ok": true}),
                config: Some(serde_json::json!({
                    "approvals": {"mode": "off"},
                    "skills": {"disabled": ["pdf"]}
                })),
                env_schema: Some(vec!["NOTION_API_KEY".into(), "HERMES_YOLO_MODE".into()]),
                env_secrets: Some(vec!["NOTION_API_KEY".into()]),
            }),
        )
        .unwrap();
        assert_eq!(body["ok"], true);
        let settings = admin_settings::load(&home);
        assert_eq!(
            settings.config.skills_disabled,
            Some(serde_json::json!(["pdf"]))
        );
        let env = settings.env.unwrap();
        assert_eq!(env.get("NOTION_API_KEY").map(String::as_str), Some("k"));
        assert!(!env.contains_key("HERMES_YOLO_MODE"));
        assert!(!serde_json::to_string(&settings.config)
            .unwrap()
            .contains("approvals"));
    }
}
