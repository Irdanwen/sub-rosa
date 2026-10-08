//! The built-in MCP servers' entries in `config.yaml`, and the agent
//! browser's relay (ADR-0094). Moved out of `hermes_bridge.rs` so the file
//! the ratchet holds does not grow with each new server.

use std::path::{Path, PathBuf};

use super::{
    write_json_response, yaml_string, JUNE_CONTEXT_MCP_SERVER_NAME, JUNE_MEDIA_MCP_SERVER_NAME,
    JUNE_STUDIO_MCP_SERVER_NAME, JUNE_WEB_MCP_SERVER_NAME,
};

const JUNE_BROWSER_MCP_SERVER_NAME: &str = "june_browser";
const JUNE_BROWSER_MCP_SCRIPT_NAME: &str = "june_browser_mcp.py";
pub(super) const JUNE_BROWSER_MCP_SCRIPT: &str = include_str!("../hermes/june_browser_mcp.py");

#[derive(Debug, Clone)]
pub(super) struct JuneContextMcpConfig {
    pub(super) command: String,
    pub(super) script_path: PathBuf,
    pub(super) database_path: PathBuf,
    /// Snapshot of the user's memory master toggle at spawn time: when off,
    /// the MCP is launched with `--memory=off` so the recall tool is not even
    /// advertised to the agent.
    pub(super) memory_enabled: bool,
    /// The provider-proxy coordinates file. The calendar is local data like
    /// the notes, but it lives in EventKit rather than SQLite, so that one
    /// tool round-trips through the app instead of reading the database.
    pub(super) coordinates_path: PathBuf,
}

#[derive(Debug, Clone)]
pub(super) struct JuneWebMcpConfig {
    pub(super) command: String,
    pub(super) script_path: PathBuf,
    /// Path to the proxy-coordinates JSON the script re-reads per tool call
    /// (see [`JUNE_WEB_MCP_COORDS_NAME`]).
    pub(super) coordinates_path: PathBuf,
}

/// The media MCP shares the provider proxy and its coordinates file with the
/// web MCP; only the script differs.
#[derive(Debug, Clone)]
pub(super) struct JuneMediaMcpConfig {
    pub(super) command: String,
    pub(super) script_path: PathBuf,
    pub(super) coordinates_path: PathBuf,
}

pub(super) struct JuneStudioMcpConfig {
    pub(super) command: String,
    pub(super) script_path: PathBuf,
    pub(super) coordinates_path: PathBuf,
}

/// Renders the `mcp_servers:` block listing every built-in MCP server June
/// registers. All entries live under one key so Hermes deep-merges a single
/// map; an empty map is emitted when none is configured.
pub(super) fn render_mcp_servers_config(
    context: Option<&JuneContextMcpConfig>,
    web: Option<&JuneWebMcpConfig>,
    media: Option<&JuneMediaMcpConfig>,
    studio: Option<&JuneStudioMcpConfig>,
) -> String {
    let mut entries = String::new();
    if let Some(config) = context {
        entries.push_str(&render_context_mcp_entry(config));
    }
    if let Some(config) = web {
        entries.push_str(&render_web_mcp_entry(config));
    }
    if let Some(config) = media {
        entries.push_str(&render_media_mcp_entry(config));
    }
    if let Some(config) = studio {
        entries.push_str(&render_studio_mcp_entry(config));
        // The browser rides the studio server's interpreter and coordinates
        // file; only its script differs (ADR-0094).
        entries.push_str(&render_browser_mcp_entry(config));
        // Connectors ride the same interpreter and coordinates file
        // (ADR-0092 addendum).
        entries.push_str(&super::connectors_mcp::entry(config));
    }
    if entries.is_empty() {
        return "mcp_servers: {}\n".to_string();
    }
    format!("mcp_servers:\n{entries}")
}

pub(super) fn render_context_mcp_entry(config: &JuneContextMcpConfig) -> String {
    let memory_arg = crate::memory::past_chats::context_mcp_args(config.memory_enabled);
    format!(
        r#"  {server_name}:
    enabled: true
    command: {command}
    args:
      - {script_path}
      - {database_path}
{memory_arg}      - {proxy_arg}
    env:
      PYTHONUNBUFFERED: "1"
    timeout: 30
    connect_timeout: 10
"#,
        server_name = JUNE_CONTEXT_MCP_SERVER_NAME,
        command = yaml_string(&config.command),
        script_path = yaml_string(&config.script_path.to_string_lossy()),
        database_path = yaml_string(&config.database_path.to_string_lossy()),
        proxy_arg = yaml_string(&format!(
            "--proxy={}",
            config.coordinates_path.to_string_lossy()
        )),
    )
}

/// The web MCP gets the path to the proxy-coordinates file as its argument,
/// not the proxy URL/token themselves: the script re-reads that file on every
/// tool call, so a server hosted by the long-lived Hermes gateway keeps
/// working after the app relaunches on a new ephemeral proxy port. The token
/// lives in the (0600) coordinates file rather than argv or env.
fn render_web_mcp_entry(config: &JuneWebMcpConfig) -> String {
    format!(
        r#"  {server_name}:
    enabled: true
    command: {command}
    args:
      - {script_path}
      - {coordinates_path}
    env:
      PYTHONUNBUFFERED: "1"
    timeout: 30
    connect_timeout: 10
"#,
        server_name = JUNE_WEB_MCP_SERVER_NAME,
        command = yaml_string(&config.command),
        script_path = yaml_string(&config.script_path.to_string_lossy()),
        coordinates_path = yaml_string(&config.coordinates_path.to_string_lossy()),
    )
}

/// Same coordinates-file contract as the web MCP. The timeout is much higher
/// than the web tools': a synchronous image generation legitimately runs up
/// to the backend's ~60 s edge cap (plus the queue fallback), and completing
/// a video/music job downloads the file before returning.
/// Same coordinates-file contract again. The studio surface is typed actions
/// against the app's own commands, so 300 seconds is generous: the slowest of
/// them starts a background reading and returns immediately.
fn render_studio_mcp_entry(config: &JuneStudioMcpConfig) -> String {
    format!(
        r#"  {server_name}:
    enabled: true
    command: {command}
    args:
      - {script_path}
      - {coordinates_path}
    env:
      PYTHONUNBUFFERED: "1"
    timeout: 300
    connect_timeout: 10
"#,
        server_name = JUNE_STUDIO_MCP_SERVER_NAME,
        command = yaml_string(&config.command),
        script_path = yaml_string(&config.script_path.to_string_lossy()),
        coordinates_path = yaml_string(&config.coordinates_path.to_string_lossy()),
    )
}

fn render_media_mcp_entry(config: &JuneMediaMcpConfig) -> String {
    format!(
        r#"  {server_name}:
    enabled: true
    command: {command}
    args:
      - {script_path}
      - {coordinates_path}
    env:
      PYTHONUNBUFFERED: "1"
    timeout: 300
    connect_timeout: 10
"#,
        server_name = JUNE_MEDIA_MCP_SERVER_NAME,
        command = yaml_string(&config.command),
        script_path = yaml_string(&config.script_path.to_string_lossy()),
        coordinates_path = yaml_string(&config.coordinates_path.to_string_lossy()),
    )
}

/// Writes the browser relay next to the studio script it shares a directory
/// and an interpreter with.
pub(super) fn write_browser_script(mcp_dir: &Path) -> std::io::Result<()> {
    std::fs::write(
        mcp_dir.join(JUNE_BROWSER_MCP_SCRIPT_NAME),
        JUNE_BROWSER_MCP_SCRIPT,
    )
}

/// The browser's timeout covers a consent card the person may take minutes
/// to answer, on top of the page itself.
fn render_browser_mcp_entry(studio: &JuneStudioMcpConfig) -> String {
    let script_path = studio
        .script_path
        .parent()
        .map(|dir| dir.join(JUNE_BROWSER_MCP_SCRIPT_NAME))
        .unwrap_or_else(|| PathBuf::from(JUNE_BROWSER_MCP_SCRIPT_NAME));
    format!(
        r#"  {server_name}:
    enabled: true
    command: {command}
    args:
      - {script_path}
      - {coordinates_path}
    env:
      PYTHONUNBUFFERED: "1"
    timeout: 300
    connect_timeout: 10
"#,
        server_name = JUNE_BROWSER_MCP_SERVER_NAME,
        command = yaml_string(&studio.command),
        script_path = yaml_string(&script_path.to_string_lossy()),
        coordinates_path = yaml_string(&studio.coordinates_path.to_string_lossy()),
    )
}

/// `/v1/browser/request`: one named browser action, run by the app.
pub(super) async fn forward_browser_request(
    app: &tauri::AppHandle,
    stream: &mut tokio::net::TcpStream,
    request_body: &[u8],
) -> std::io::Result<()> {
    let payload = serde_json::from_slice::<serde_json::Value>(request_body).unwrap_or_default();
    let action = payload
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let params = payload
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    match crate::agent_browser::dispatch(app.clone(), &action, params).await {
        Ok(value) => write_json_response(stream, 200, value).await,
        Err(error) => {
            write_json_response(
                stream,
                400,
                serde_json::json!({ "error": { "code": error.code, "message": error.message } }),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_browser_server_is_registered_beside_the_studio_one() {
        let studio = JuneStudioMcpConfig {
            command: "/venv/bin/python".to_string(),
            script_path: PathBuf::from("/data/hermes-mcp/june_studio_mcp.py"),
            coordinates_path: PathBuf::from("/data/hermes-mcp/coords.json"),
        };
        let block = render_mcp_servers_config(None, None, None, Some(&studio));
        assert!(block.contains("  june_browser:\n"));
        assert!(block.contains("/data/hermes-mcp/june_browser_mcp.py"));
        assert!(block.contains("/data/hermes-mcp/coords.json"));
    }

    #[test]
    fn the_relay_names_every_action_the_app_dispatches() {
        for action in [
            "open_url",
            "snapshot",
            "click",
            "type",
            "select",
            "scroll",
            "back",
            "wait_for",
            "extract_text",
            "screenshot",
            "close",
        ] {
            assert!(
                JUNE_BROWSER_MCP_SCRIPT.contains(&format!("\"{action}\"")),
                "{action} is not relayed"
            );
        }
        // The relay never handles a page itself.
        assert!(!JUNE_BROWSER_MCP_SCRIPT.contains("remote-debugging"));
    }
}
