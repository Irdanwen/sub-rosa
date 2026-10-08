//! The connectors as one built-in MCP server of the agent runtime
//! (ADR-0092, addendum of 2026-10-08): its script, its entry in the
//! `config.yaml` the app writes, and the loopback route it calls.
//!
//! The script holds no connector, no token and no rule. It lists what the
//! app lists and forwards each call to `/v1/connectors` on the provider
//! proxy, where `crate::connectors::hermes` reads the rules and runs the
//! call through the same runtime the phones use.

use std::path::Path;

use crate::domain::types::AppError;

const SCRIPT_NAME: &str = "subrosa_connectors_mcp.py";
const SCRIPT: &str = include_str!("../hermes/subrosa_connectors_mcp.py");

/// Writes the script beside the other built-in servers. Rewritten at every
/// runtime start, so an app update carries it.
pub(super) fn install(app: &tauri::AppHandle) -> Result<(), AppError> {
    let failed =
        |error: std::io::Error| AppError::new("hermes_connectors_mcp_failed", error.to_string());
    let dir = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("hermes_connectors_mcp_failed", error.to_string()))?
        .join(super::JUNE_CONTEXT_MCP_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(failed)?;
    std::fs::write(dir.join(SCRIPT_NAME), SCRIPT).map_err(failed)
}

/// The server's entry under `mcp_servers:`, beside the studio server whose
/// interpreter and proxy coordinates it shares (the script lives in the
/// same directory as that coordinates file).
pub(super) fn entry(studio: &super::JuneStudioMcpConfig) -> String {
    render_entry(&studio.command, &studio.coordinates_path)
}

fn render_entry(command: &str, coordinates_path: &Path) -> String {
    let script = coordinates_path
        .parent()
        .map(|dir| dir.join(SCRIPT_NAME))
        .unwrap_or_else(|| Path::new(SCRIPT_NAME).to_path_buf());
    format!(
        r#"  {server}:
    enabled: true
    command: {command}
    args:
      - {script}
      - {coordinates}
    env:
      PYTHONUNBUFFERED: "1"
    timeout: 120
    connect_timeout: 10
"#,
        server = crate::connectors::hermes::SERVER,
        command = super::yaml_string(command),
        script = super::yaml_string(&script.to_string_lossy()),
        coordinates = super::yaml_string(&coordinates_path.to_string_lossy()),
    )
}

/// `POST /v1/connectors` on the provider proxy.
pub(super) async fn route(
    app: &tauri::AppHandle,
    stream: &mut tokio::net::TcpStream,
    request: &super::HttpRequest,
) -> std::io::Result<()> {
    let body = &request.body;
    let (status, value) = match crate::commands::repositories(app).await {
        Ok(repos) => {
            let home = super::resolve_june_hermes_home(app).ok();
            crate::connectors::hermes::route(&repos.pool, body, |name| {
                home.as_deref()
                    .and_then(|home| super::guard::published_connector_rule(home, name))
            })
            .await
        }
        Err(error) => (
            503,
            serde_json::json!({"error": {"message": error.message}}),
        ),
    };
    super::write_json_response(stream, status, value).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_runs_the_script_beside_the_coordinates() {
        let entry = render_entry(
            "/opt/hermes/python3",
            Path::new("/tmp/june/hermes-mcp/june_web_proxy.json"),
        );
        assert!(entry.starts_with("  subrosa_connectors:\n    enabled: true\n"));
        assert!(entry.contains("      - \"/tmp/june/hermes-mcp/subrosa_connectors_mcp.py\"\n"));
        assert!(entry.contains("      - \"/tmp/june/hermes-mcp/june_web_proxy.json\"\n"));
        // It carries no token: the script reads the coordinates file per call.
        assert!(!entry.contains("token"));
    }

    #[test]
    fn the_script_speaks_to_the_route_and_says_when_its_list_changed() {
        assert!(SCRIPT.contains("/connectors"));
        assert!(SCRIPT.contains("notifications/tools/list_changed"));
        assert!(SCRIPT.contains("\"listChanged\": True"));
    }
}
