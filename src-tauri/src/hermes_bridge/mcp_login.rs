//! The `hermes mcp login` command (ADR-0140): run in the home of the
//! session that asks, under the reader's jail for a sandboxed one, in its
//! own session and with its jail's mark. Moved out of `hermes_bridge.rs`.

use std::path::Path;
use std::process::{Command, Stdio};

use super::HermesBridgeConnection;

/// Builds the `hermes mcp login <server> --profile default` command, isolated to
/// the connection's home/token, non-interactive, in the connection's mode. Pure
/// (no spawn) so a test can assert the exact argument vector and that the server
/// name is a discrete argument rather than shell-interpolated.
pub(super) fn build_hermes_mcp_login_command(
    connection: &HermesBridgeConnection,
    server: &str,
    _profile: Option<&str>,
    jail: Option<&Path>,
) -> Command {
    // Each side signs in on its own home (ADR-0140): a sandboxed sign-in runs
    // under the jail and keeps its tokens there; none is copied across.
    let hermes_home = super::session_owner::Owner::of_mode(connection.full_mode)
        .home(Path::new(&connection.hermes_home));
    let mut cmd = match jail {
        Some(profile) => {
            let mut cmd = Command::new(super::SANDBOX_EXEC_PATH);
            cmd.arg("-f").arg(profile).arg(&connection.command);
            cmd
        }
        None => Command::new(&connection.command),
    };
    cmd.args(["mcp", "login", server]);
    // Always the default profile, whatever the webview asked (ADR-0140): the
    // app provisions no other, and another one's home is not the app's.
    cmd.args([super::HERMES_PROFILE_FLAG, super::HERMES_DEFAULT_PROFILE]);
    super::apply_isolated_hermes_env(&mut cmd, &hermes_home, &connection.token, None);
    // Non-interactive: the CLI must print the authorization URL and not block on
    // a terminal prompt June cannot answer. June opens the URL in the browser.
    cmd.env("HERMES_NONINTERACTIVE", "1");
    cmd.current_dir(&hermes_home);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Its own session, and a jailed sign-in carries its jail's mark (D5).
    super::sandbox_profile::own_session(&mut cmd);
    if jail.is_some() {
        cmd.env(
            super::jail_reaper::JAIL_MARK_ENV,
            super::jail_reaper::new_mark(),
        );
        super::sandbox_profile::apply_jail_env(
            &mut cmd,
            super::sandbox_profile::prepare_jail_tmp().ok().as_deref(),
        );
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn oauth_test_connection() -> HermesBridgeConnection {
        HermesBridgeConnection {
            base_url: "http://127.0.0.1:8787".to_string(),
            ws_url: "ws://127.0.0.1:8787/api/ws".to_string(),
            token: "secret-session-token".to_string(),
            port: 8787,
            command: "/usr/local/bin/hermes".to_string(),
            hermes_home: "/tmp/hermes-home".to_string(),
            cwd: None,
            working_dir: None,
            provider_proxy_port: 9000,
            pid: 4242,
            sandboxed: true,
            full_mode: false,
        }
    }

    #[test]
    fn mcp_login_command_passes_server_as_discrete_argument() {
        let connection = oauth_test_connection();
        let cmd = build_hermes_mcp_login_command(&connection, "linear", Some("work"), None);
        let program = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(program, "/usr/local/bin/hermes");
        // ADR-0140: whatever profile was asked, the default one.
        assert_eq!(args, vec!["mcp", "login", "linear", "--profile", "default"]);
    }

    #[test]
    fn mcp_login_command_names_the_default_profile_when_none() {
        let connection = oauth_test_connection();
        let cmd = build_hermes_mcp_login_command(&connection, "linear", None, None);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["mcp", "login", "linear", "--profile", "default"]);
    }

    /// ADR-0140 (F2): each side signs in on its own home, the sandboxed one
    /// under the jail; no sign-in is copied from one home to the other.
    #[test]
    fn mcp_login_signs_in_on_the_sessions_own_home() {
        let home_of = |cmd: &Command| {
            cmd.get_envs()
                .find(|(key, _)| *key == "HERMES_HOME")
                .and_then(|(_, value)| value)
                .map(PathBuf::from)
        };
        let mut connection = oauth_test_connection();
        connection.hermes_home = "/data/hermes-sandboxed".to_string();
        let jailed = build_hermes_mcp_login_command(
            &connection,
            "linear",
            None,
            Some(Path::new("/data/reader.sb")),
        );
        assert_eq!(jailed.get_program(), super::super::SANDBOX_EXEC_PATH);
        assert!(jailed.get_envs().any(|(key, value)| key
            == super::super::jail_reaper::JAIL_MARK_ENV
            && value.is_some()));
        assert_eq!(
            home_of(&jailed),
            Some(PathBuf::from("/data/hermes-sandboxed"))
        );
        connection.full_mode = true;
        let full = build_hermes_mcp_login_command(&connection, "linear", None, None);
        assert_eq!(full.get_program(), "/usr/local/bin/hermes");
        assert_eq!(home_of(&full), Some(PathBuf::from("/data/hermes")));
    }
}
