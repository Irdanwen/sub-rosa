//! The Seatbelt (SBPL) profile the sandboxed runtime runs under (ADR-0006,
//! ADR-0014, ADR-0140). Moved out of `hermes_bridge.rs` whole, so the
//! bridge file's size ratchet goes down.
//!
//! The rule since ADR-0140: the jail writes nothing a process outside it
//! reads with authority. Its home is closed as a whole and re-opened only
//! where the runtime keeps its working state ([`RUNTIME_STATE_DIRS`],
//! [`RUNTIME_STATE_FILES`]); its settings, its permissions, its code and
//! everything another process runs from (the gateway, the unrestricted
//! runtime, the app) stay read-only to it, and the app writes them from
//! outside before each start.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use super::{AGENT_CLI_STATE_DIRS, AGENT_CLI_STATE_FILE_PREFIXES};

/// Starts `cmd` in a session of its own, so its pid is its process group and
/// teardown reaps the whole tree with one signal (JUN-338). A session, not
/// only a group (ADR-0140): `setpgid` cannot cross sessions, so nothing the
/// runtime starts can join the app's process group, where the jail's
/// "no signal to others" rule would no longer cover the app.
pub(super) fn own_session(cmd: &mut std::process::Command) {
    #[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
    {
        use std::os::unix::process::CommandExt as _;
        // SAFETY: the hook runs in the forked child before exec and calls
        // only `setsid`, which is async-signal-safe.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }
}

/// The folders of the runtime's home the jail may write, relative to it.
/// Measured on the pinned runtime under the profile (ADR-0140): its dashboard
/// starts and answers, a session opens and runs terminal, file, search, todo,
/// skill reading, session search, delegation and image attachment, and
/// no other folder of the home is written. None of them holds a setting, a
/// permission or a program another process runs.
///
/// - `workspace`: the default working folder of a sandboxed session.
/// - `sessions`: session transcripts and request dumps.
/// - `logs`: the runtime's own logs.
/// - `cache`: model metadata, delegation progress, vision and document caches.
/// - `images`: images attached to a turn (`image.attach_bytes`).
/// - `image_cache`, `audio_cache`: generated media on its way to the chat.
/// - `mcp-tokens`: the MCP servers' sign-ins, which the runtime refreshes
///   (the sandboxed home's own copy, ADR-0140).
pub(super) const RUNTIME_STATE_DIRS: &[&str] = &[
    "workspace",
    "sessions",
    "logs",
    "cache",
    "images",
    "image_cache",
    "audio_cache",
    "mcp-tokens",
];

/// The files at the top of the runtime's home the jail may write: the
/// session database (with SQLite's side files), the edit-verification
/// database, and the lock the credential store is read under.
pub(super) const RUNTIME_STATE_FILES: &[&str] = &[
    "state.db",
    "state.db-wal",
    "state.db-shm",
    "state.db-journal",
    "verification_evidence.db",
    "verification_evidence.db-wal",
    "verification_evidence.db-shm",
    "verification_evidence.db-journal",
    "auth.lock",
];

/// What a sandboxed spawn is granted, gathered by `prepare_sandbox`. Every
/// path is canonical, so the rules match the realpaths the kernel checks.
#[cfg(target_os = "macos")]
pub(super) struct SandboxGrants<'a> {
    /// The person's home directory (`$HOME`).
    pub home: &'a Path,
    /// The runtime's home (`$HERMES_HOME`), closed but for the runtime state.
    pub hermes_home: &'a Path,
    /// The runtime's installation (source and virtualenv): never written.
    pub runtime_dir: &'a Path,
    /// Homes of processes outside the jail (the shared home of the
    /// unrestricted runtime and the gateway): never written at all.
    pub closed_homes: &'a [PathBuf],
    /// Shared and per-session temp folders.
    pub temp_roots: &'a [PathBuf],
    pub agent_cli_access: bool,
    /// The session's working folder, already validated (ADR-0014).
    pub working_dir: Option<&'a Path>,
    /// Where a one-off reader of the sandboxed home writes its answer: a
    /// folder of the app's data only that reader may write (ADR-0140, D5),
    /// never the temp folder the runtime shares.
    pub result_dir: Option<&'a Path>,
    /// The jail's own temp folder (its `TMPDIR`): the one place outside its
    /// home and working folder where it may reach a unix socket (ADR-0140,
    /// M1).
    pub jail_tmp: Option<&'a Path>,
    /// The loopback ports the jail may connect to (ADR-0140, H2): the app's
    /// proxy, the runtime's own dashboard, local MCP servers the person set.
    pub loopback_ports: &'a [u16],
}

/// The temp folders the jail may write (ADR-0140, H1): its own and no other.
/// Not `/private/tmp`, `/private/var/tmp` or the app's `TMPDIR`: other
/// programs keep their sockets there (a database, a terminal multiplexer, a
/// browser bridge), and a jail that may write such a folder may rename one
/// of them into its own, where it may connect.
#[cfg(target_os = "macos")]
pub(super) fn jail_write_temp_roots(jail_tmp: Option<&Path>) -> Vec<PathBuf> {
    jail_tmp.map(Path::to_path_buf).into_iter().collect()
}

/// Renders the profile text. Strategy: allow broadly, because the embedded
/// Python runtime needs wide syscall, mach-service, and exec rights and any
/// tighter base brings the runtime down; then deny every write and re-grant
/// only what the jail may write, and deny reads of credential stores. In
/// SBPL the last matching rule wins, so the order of the sections is the
/// enforcement. Pure (no IO) so it can be unit-tested.
#[cfg(target_os = "macos")]
pub(super) fn build_sandbox_profile(grants: &SandboxGrants<'_>) -> String {
    let home = grants.home;
    let mut out = String::new();
    out.push_str("(version 1)\n");
    out.push_str(";; Sub Rosa desktop agent sandbox, generated by the app, do not edit.\n");
    out.push_str(";; Allow broadly (the Python runtime needs wide syscall/mach access and\n");
    out.push_str(";; must exec interpreters), then carve a hard write-jail and a secret-read\n");
    out.push_str(";; denylist. Subprocesses inherit this profile.\n");
    out.push_str("(allow default)\n\n");

    out.push_str(";; Write jail: deny all writes, then re-grant the jail's temp folder.\n");
    out.push_str("(deny file-write*)\n");
    // Never an empty `(allow file-write*)`: with no filter it allows every
    // write.
    if !grants.temp_roots.is_empty() {
        out.push_str("(allow file-write*\n");
        for root in grants.temp_roots {
            out.push_str(&format!(
                "  (subpath {})\n",
                sbpl_quote(&root.to_string_lossy())
            ));
        }
        out.push_str(")\n");
    }
    out.push('\n');

    if let Some(result_dir) = grants.result_dir {
        out.push_str(";; The one-off reader's answer, nothing else of the app's data.\n");
        out.push_str(&format!(
            "(allow file-write* (subpath {}))\n\n",
            sbpl_quote(&result_dir.to_string_lossy())
        ));
    }

    if let Some(working_dir) = grants.working_dir {
        // The one user-directory grant, and it exists only because
        // `validate_working_dir` accepted this exact canonical path (the
        // spawn re-validates every start). The trailing denies below still
        // outrank it.
        out.push_str(";; Working folder (per-session, user-picked, validated): the one\n");
        out.push_str(";; user directory this session may write. See\n");
        out.push_str(";; docs/adr/0014-per-session-working-folder.md.\n");
        out.push_str("(allow file-write*\n");
        out.push_str(&format!(
            "  (subpath {})\n",
            sbpl_quote(&working_dir.to_string_lossy())
        ));
        out.push_str(")\n\n");
    }

    if grants.agent_cli_access {
        out.push_str(";; Agent CLI state (explicit user opt-in from Settings > Agent):\n");
        out.push_str(";; lets installed coding CLIs (Claude Code, Codex, Gemini, opencode)\n");
        out.push_str(";; run under the jail while keeping their sessions and refreshed\n");
        out.push_str(";; logins. These folders configure tools that later run OUTSIDE the\n");
        out.push_str(";; sandbox (hooks, settings), which is why this is off by default.\n");
        out.push_str("(allow file-write*\n");
        for relative in AGENT_CLI_STATE_DIRS {
            out.push_str(&format!(
                "  (subpath {})\n",
                sbpl_quote(&home.join(relative).to_string_lossy())
            ));
        }
        for prefix in AGENT_CLI_STATE_FILE_PREFIXES {
            // Prefix regex instead of a literal: the CLIs write these files
            // atomically through randomly suffixed temp names + rename.
            out.push_str(&format!(
                "  (regex #\"^{}.*$\")\n",
                sbpl_regex_escape(&home.join(prefix).to_string_lossy())
            ));
        }
        out.push_str(")\n\n");
    }

    out.push_str(";; Character devices and pipes the runtime needs to write.\n");
    out.push_str("(allow file-write*\n");
    for device in [
        "/dev/null",
        "/dev/zero",
        "/dev/dtracehelper",
        "/dev/tty",
        "/dev/stdout",
        "/dev/stderr",
        "/dev/random",
        "/dev/urandom",
    ] {
        out.push_str(&format!("  (literal {})\n", sbpl_quote(device)));
    }
    out.push_str("  (regex #\"^/dev/fd/[0-9]+$\")\n");
    out.push_str("  (regex #\"^/dev/ttys[0-9]+$\")\n");
    out.push_str(")\n\n");

    // ADR-0140. After every grant above, so no temp root, working folder or
    // CLI grant can span them: the runtime's home and its installation are
    // closed as a whole. Processes outside the jail read them with
    // authority: the gateway runs its routines, hooks and plugins from the
    // home, the unrestricted runtime and the app read its settings, and the
    // installation is the code all of them run. A `subpath` covers what is
    // under a path, not the way to it: renaming an ancestor (a working
    // folder can span one) would carry the home off, rewrite it elsewhere
    // and bring it back. So every ancestor, up to the root, is closed too:
    // nothing may rename, remove or replace it, while writing inside one
    // stays as granted.
    out.push_str(";; The runtime's home and installation: closed as a whole (ADR-0140),\n");
    out.push_str(";; and the folders that lead to them cannot be renamed or replaced.\n");
    out.push_str("(deny file-write*\n");
    out.push_str(&format!(
        "  (subpath {})\n",
        sbpl_quote(&grants.hermes_home.to_string_lossy())
    ));
    out.push_str(&format!(
        "  (subpath {})\n",
        sbpl_quote(&grants.runtime_dir.to_string_lossy())
    ));
    for closed in grants.closed_homes {
        out.push_str(&format!(
            "  (subpath {})\n",
            sbpl_quote(&closed.to_string_lossy())
        ));
    }
    let mut guarded: Vec<&Path> = vec![grants.hermes_home, grants.runtime_dir];
    guarded.extend(grants.closed_homes.iter().map(PathBuf::as_path));
    for ancestor in ancestors(&guarded) {
        out.push_str(&format!(
            "  (literal {})\n",
            sbpl_quote(&ancestor.to_string_lossy())
        ));
    }
    out.push_str(")\n\n");

    out.push_str(";; ...and re-opened only where the runtime keeps its working state.\n");
    out.push_str("(allow file-write*\n");
    for dir in RUNTIME_STATE_DIRS {
        out.push_str(&format!(
            "  (subpath {})\n",
            sbpl_quote(&grants.hermes_home.join(dir).to_string_lossy())
        ));
    }
    for file in RUNTIME_STATE_FILES {
        out.push_str(&format!(
            "  (literal {})\n",
            sbpl_quote(&grants.hermes_home.join(file).to_string_lossy())
        ));
    }
    out.push_str(")\n\n");

    // ADR-0140, links: the state above is opened by name from outside the
    // jail too (the gateway's logs and sessions, the app's uploads, the
    // session database), and a link planted there would send those writes
    // anywhere, a pipe or a socket would hang or answer them. So no link,
    // pipe or socket may be made in it; the default workspace keeps them
    // (development tools need them), except its `uploads` folder, which the
    // app writes, and its own name, which must stay a folder.
    let linkless: Vec<String> = linkless_paths(grants.hermes_home)
        .iter()
        .map(|(subpath, path)| {
            let kind = if *subpath { "subpath" } else { "literal" };
            format!("({kind} {})", sbpl_quote(&path.to_string_lossy()))
        })
        .collect();
    out.push_str(";; No link may be made where processes outside the jail open by name.\n");
    out.push_str("(deny file-write-create\n");
    for filter in &linkless {
        out.push_str(&format!(
            "  (require-all {filter} (require-any (vnode-type SYMLINK) (vnode-type FIFO) (vnode-type SOCKET)))\n"
        ));
    }
    for dir in RUNTIME_STATE_DIRS {
        // Each re-opened folder's own name stays a folder.
        out.push_str(&format!(
            "  (require-all (literal {}) (vnode-type SYMLINK))\n",
            sbpl_quote(&grants.hermes_home.join(dir).to_string_lossy())
        ));
    }
    out.push_str(")\n");
    // ...and stays where it is: a folder of the jail's own, carrying links
    // or pipes, cannot be renamed in its place.
    out.push_str("(deny file-write-unlink\n");
    for dir in RUNTIME_STATE_DIRS {
        out.push_str(&format!(
            "  (literal {})\n",
            sbpl_quote(&grants.hermes_home.join(dir).to_string_lossy())
        ));
    }
    out.push_str(")\n");
    out.push_str("(deny file-link\n");
    for filter in &linkless {
        out.push_str(&format!("  {filter}\n"));
    }
    out.push_str(")\n\n");

    // ADR-0140: no signal to a process outside the jail (the app, the
    // gateway, the unrestricted runtime: stopping one would have the system
    // start it again on the jail's terms). The runtime still stops its own
    // children, which inherit the profile, in their own process groups too.
    out.push_str(";; Signals: only to processes of this same sandbox.\n");
    out.push_str("(deny signal (target others))\n");
    out.push_str("(allow signal (target same-sandbox))\n\n");

    // ADR-0140: the jail reaches only the system services it was measured
    // to need. None of them starts, drives or configures a program outside
    // it, sees the screen or posts an event.
    out.push_str(";; System services: the measured list only.\n");
    out.push_str("(deny mach-lookup)\n");
    out.push_str("(allow mach-lookup\n");
    for name in ALLOWED_MACH_SERVICES {
        out.push_str(&format!("  (global-name {})\n", sbpl_quote(name)));
    }
    // No service holds it: the kernel's answer for it tells the jail's
    // processes from any other sandboxed one (`jail_reaper`).
    out.push_str(&format!(
        "  (global-name {})\n",
        sbpl_quote(JAIL_MARKER_SERVICE)
    ));
    out.push_str(")\n");
    push_unix_socket_rules(&mut out, grants);
    // ADR-0140 (M2): launchd answers `kickstart`, `kill`, `bootout` and
    // `disable` from a sandboxed process (they go over the bootstrap port,
    // which no rule filters); its command-line client is refused. A copy of
    // it is killed by the system for leaving its signed place.
    out.push_str(
        ";; The launchd client: no job of the person's is started, stopped or disabled.\n",
    );
    out.push_str("(deny process-exec (literal \"/bin/launchctl\"))\n");
    out.push_str(";; Preferences are written by a daemon outside the jail and read by\n");
    out.push_str(";; every program that later starts: none from here.\n");
    out.push_str("(deny user-preference-write)\n\n");

    out.push_str(";; Secret-read denylist: reads are otherwise open so the assistant can\n");
    out.push_str(";; work on the user's files, but credential stores stay off-limits.\n");
    out.push_str("(deny file-read*\n");
    push_secret_stores(&mut out, home);
    out.push_str(")\n\n");

    // Last on purpose: in SBPL the later rule wins, so this deny outranks
    // every write grant above it. Working-dir validation already refuses
    // folders that contain (or live inside) a credential store; this is the
    // second, kernel-level line for the same invariant: no grant, present
    // or future, may make a credential store writable.
    out.push_str(";; Secret-write denylist: credential stores stay unwritable even when a\n");
    out.push_str(";; write grant above (workspace, working folder, CLI state) spans them.\n");
    out.push_str("(deny file-write*\n");
    push_secret_stores(&mut out, home);
    out.push_str(")\n");
    // ADR-0140 (7th pass): the name of the jail's temp folder and of the
    // reader's answer folder is the app's: the jail may write inside, never
    // remove the folder, chmod it or put a link in its place, which the app
    // would then follow when it makes the folder again.
    let own_folders: Vec<&Path> = grants
        .temp_roots
        .iter()
        .map(PathBuf::as_path)
        .chain(grants.result_dir)
        .collect();
    if !own_folders.is_empty() {
        out.push_str(";; The jail's own folders: written inside, never replaced.\n");
        out.push_str("(deny file-write*\n");
        for folder in own_folders {
            out.push_str(&format!(
                "  (literal {})\n",
                sbpl_quote(&folder.to_string_lossy())
            ));
        }
        out.push_str(")\n");
    }
    out
}

/// The only system services the jail may reach (ADR-0140): an allowlist
/// over `(deny mach-lookup)`. Measured on macOS 26 by removing each name in
/// turn under Python (users and groups, name resolution, subprocesses, TLS
/// with its own certificates), Node (child processes, TLS, file watching),
/// git and curl over HTTPS, a Go binary's TLS (the system trust store),
/// `defaults read`, and the pinned runtime's own session with every tool
/// (`scripts/jail-eval/runtime_lives.py`); a name stays only when its
/// removal broke one of them.
///
/// - `com.apple.system.opendirectoryd.libinfo`: users, groups and name
///   resolution (`getpwuid`, `getaddrinfo`); without it nothing starts.
/// - `com.apple.cfprefsd.agent`, `com.apple.cfprefsd.daemon`: reading
///   preferences (writing them is refused by `user-preference-write`).
/// - `com.apple.FSEvents`: watching files (Node's `fs.watch`, language
///   servers); it reports, it never writes.
/// - `com.apple.trustd.agent`: evaluating a certificate against the system
///   trust store (Go, Swift and Security-framework TLS).
///
/// Everything else is refused, among them LaunchServices and Apple events
/// (`open`, `osascript`), Shortcuts, login items, the Dock, the Services
/// menu, the window server (no screen capture, no synthesized key or mouse
/// event), the TCC daemon (every privacy preflight answers no), the
/// pasteboard and the keychain daemon.
#[cfg(target_os = "macos")]
pub(super) const ALLOWED_MACH_SERVICES: &[&str] = &[
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.cfprefsd.agent",
    "com.apple.cfprefsd.daemon",
    "com.apple.FSEvents",
    "com.apple.trustd.agent",
];

/// The profile file of the runtime, and of the one-off reader of its home,
/// in the app's data folder.
pub(super) const RUNTIME_PROFILE_FILE: &str = "hermes-sandbox.sb";
pub(super) const READER_PROFILE_FILE: &str = "hermes-sandbox-reader.sb";

/// Builds the Seatbelt profile, writes it to disk, and returns the path to hand
/// to `sandbox-exec -f`. Returns `None` (meaning "spawn unsandboxed") on
/// non-macOS, when `sandbox-exec` is absent, when the escape-hatch env var is
/// set, or if the profile can't be written. Callers treat `None` as "not
/// sandboxed" and surface that honestly in the UI.
///
/// The profile is written to `app_data_dir` itself, which the jail cannot
/// write (only parts of the sandboxed home are re-opened, ADR-0140), so the
/// jailed agent can't rewrite the policy that governs it or the one the next
/// spawn will read.
pub(super) fn prepare(
    app: &tauri::AppHandle,
    hermes_home: &std::path::Path,
    agent_cli_access: bool,
    working_dir: Option<&std::path::Path>,
    loopback_ports: &[u16],
) -> Option<std::path::PathBuf> {
    let mut ports = loopback_ports.to_vec();
    ports.extend(local_mcp_ports(hermes_home));
    write_profile(
        app,
        hermes_home,
        agent_cli_access,
        working_dir,
        None,
        &ports,
        RUNTIME_PROFILE_FILE,
    )
}

/// The loopback ports of the MCP servers the person set (from the app's
/// record of their settings): a sandboxed session reaches a local server
/// only when the person configured it.
pub(super) fn local_mcp_ports(any_home: &std::path::Path) -> Vec<u16> {
    let settings = super::admin_settings::load(any_home);
    let mut ports: Vec<u16> = settings
        .config
        .mcp_servers
        .values()
        .filter_map(|entry| entry.get("url").and_then(serde_json::Value::as_str))
        .filter_map(|url| reqwest::Url::parse(url).ok())
        .filter(|url| {
            matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            )
        })
        .filter_map(|url| url.port_or_known_default())
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// Writes the profile a one-off reader of the sandboxed home runs under
/// (ADR-0140): the jail of that home, fresh, with no working folder and no
/// agent CLI state, whatever the last sandboxed session had. Written at each
/// runtime start, whichever its mode.
pub(super) fn prepare_reader(app: &tauri::AppHandle, any_home: &std::path::Path) {
    let sandboxed = super::home_split::sandboxed_home(any_home);
    if std::fs::create_dir_all(&sandboxed).is_err() {
        return;
    }
    let results = reader_result_dir(any_home);
    if create_private_dir(&results).is_err() {
        return;
    }
    let results = std::fs::canonicalize(&results).unwrap_or(results);
    // The reader and a sandboxed sign-in reach only the local MCP servers
    // the person set.
    let ports = local_mcp_ports(any_home);
    let _ = write_profile(
        app,
        &sandboxed,
        false,
        None,
        Some(&results),
        &ports,
        READER_PROFILE_FILE,
    );
}

/// Where the one-off reader of the sandboxed home writes its answers, in
/// the app's data folder.
pub(super) fn reader_result_dir(any_home: &std::path::Path) -> std::path::PathBuf {
    any_home
        .parent()
        .unwrap_or(any_home)
        .join("hermes-reader-results")
}

/// A folder only this account may open.
///
/// Never through a link (7th pass): a link or a file in its place is
/// removed, the folder is made with that mode, then opened without
/// following a link and its mode set on that descriptor, and it must be a
/// folder of this account. A jail that put a link there cannot have the app
/// change another folder.
pub(super) fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = dir.symlink_metadata() {
        if meta.file_type().is_symlink() || !meta.is_dir() {
            std::fs::remove_file(dir)?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
        match std::fs::DirBuilder::new().mode(0o700).create(dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let folder = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc_nofollow_directory())
            .open(dir)?;
        let meta = folder.metadata()?;
        // SAFETY: getuid(2) takes nothing and cannot fail.
        if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
            return Err(std::io::Error::other(format!(
                "{} is not a folder of this account",
                dir.display()
            )));
        }
        folder.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// `O_NOFOLLOW | O_DIRECTORY`.
#[cfg(unix)]
fn libc_nofollow_directory() -> i32 {
    libc::O_NOFOLLOW | libc::O_DIRECTORY
}

/// Whether sandboxed processes on this machine run under the jail: then a
/// reader of the jail's home must too, or not run at all.
pub(super) fn jail_engages() -> bool {
    #[cfg(target_os = "macos")]
    {
        !super::env_flag_enabled(super::JUNE_HERMES_DISABLE_SANDBOX_ENV)
            && Path::new(super::SANDBOX_EXEC_PATH).exists()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
fn write_profile(
    app: &tauri::AppHandle,
    hermes_home: &Path,
    agent_cli_access: bool,
    working_dir: Option<&Path>,
    result_dir: Option<&Path>,
    loopback_ports: &[u16],
    file_name: &str,
) -> Option<PathBuf> {
    // The caller logs the sandboxed/unsandboxed outcome; this only short-circuits.
    if !jail_engages() {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    // Canonical, so the rules match the realpaths the kernel checks.
    let canonical = |path: PathBuf| std::fs::canonicalize(&path).unwrap_or(path);
    let runtime_dir = canonical(super::managed_hermes_runtime_dir(app).ok()?);
    let hermes_home = canonical(hermes_home.to_path_buf());
    // ADR-0140: the shared home (the unrestricted runtime's, the gateway's)
    // is closed to the jail as a whole.
    let shared = canonical(super::home_split::shared_home(&hermes_home));
    let closed_homes: Vec<PathBuf> = if shared != hermes_home {
        vec![shared]
    } else {
        Vec::new()
    };
    // `working_dir` only ever arrives here through
    // `hermes_working_dir::validate_working_dir` (the spawn re-validates on
    // every start): the "explicit, validated grant" that lets the jail span
    // one user-picked folder without ever widening past it.
    // ADR-0140 (H1): the only temp folder the jail writes is its own; the
    // shared ones (`/private/tmp`, `/private/var/tmp`, the app's `TMPDIR`)
    // hold other programs' sockets, which a rename would carry into it.
    let jail_tmp = prepare_jail_tmp().ok();
    let temp_roots = jail_write_temp_roots(jail_tmp.as_deref());
    let profile = build_sandbox_profile(&SandboxGrants {
        home: &home,
        hermes_home: &hermes_home,
        runtime_dir: &runtime_dir,
        closed_homes: &closed_homes,
        temp_roots: &temp_roots,
        agent_cli_access,
        working_dir,
        result_dir,
        jail_tmp: jail_tmp.as_deref(),
        loopback_ports,
    });
    let app_data_dir = crate::app_paths::app_data_dir(app).ok()?;
    if std::fs::create_dir_all(&app_data_dir).is_err() {
        return None;
    }
    let profile_path = app_data_dir.join(file_name);
    match std::fs::write(&profile_path, profile) {
        Ok(()) => Some(profile_path),
        Err(error) => {
            eprintln!("Could not write Hermes sandbox profile, spawning unsandboxed: {error}");
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn write_profile(
    _app: &tauri::AppHandle,
    _hermes_home: &std::path::Path,
    _agent_cli_access: bool,
    _working_dir: Option<&std::path::Path>,
    _result_dir: Option<&std::path::Path>,
    _loopback_ports: &[u16],
    _file_name: &str,
) -> Option<std::path::PathBuf> {
    None
}

/// A service name only the jail's profiles allow and no service holds: how
/// the reaper tells a process of the jail (ADR-0140, M2).
pub(super) const JAIL_MARKER_SERVICE: &str = "xyz.carpediem.subrosa.jail";

/// A service name the jail's profile never allows (and no service holds): a
/// profile that allows it allows everything, so it is not the jail's.
pub(super) const JAIL_CANARY_SERVICE: &str = "xyz.carpediem.subrosa.jail-canary";

/// The unix sockets the jail may connect to (ADR-0140, M1): its own temp
/// folder, its home, its working folder, name resolution and the system
/// log. Not an agent's (ssh, gpg), a container engine's (Docker, Colima,
/// OrbStack), a terminal multiplexer's or an editor server's, each of which
/// would run or sign something outside the jail. Measured: Python, Node,
/// git and curl over HTTPS, and the runtime's own session, work under it.
#[cfg(target_os = "macos")]
fn push_unix_socket_rules(out: &mut String, grants: &SandboxGrants<'_>) {
    out.push_str(";; Unix sockets: the jail's own, name resolution and the system log.\n");
    out.push_str("(deny network-outbound (remote unix-socket))\n");
    out.push_str("(allow network-outbound\n");
    let mut roots: Vec<&Path> = vec![grants.hermes_home];
    roots.extend(grants.jail_tmp);
    roots.extend(grants.working_dir);
    for root in roots {
        out.push_str(&format!(
            "  (remote unix-socket (subpath {}))\n",
            sbpl_quote(&root.to_string_lossy())
        ));
    }
    for system in ALLOWED_UNIX_SOCKETS {
        out.push_str(&format!(
            "  (remote unix-socket (path-literal {}))\n",
            sbpl_quote(system)
        ));
    }
    out.push_str(")\n");
    // Whatever a grant above spans: never a credential store's socket (the
    // gpg agent's, Docker's), launchd's per-user listeners (the ssh agent),
    // or a container engine's.
    out.push_str("(deny network-outbound\n");
    for relative in crate::hermes_working_dir::SECRET_STORE_DIRS
        .iter()
        .chain(CONTAINER_SOCKET_DIRS)
    {
        out.push_str(&format!(
            "  (remote unix-socket (subpath {}))\n",
            sbpl_quote(&grants.home.join(relative).to_string_lossy())
        ));
    }
    out.push_str("  (remote unix-socket (path-regex #\"^/private/var/run/com\\.apple\\.launchd\\.[^/]+/\"))\n");
    out.push_str(
        "  (remote unix-socket (path-regex #\"^/private/tmp/com\\.apple\\.launchd\\.[^/]+/\"))\n",
    );
    out.push_str("  (remote unix-socket (path-literal \"/private/var/run/docker.sock\"))\n");
    out.push_str(")\n\n");
    // ADR-0140 (H2): the loopback (and the machine's own addresses, which
    // the kernel counts as local) only on the ports the app names. IPv6 is
    // refused outside them: an IPv4-mapped address (`::ffff:127.0.0.1`)
    // would otherwise reach any local port; clients fall back to IPv4.
    out.push_str(
        ";; Loopback: the app's proxy, the runtime's own port, the person's local MCP servers.\n",
    );
    out.push_str("(deny network-outbound (remote ip \"localhost:*\"))\n");
    // Not `(remote ip6 ...)`: measured on macOS 26, that filter makes the
    // loopback rule above lapse (every local port answered again).
    out.push_str("(deny network-outbound (remote tcp6 \"*:*\") (remote udp6 \"*:*\"))\n");
    if !grants.loopback_ports.is_empty() {
        out.push_str("(allow network-outbound\n");
        for port in grants.loopback_ports {
            out.push_str(&format!("  (remote ip \"localhost:{port}\")\n"));
        }
        out.push_str(")\n");
    }
    out.push('\n');
}

/// The system sockets the jail may reach: name resolution (`getaddrinfo`
/// fails without it) and the system log.
#[cfg(target_os = "macos")]
const ALLOWED_UNIX_SOCKETS: &[&str] =
    &["/private/var/run/mDNSResponder", "/private/var/run/syslog"];

/// Where container engines keep their socket, relative to the person's home.
#[cfg(target_os = "macos")]
const CONTAINER_SOCKET_DIRS: &[&str] = &[
    ".colima",
    ".orbstack",
    ".rd",
    ".lima",
    // Every app's sandbox container and group container, Docker Desktop's
    // among them, and Podman's sockets.
    "Library/Containers",
    "Library/Group Containers",
    ".local/share/containers",
];

/// The jail's own temp folder's name, short: a unix socket's path in it must
/// stay under 104 bytes (Python's `multiprocessing` adds about 30).
pub(super) const JAIL_TMP_NAME: &str = "sr-jail";

/// The jail's temp folder as given in `TMPDIR`: the short, non-canonical
/// form (`/var/folders/...`), made fresh first.
pub(super) fn jail_tmp_for_env() -> Option<std::path::PathBuf> {
    prepare_jail_tmp().ok()?;
    Some(std::env::temp_dir().join(JAIL_TMP_NAME))
}

/// The jail's own temp folder, inside the app's: given to the runtime as its
/// `TMPDIR`. Made fresh by the app (a link or a file in its place is
/// removed), private to the account.
pub(super) fn prepare_jail_tmp() -> std::io::Result<std::path::PathBuf> {
    let base = std::env::temp_dir();
    let base = std::fs::canonicalize(&base).unwrap_or(base);
    let dir = base.join(JAIL_TMP_NAME);
    create_private_dir(&dir)?;
    Ok(dir)
}

/// What a jailed process must not inherit from the app's environment: the
/// way to the person's agents and engines (ADR-0140, M1). And its own temp
/// folder.
pub(super) fn apply_jail_env(cmd: &mut std::process::Command, jail_tmp: Option<&std::path::Path>) {
    for name in INHERITED_SOCKET_VARS {
        cmd.env_remove(name);
    }
    if let Some(dir) = jail_tmp {
        cmd.env("TMPDIR", dir);
    }
}

/// The same environment for a jailed process started by a shell script (the
/// developer's terminal session, B2): no agent variable, the jail's temp
/// folder, and a jail mark.
pub(super) fn jail_env_shell() -> String {
    let mut lines = String::new();
    for name in INHERITED_SOCKET_VARS {
        lines.push_str(&format!("unset {name}\n"));
    }
    if let Some(dir) = jail_tmp_for_env() {
        lines.push_str(&format!(
            "export TMPDIR='{}'\n",
            dir.to_string_lossy().replace('\'', "'\\''")
        ));
    }
    lines.push_str(&format!(
        "export {}='{}'\n",
        super::jail_reaper::JAIL_MARK_ENV,
        super::jail_reaper::new_mark()
    ));
    lines
}

/// The variables that point at an agent's or an engine's socket.
pub(super) const INHERITED_SOCKET_VARS: &[&str] = &[
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GPG_AGENT_INFO",
    "DOCKER_HOST",
    "TMUX",
    "TMUX_PANE",
    "STY",
];

/// Every folder above `paths`, up to the root, once each.
#[cfg(target_os = "macos")]
fn ancestors(paths: &[&Path]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for path in paths {
        for ancestor in path.ancestors().skip(1) {
            let ancestor = ancestor.to_path_buf();
            if !ancestor.as_os_str().is_empty() && !out.contains(&ancestor) {
                out.push(ancestor);
            }
        }
    }
    out
}

/// Where the jail may write but never make a link: every runtime state
/// folder but the workspace, the workspace's `uploads`, and the state files.
/// `true` marks a folder (`subpath`), `false` a file (`literal`).
#[cfg(target_os = "macos")]
fn linkless_paths(hermes_home: &Path) -> Vec<(bool, PathBuf)> {
    let mut paths: Vec<(bool, PathBuf)> = RUNTIME_STATE_DIRS
        .iter()
        .filter(|dir| **dir != "workspace")
        .map(|dir| (true, hermes_home.join(dir)))
        .collect();
    paths.push((true, hermes_home.join("workspace").join("uploads")));
    paths.extend(
        RUNTIME_STATE_FILES
            .iter()
            .map(|file| (false, hermes_home.join(file))),
    );
    paths
}

#[cfg(target_os = "macos")]
fn push_secret_stores(out: &mut String, home: &Path) {
    for relative in crate::hermes_working_dir::SECRET_STORE_DIRS {
        out.push_str(&format!(
            "  (subpath {})\n",
            sbpl_quote(&home.join(relative).to_string_lossy())
        ));
    }
    out.push_str("  (subpath \"/Library/Keychains\")\n");
    for relative in crate::hermes_working_dir::SECRET_STORE_FILES {
        out.push_str(&format!(
            "  (literal {})\n",
            sbpl_quote(&home.join(relative).to_string_lossy())
        ));
    }
}

/// Quotes a string as an SBPL literal: wrap in double quotes, backslash-escape
/// embedded quotes and backslashes. Spaces (e.g. "Application Support") are
/// fine inside the quotes.
#[cfg(target_os = "macos")]
pub(super) fn sbpl_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        if ch == '\\' || ch == '"' {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    quoted
}

/// Escapes a path for embedding in an SBPL `(regex #"...")` pattern so it
/// matches itself literally: dots in file names and any other regex
/// metacharacters must not widen the grant.
#[cfg(target_os = "macos")]
pub(super) fn sbpl_regex_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(
            ch,
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|'
        ) {
            escaped.push('\\');
        }
        if ch == '"' {
            // SBPL string layer: a quote would end the #"..." pattern.
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

#[cfg(test)]
#[cfg(target_os = "macos")]
#[path = "sandbox_profile_tests.rs"]
mod tests;
