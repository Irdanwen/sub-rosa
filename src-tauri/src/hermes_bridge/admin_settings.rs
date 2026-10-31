//! The settings a person changes in Settings, kept by the app (ADR-0140).
//!
//! The app rewrites the runtime's `config.yaml` from scratch at every start,
//! and its `.env` too since ADR-0140, so a setting made through the
//! runtime's own routes (an MCP server, a skill switched off, a toolset, a
//! skill's configuration, a key) would not outlive the next start. After
//! each such change, made outside the jail by `admin_once`, the app copies
//! the settings a person owns into `hermes-settings.json`, next to the home
//! and out of the jail's reach, and writes them back at every start.
//!
//! What is copied is a list of named keys, never the file: approvals, the
//! command allowlist, hooks, plugins, the model, the routines' toolsets and
//! every other key stay the app's, whatever the file held.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const SETTINGS_FILE: &str = "hermes-settings.json";

/// The app's record of what a person set.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct HermesSettings {
    #[serde(default)]
    pub config: ConfigOverlay,
    /// The runtime's environment file, by key. `None` until the existing
    /// `.env` has been imported once (see `home_prep::prepare`).
    #[serde(default)]
    pub env: Option<BTreeMap<String, String>>,
    /// The keys Settings can write, as the pinned runtime declares them
    /// (`subrosa_admin.py`, `_env_schema`), refreshed at every start and with
    /// every change. The environment file keeps no other key.
    #[serde(default)]
    pub env_schema: BTreeSet<String>,
    /// Among them, the credentials (a password, a token, a key a skill or a
    /// tool provider asks for): the only keys an import or a skill's setup
    /// may write. The others (a messaging platform's address, port, home
    /// channel, who may write to it) only come from that platform's own
    /// setting, a named gesture of the person.
    #[serde(default)]
    pub env_secrets: BTreeSet<String>,
    /// Whether the first start under ADR-0140 has set aside what was not the
    /// app's (`quarantine.rs`), and what it set aside.
    #[serde(default)]
    pub quarantine_done: bool,
    #[serde(default)]
    pub quarantine: Option<super::quarantine::QuarantineRecord>,
    /// Whether the sandboxed home received, once, the conversations of the
    /// shared home from before the split (`home_split::migrate_once`).
    #[serde(default)]
    pub sandboxed_home_seeded: bool,
}

/// Where a `.env` key comes from, which decides what may pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum KeyUse {
    /// Kept after a named setting wrote it (a messaging platform's own
    /// setting), or written back at a start.
    Kept,
    /// An import of the file found at the first start, or a skill's setup
    /// (`PUT /api/env`): credentials only.
    Credential,
}

/// The schema lists a refresh of the runtime reports.
pub(super) struct EnvSchemaLists {
    pub declared: Vec<String>,
    pub secrets: Vec<String>,
}

/// The `config.yaml` keys a person owns.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct ConfigOverlay {
    /// `mcp_servers.<name>` for every server the app does not build in.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub mcp_servers: Map<String, Value>,
    /// `mcp.exposure_policy`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_exposure_policy: Option<Value>,
    /// `skills.disabled`, `skills.platform_disabled`, `skills.config`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_disabled: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_platform_disabled: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_config: Option<Value>,
    /// `skills.external_dirs`, merged with the app's own folders at start.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills_external_dirs: Vec<String>,
    /// `platform_toolsets.<platform>`, every platform but `cron`, whose list
    /// is the app's gate on what a routine may do.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub platform_toolsets: Map<String, Value>,
    /// `platforms.<platform>.enabled`: a messaging platform switched on or
    /// off. Only the switch: its keys live in `.env`.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub platforms_enabled: Map<String, Value>,
}

impl ConfigOverlay {
    pub(super) fn is_empty(&self) -> bool {
        self == &ConfigOverlay::default()
    }
}

pub(super) fn settings_path(hermes_home: &Path) -> PathBuf {
    hermes_home
        .parent()
        .unwrap_or(hermes_home)
        .join(SETTINGS_FILE)
}

/// The record, or an empty one when there is none or it cannot be read.
pub(super) fn load(hermes_home: &Path) -> HermesSettings {
    std::fs::read_to_string(settings_path(hermes_home))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(super) fn save(hermes_home: &Path, settings: &HermesSettings) -> std::io::Result<()> {
    let path = settings_path(hermes_home);
    let text = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temp, &path)
}

/// After a change made outside the jail: the settings a person owns, read
/// back from the files the runtime's route just wrote. `config` is the
/// runtime's `config.yaml` as JSON (`None` when it could not be read: the
/// record of the config is then kept as it was); `schema`, the keys the
/// runtime declares (`None`: the last one known).
pub(super) fn capture(
    hermes_home: &Path,
    config: Option<&Value>,
    schema: Option<EnvSchemaLists>,
) -> std::io::Result<()> {
    let mut settings = load(hermes_home);
    if let Some(config) = config {
        settings.config = extract(config);
    }
    if let Some(schema) = schema {
        settings.env_schema = schema.declared.into_iter().collect();
        settings.env_secrets = schema.secrets.into_iter().collect();
    }
    let env = std::fs::read_to_string(hermes_home.join(".env")).unwrap_or_default();
    let kept = parse_dotenv(&env)
        .into_iter()
        .filter(|(key, _)| env_key_allowed(key, KeyUse::Kept, &settings))
        .collect();
    settings.env = Some(kept);
    save(hermes_home, &settings)
}

/// Records the keys the runtime declares, from a start's refresh.
pub(super) fn record_schema(hermes_home: &Path, schema: EnvSchemaLists) -> std::io::Result<()> {
    let mut settings = load(hermes_home);
    settings.env_schema = schema.declared.into_iter().collect();
    settings.env_secrets = schema.secrets.into_iter().collect();
    save(hermes_home, &settings)
}

/// The gateway's "platforms" that are not a messaging service but a door on
/// the network (an agent API, webhooks, a relay): Sub Rosa offers none of
/// them, so neither a setting nor the record may switch one on (ADR-0140).
pub(super) const NETWORK_PLATFORMS: &[&str] =
    &["api_server", "webhook", "msgraph_webhook", "relay"];

/// A name the runtime and the YAML both take as written.
fn is_slug(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The keys a person owns, out of a whole `config.yaml` (as JSON).
pub(super) fn extract(config: &Value) -> ConfigOverlay {
    let mut overlay = ConfigOverlay::default();
    if let Some(servers) = config.get("mcp_servers").and_then(Value::as_object) {
        for (name, entry) in servers {
            if is_slug(name) && entry.is_object() && !super::builtin_mcp::is_builtin_server(name) {
                overlay.mcp_servers.insert(name.clone(), entry.clone());
            }
        }
    }
    overlay.mcp_exposure_policy = config
        .get("mcp")
        .and_then(|mcp| mcp.get("exposure_policy"))
        .filter(|value| !value.is_null())
        .cloned();
    if let Some(skills) = config.get("skills").and_then(Value::as_object) {
        let pick = |key: &str| skills.get(key).filter(|value| !value.is_null()).cloned();
        overlay.skills_disabled = pick("disabled");
        overlay.skills_platform_disabled = pick("platform_disabled");
        overlay.skills_config = pick("config");
        if let Some(dirs) = skills.get("external_dirs").and_then(Value::as_array) {
            overlay.skills_external_dirs = dirs
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
    }
    if let Some(platforms) = config.get("platform_toolsets").and_then(Value::as_object) {
        for (platform, toolsets) in platforms {
            if platform != "cron" && is_slug(platform) && toolsets.is_array() {
                overlay
                    .platform_toolsets
                    .insert(platform.clone(), toolsets.clone());
            }
        }
    }
    if let Some(platforms) = config.get("platforms").and_then(Value::as_object) {
        for (platform, entry) in platforms {
            if let Some(enabled) = entry.get("enabled").filter(|value| value.is_boolean()) {
                if is_slug(platform) && !NETWORK_PLATFORMS.contains(&platform.as_str()) {
                    overlay
                        .platforms_enabled
                        .insert(platform.clone(), enabled.clone());
                }
            }
        }
    }
    overlay
}

/// Where the app keeps a home's `config.yaml` as it rendered it, before the
/// person's settings: in its data folder, so a settings change can write
/// that home's file again without a restart (`reapply`).
pub(super) fn base_path(hermes_home: &Path) -> PathBuf {
    let name = hermes_home
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "hermes".to_string());
    hermes_home
        .parent()
        .unwrap_or(hermes_home)
        .join(format!("{name}.config-base.yaml"))
}

/// Writes a home's `config.yaml` and `.env` again from the base the app
/// rendered at its last start and the record (ADR-0140): after a settings
/// change made on the shared home, the sandboxed home shows it too.
pub(super) fn reapply(hermes_home: &Path) -> std::io::Result<()> {
    let base = match std::fs::read_to_string(base_path(hermes_home)) {
        Ok(base) => base,
        // Never started: its first start renders everything.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let settings = load(hermes_home);
    super::home_prep::write_owned(
        &hermes_home.join("config.yaml"),
        &apply_overlay(base, &settings.config),
    )?;
    super::home_prep::write_owned(
        &hermes_home.join(".env"),
        &render_dotenv(&settings.env.clone().unwrap_or_default(), &settings),
    )
}

/// Writes the person's settings into the `config.yaml` the app rendered.
/// Values go in as JSON, which YAML reads as flow collections, inserted
/// under the sections the app's file already has (a second `skills:` would
/// replace the app's). `skills.external_dirs` is merged before rendering.
pub(super) fn apply_overlay(config: String, overlay: &ConfigOverlay) -> String {
    if overlay.is_empty() {
        return config;
    }
    let line =
        |key: &str, value: &Value| format!("  {}: {}\n", json(&Value::from(key)), json(value));
    let mut skills = String::new();
    for (key, value) in [
        ("disabled", &overlay.skills_disabled),
        ("platform_disabled", &overlay.skills_platform_disabled),
        ("config", &overlay.skills_config),
    ] {
        if let Some(value) = value {
            skills.push_str(&line(key, value));
        }
    }
    let toolsets: String = overlay
        .platform_toolsets
        .iter()
        .map(|(platform, value)| line(platform, value))
        .collect();
    let servers: String = overlay
        .mcp_servers
        .iter()
        .map(|(name, value)| line(name, value))
        .collect();
    let platforms: String = overlay
        .platforms_enabled
        .iter()
        .map(|(platform, enabled)| line(platform, &serde_json::json!({ "enabled": enabled })))
        .collect();
    let config = insert_external_dirs(config, &overlay.skills_external_dirs);
    let mut config = insert_under(config, "skills:", &skills);
    config = insert_under(config, "platforms:", &platforms);
    config = insert_under(config, "platform_toolsets:", &toolsets);
    config = config.replace("\nmcp_servers: {}\n", "\nmcp_servers:\n");
    config = insert_under(config, "mcp_servers:", &servers);
    if let Some(policy) = &overlay.mcp_exposure_policy {
        if !config.ends_with('\n') {
            config.push('\n');
        }
        config.push_str("mcp:\n");
        config.push_str(&line("exposure_policy", policy));
    }
    config
}

/// Adds the person's skill folders to `skills.external_dirs` (the app's own
/// come first), each once.
fn insert_external_dirs(mut config: String, dirs: &[String]) -> String {
    let lines: String = dirs
        .iter()
        .filter(|dir| !config.contains(&json(&Value::from(dir.as_str()))))
        .map(|dir| format!("    - {}\n", json(&Value::from(dir.as_str()))))
        .collect();
    if lines.is_empty() {
        return config;
    }
    if config.contains("\n  external_dirs: []\n") {
        return config.replace(
            "\n  external_dirs: []\n",
            &format!("\n  external_dirs:\n{lines}"),
        );
    }
    if let Some(at) = config.find("\n  external_dirs:\n") {
        config.insert_str(at + "\n  external_dirs:\n".len(), &lines);
        return config;
    }
    config
}

/// Inserts `lines` right under the top-level `section` line, adding the
/// section at the end when the file has none.
fn insert_under(mut config: String, section: &str, lines: &str) -> String {
    if lines.is_empty() {
        return config;
    }
    let header = format!("{section}\n");
    let at = if config.starts_with(&header) {
        Some(0)
    } else {
        config.find(&format!("\n{header}")).map(|index| index + 1)
    };
    match at {
        Some(index) => config.insert_str(index + header.len(), lines),
        None => {
            if !config.ends_with('\n') {
                config.push('\n');
            }
            config.push_str(&header);
            config.push_str(lines);
        }
    }
    config
}

fn json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// Whether a key may sit in the runtime's environment file. Only a key the
/// runtime declares as one Settings write (`env_schema`: a credential, a
/// messaging platform's setting, a tool provider's key, a key an installed
/// skill asks for, an MCP server's token), and never one that changes what
/// needs approval or how commands run (`HERMES_*`, `SUDO_*`, `TERMINAL_*`,
/// the scanner's `TIRITH_*`), opens the gateway to the network (its API
/// server, its webhooks, `GATEWAY_*`) or sends traffic elsewhere
/// (`*_PROXY`). A `Credential` use (the import, a skill's setup) keeps only
/// credentials, and none that is an address, a port, a switch, a home
/// channel or a list of who may command the gateway.
pub(super) fn env_key_allowed(key: &str, use_: KeyUse, settings: &HermesSettings) -> bool {
    let well_formed = !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !well_formed || !settings.env_schema.contains(key) {
        return false;
    }
    const NEVER: &[&str] = &[
        "HERMES_",
        "SUDO_",
        "TERMINAL_",
        "TIRITH_",
        "API_SERVER_",
        "WEBHOOK_",
        "GATEWAY_",
    ];
    let upper = key.to_ascii_uppercase();
    if NEVER.iter().any(|prefix| upper.starts_with(prefix)) || upper.ends_with("_PROXY") {
        return false;
    }
    match use_ {
        KeyUse::Kept => true,
        KeyUse::Credential => {
            const STRUCTURE: &[&str] = &[
                "_HOST",
                "_PORT",
                "_URL",
                "_ENDPOINT",
                "_ENABLED",
                "_HOME_CHANNEL",
                "_HOME_CHANNEL_NAME",
            ];
            settings.env_secrets.contains(key)
                && !STRUCTURE.iter().any(|suffix| upper.ends_with(suffix))
                && !upper.contains("ALLOW")
        }
    }
}

/// A small `.env` reader: `KEY=value` lines, an optional `export `, single
/// quotes literal, double quotes with `\\`, `\"` and `\n`, an unquoted value
/// trimmed and cut at ` #`. Blank lines, comments and malformed lines are
/// skipped.
pub(super) fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        let value = if let Some(rest) = value.strip_prefix('\'') {
            match rest.find('\'') {
                Some(end) => rest[..end].to_string(),
                None => continue,
            }
        } else if let Some(rest) = value.strip_prefix('"') {
            let mut parsed = String::new();
            let mut chars = rest.chars();
            let mut closed = false;
            while let Some(ch) = chars.next() {
                match ch {
                    '"' => {
                        closed = true;
                        break;
                    }
                    '\\' => match chars.next() {
                        Some('n') => parsed.push('\n'),
                        Some(other) => parsed.push(other),
                        None => break,
                    },
                    other => parsed.push(other),
                }
            }
            if !closed {
                continue;
            }
            parsed
        } else {
            value
                .split_once(" #")
                .map(|(before, _)| before)
                .unwrap_or(value)
                .trim()
                .to_string()
        };
        out.push((key.to_string(), value));
    }
    out
}

/// The `.env` the app writes at every start: values single-quoted (read
/// literally), or double-quoted with escapes when they hold a quote or a
/// line break.
pub(super) fn render_dotenv(env: &BTreeMap<String, String>, settings: &HermesSettings) -> String {
    let mut out = String::from(
        "# Written by Sub Rosa at every start (ADR-0140). Change these in Settings:\n\
         # a line added here is gone at the next start.\n",
    );
    for (key, value) in env {
        if !env_key_allowed(key, KeyUse::Kept, settings) {
            continue;
        }
        if value.contains('\'') || value.contains('\n') || value.contains('\r') {
            let escaped = value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
                .replace('\r', "");
            out.push_str(&format!("{key}=\"{escaped}\"\n"));
        } else {
            out.push_str(&format!("{key}='{value}'\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_keys_a_person_owns_are_kept() {
        let config = json!({
            "approvals": {"mode": "off"},
            "command_allowlist": ["*"],
            "hooks": {"pre_tool_call": [{"command": "/tmp/x"}]},
            "plugins": {"enabled": ["planted"]},
            "model": {"base_url": "http://evil"},
            "platform_toolsets": {"cron": ["terminal"], "cli": ["web", "terminal"]},
            "mcp_servers": {
                "june_context": {"command": "/tmp/evil"},
                "notion": {"url": "https://mcp.notion.com/mcp", "enabled": true},
                "bad name": {"command": "x"}
            },
            "mcp": {"exposure_policy": {"default": "ask"}},
            "platforms": {"telegram": {"enabled": true, "home_channel": "planted"}, "x y": {"enabled": true}, "api_server": {"enabled": true}},
            "skills": {"disabled": ["pdf"], "config": {"pdf": {"dpi": 300}}, "external_dirs": ["/x"]}
        });
        let overlay = extract(&config);
        assert_eq!(overlay.mcp_servers.len(), 1);
        assert!(overlay.mcp_servers.contains_key("notion"));
        assert_eq!(overlay.platform_toolsets.len(), 1, "cron is the app's");
        assert_eq!(overlay.platform_toolsets["cli"], json!(["web", "terminal"]));
        assert_eq!(overlay.skills_disabled, Some(json!(["pdf"])));
        assert_eq!(overlay.skills_external_dirs, vec!["/x".to_string()]);
        assert_eq!(overlay.platforms_enabled.len(), 1);
        assert_eq!(overlay.platforms_enabled["telegram"], json!(true));
        let text = serde_json::to_string(&overlay).unwrap();
        for authority in ["approvals", "command_allowlist", "hooks", "planted", "evil"] {
            assert!(!text.contains(authority), "{authority} kept");
        }
    }

    #[test]
    fn the_overlay_lands_under_the_apps_sections_and_reads_back() {
        let base = "model:\n  default: \"m\"\nplatform_toolsets:\n  cron: [web]\nskills:\n  external_dirs: []\nmcp_servers:\n  june_context:\n    enabled: true\nplugins:\n  enabled:\n    - subrosa_guard\n".to_string();
        let overlay = ConfigOverlay {
            mcp_servers: [(
                "notion".to_string(),
                json!({"url": "https://x/mcp", "headers": {"A": "b: c #d"}}),
            )]
            .into_iter()
            .collect(),
            mcp_exposure_policy: Some(json!({"default": "ask"})),
            skills_disabled: Some(json!(["pdf"])),
            platform_toolsets: [("cli".to_string(), json!(["web"]))].into_iter().collect(),
            platforms_enabled: [("telegram".to_string(), json!(true))]
                .into_iter()
                .collect(),
            skills_external_dirs: vec!["/Users/a/my skills".into()],
            ..ConfigOverlay::default()
        };
        let text = apply_overlay(base.clone(), &overlay);
        assert!(!text.contains("home_channel"));
        let value: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        assert_eq!(value["mcp_servers"]["notion"]["headers"]["A"], "b: c #d");
        assert_eq!(value["mcp_servers"]["june_context"]["enabled"], true);
        assert_eq!(value["platform_toolsets"]["cron"][0], "web");
        assert_eq!(value["platform_toolsets"]["cli"][0], "web");
        assert_eq!(value["skills"]["disabled"][0], "pdf");
        assert_eq!(value["skills"]["external_dirs"][0], "/Users/a/my skills");
        assert_eq!(value["mcp"]["exposure_policy"]["default"], "ask");
        assert_eq!(value["plugins"]["enabled"][0], "subrosa_guard");
        assert_eq!(value["platforms"]["telegram"]["enabled"], true);
        // Nothing to add, nothing changed.
        assert_eq!(apply_overlay(base.clone(), &ConfigOverlay::default()), base);
    }

    #[test]
    fn an_empty_server_map_takes_the_persons_servers() {
        let overlay = ConfigOverlay {
            mcp_servers: [("x".to_string(), json!({"command": "/bin/x"}))]
                .into_iter()
                .collect(),
            ..ConfigOverlay::default()
        };
        let text = apply_overlay(
            "skills:\n  external_dirs: []\nmcp_servers: {}\n".into(),
            &overlay,
        );
        let value: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        assert_eq!(value["mcp_servers"]["x"]["command"], "/bin/x");
    }

    fn known(declared: &[&str], secrets: &[&str]) -> HermesSettings {
        HermesSettings {
            env_schema: declared.iter().map(|key| key.to_string()).collect(),
            env_secrets: secrets.iter().map(|key| key.to_string()).collect(),
            ..HermesSettings::default()
        }
    }

    #[test]
    fn only_keys_the_runtime_declares_reach_the_environment_file() {
        let settings = known(
            &[
                "NOTION_API_KEY",
                "TELEGRAM_BOT_TOKEN",
                "TELEGRAM_ALLOWED_USERS",
                "TELEGRAM_HOME_CHANNEL",
                "TELEGRAM_PROXY",
                "SUDO_PASSWORD",
                "HERMES_LANGFUSE_SECRET_KEY",
                "API_SERVER_KEY",
                "API_SERVER_ENABLED",
                "API_SERVER_HOST",
                "WEBHOOK_SECRET",
                "FIRECRAWL_API_URL",
            ],
            &[
                "NOTION_API_KEY",
                "TELEGRAM_BOT_TOKEN",
                "SUDO_PASSWORD",
                "API_SERVER_KEY",
                "WEBHOOK_SECRET",
                "FIRECRAWL_API_URL",
            ],
        );
        // Kept after the platform's own setting wrote them.
        for key in [
            "NOTION_API_KEY",
            "TELEGRAM_BOT_TOKEN",
            "TELEGRAM_ALLOWED_USERS",
            "TELEGRAM_HOME_CHANNEL",
        ] {
            assert!(
                env_key_allowed(key, KeyUse::Kept, &settings),
                "{key} refused"
            );
        }
        // Imported or set by a skill's setup: credentials only.
        for key in ["NOTION_API_KEY", "TELEGRAM_BOT_TOKEN"] {
            assert!(
                env_key_allowed(key, KeyUse::Credential, &settings),
                "{key} refused"
            );
        }
        for key in [
            "TELEGRAM_ALLOWED_USERS",
            "TELEGRAM_HOME_CHANNEL",
            "FIRECRAWL_API_URL",
        ] {
            assert!(
                !env_key_allowed(key, KeyUse::Credential, &settings),
                "{key} imported"
            );
        }
        // Never, whatever the use: the gateway's agent API and webhooks, a
        // proxy, what changes approvals or how commands run.
        for key in [
            "API_SERVER_KEY",
            "API_SERVER_ENABLED",
            "API_SERVER_HOST",
            "WEBHOOK_SECRET",
            "TELEGRAM_PROXY",
            "SUDO_PASSWORD",
            "HERMES_LANGFUSE_SECRET_KEY",
        ] {
            assert!(!env_key_allowed(key, KeyUse::Kept, &settings), "{key} kept");
            assert!(
                !env_key_allowed(key, KeyUse::Credential, &settings),
                "{key} imported"
            );
        }
        // Not declared at all.
        for key in [
            "PIP_INDEX_URL",
            "UV_INDEX_URL",
            "SOME_UNKNOWN_KEY",
            "PATH",
            "bad-key",
            "",
        ] {
            assert!(
                !env_key_allowed(key, KeyUse::Kept, &settings),
                "{key} allowed"
            );
        }
        assert!(!env_key_allowed(
            "NOTION_API_KEY",
            KeyUse::Kept,
            &HermesSettings::default()
        ));
    }

    #[test]
    fn the_environment_file_round_trips() {
        let mut env = BTreeMap::new();
        env.insert("A".to_string(), "plain value".to_string());
        env.insert(
            "B".to_string(),
            "it's \"quoted\"\nand two lines \\ back".to_string(),
        );
        env.insert(
            "C".to_string(),
            "${NOT_EXPANDED} #not a comment".to_string(),
        );
        env.insert("HERMES_YOLO_MODE".to_string(), "1".to_string());
        let text = render_dotenv(&env, &known(&["A", "B", "C", "HERMES_YOLO_MODE"], &[]));
        assert!(!text.contains("HERMES_YOLO_MODE"));
        let parsed: BTreeMap<String, String> = parse_dotenv(&text).into_iter().collect();
        env.remove("HERMES_YOLO_MODE");
        assert_eq!(parsed, env);
        let parsed =
            parse_dotenv("export X=1 # note\nY=\"a\\\"b\"\n# c\nbroken\nZ='unterminated\n");
        assert_eq!(
            parsed,
            vec![("X".into(), "1".into()), ("Y".into(), "a\"b".into())]
        );
    }
}
