//! The `hermes gateway start` command, and why a debug build may not run it.
//!
//! The bundled runtime names its gateway service after its own home
//! (`gateway_label`), so each Sub Rosa build has a gateway of its own. Before
//! starting it, the app removes the service this home registered under the
//! name every home used to share.
//!
//! A runtime without that patch (an older managed runtime, a standalone
//! Hermes on the PATH) still uses the shared name, `ai.hermes.gateway`. When
//! a debug build runs `hermes gateway start` with one, it rewrites that one
//! LaunchAgent to point at its own home: whichever gateway served it, the
//! installed app's or a standalone Hermes', is replaced (docs/qa/parity-1.89.1.md,
//! "A debug build takes over the person's Hermes gateway"). So with such a
//! runtime a debug build on macOS leaves a LaunchAgent that belongs to another
//! Hermes home alone, says so in `logs/gateway-start.log`, and goes without
//! routines. `SUBROSA_DEV_GATEWAY=1` takes the gateway over on purpose.

use std::path::Path;
use std::process::{Command, Stdio};

use super::{apply_isolated_hermes_env, gateway_label, HermesBridgeConnection};

/// Set to take the shared gateway over from a debug build anyway.
pub(super) const TAKEOVER_ENV: &str = "SUBROSA_DEV_GATEWAY";

/// The `hermes gateway start` command, once this home's shared-name service
/// is gone; or, in a debug build on macOS whose runtime still uses the shared
/// name and whose shared LaunchAgent belongs to another Hermes home, a command
/// that only writes why it did not run.
pub(super) fn start_command(connection: &HermesBridgeConnection, hermes_home: &Path) -> Command {
    let command = build_hermes_gateway_start_command(connection, hermes_home);
    if gateway_label::names_service_per_home(Path::new(&connection.command)) {
        // Never in tests: the machine's own services must not change in a test.
        #[cfg(not(test))]
        if let Some(removed) = gateway_label::retire_shared_service(hermes_home) {
            eprintln!("hermes gateway: {removed}");
        }
        return command;
    }
    // Never in tests: the machine's own LaunchAgents must not decide a test.
    #[cfg(all(target_os = "macos", debug_assertions, not(test)))]
    {
        let plist = std::env::var_os("HOME")
            .map(|home| Path::new(&home).join("Library/LaunchAgents/ai.hermes.gateway.plist"));
        let contents = plist.and_then(|path| std::fs::read_to_string(path).ok());
        let takeover = std::env::var_os(TAKEOVER_ENV).is_some();
        if let Some(reason) = blocked(contents.as_deref(), hermes_home, takeover) {
            let mut say = Command::new("/bin/echo");
            say.arg(reason);
            return say;
        }
    }
    let _ = hermes_home;
    command
}

/// Pure command construction so a test can assert the spawn is the bare hermes
/// executable (no `sandbox-exec` wrapper) with the isolated environment.
pub(super) fn build_hermes_gateway_start_command(
    connection: &HermesBridgeConnection,
    hermes_home: &Path,
) -> Command {
    let mut cmd = Command::new(&connection.command);
    if cfg!(windows) {
        // `gateway start` is a dead end on a fresh Windows install: with no
        // service registered it asks "Install it now? [Y/n]", and Hermes'
        // prompt_yes_no() exits on the EOF it reads from a closed stdin (it
        // never consults HERMES_NONINTERACTIVE), so the gateway is never
        // installed and routines never fire. `gateway install` is idempotent
        // and reads its two intent questions from these env vars; the one
        // prompt left (UAC elevation for non-admin accounts) is answered "n"
        // through the piped stdin — see answer_gateway_install_prompts — so
        // the install lands on the Startup-folder fallback instead of dying.
        cmd.args(["gateway", "install"]);
        cmd.env("HERMES_GATEWAY_INSTALL_START_NOW", "1");
        cmd.env("HERMES_GATEWAY_INSTALL_START_ON_LOGIN", "1");
    } else {
        cmd.args(["gateway", "start"]);
    }
    // No sandbox-status hint: `gateway start` is a helper invocation, not the
    // agent runtime, so it never builds a system prompt.
    apply_isolated_hermes_env(&mut cmd, hermes_home, &connection.token, None);
    cmd.env("HERMES_NONINTERACTIVE", "1");
    cmd.current_dir(hermes_home);
    if cfg!(windows) {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd
}

/// Why starting the gateway would take over someone else's, if it would.
/// `plist` is the shared LaunchAgent's contents, `None` when there is none.
#[cfg_attr(
    not(all(target_os = "macos", debug_assertions, not(test))),
    allow(dead_code)
)]
fn blocked(plist: Option<&str>, hermes_home: &Path, takeover: bool) -> Option<String> {
    let plist = plist?;
    if takeover {
        return None;
    }
    // The plist names the home it serves as an XML string.
    let home = hermes_home
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    if plist.contains(&format!("<string>{home}</string>")) {
        return None;
    }
    Some(format!(
        "Debug build: not starting the Hermes gateway. This Hermes runtime names its \
         service ai.hermes.gateway, which serves another Hermes home, and starting it here \
         would replace that one. Reinstall the runtime (scripts/bundle-hermes-runtime.sh) \
         so it names the service after its home. Routines do not run in this build. Set \
         {TAKEOVER_ENV}=1 to take it over anyway."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &str = "/Users/a/Library/Application Support/xyz.carpediem.subrosa-dev/hermes";
    const RELEASE: &str = "/Users/a/Library/Application Support/xyz.carpediem.subrosa/hermes";

    fn plist_for(home: &str) -> String {
        format!(
            "<dict><key>EnvironmentVariables</key><dict><key>HERMES_HOME</key>\
             <string>{home}</string></dict></dict>"
        )
    }

    #[test]
    fn the_installed_apps_gateway_is_left_alone() {
        let reason = blocked(Some(&plist_for(RELEASE)), Path::new(DEV), false);
        assert!(reason.is_some_and(|reason| reason.contains(TAKEOVER_ENV)));
    }

    #[test]
    fn its_own_or_no_gateway_starts_as_before() {
        assert_eq!(blocked(Some(&plist_for(DEV)), Path::new(DEV), false), None);
        assert_eq!(blocked(None, Path::new(DEV), false), None);
    }

    #[test]
    fn the_takeover_is_on_purpose_only() {
        assert_eq!(
            blocked(Some(&plist_for(RELEASE)), Path::new(DEV), true),
            None
        );
    }

    #[test]
    fn a_home_is_matched_as_the_plist_escapes_it() {
        let home = "/Users/a/R&D/hermes";
        assert_eq!(
            blocked(
                Some(&plist_for("/Users/a/R&amp;D/hermes")),
                Path::new(home),
                false
            ),
            None
        );
    }
}
