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
}

/// The temp folders the jail may write. Canonicalized (macOS resolves
/// `/tmp` -> `/private/tmp` and `$TMPDIR` under `/private/var/folders`).
///
/// Deliberately scoped to `$TMPDIR` (this app's per-session temp dir) rather
/// than the whole `/private/var/folders` tree, which is the parent of every
/// other app's caches too.
#[cfg(target_os = "macos")]
pub(super) fn sandbox_temp_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        // Shared temp dirs, used mainly as a fallback when $TMPDIR is unset.
        PathBuf::from("/private/tmp"),
        PathBuf::from("/private/var/tmp"),
    ];
    // The per-session temp dir. The Python runtime and its children use it
    // for scratch files and multiprocessing sockets.
    if let Some(tmpdir) = std::env::var_os("TMPDIR") {
        if !tmpdir.is_empty() {
            roots.push(PathBuf::from(tmpdir));
        }
    }
    let mut canonical: Vec<PathBuf> = Vec::with_capacity(roots.len());
    for root in roots {
        let resolved = std::fs::canonicalize(&root).unwrap_or(root);
        if !canonical.contains(&resolved) {
            canonical.push(resolved);
        }
    }
    canonical
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

    out.push_str(";; Write jail: deny all writes, then re-grant the temp folders.\n");
    out.push_str("(deny file-write*)\n");
    out.push_str("(allow file-write*\n");
    for root in grants.temp_roots {
        out.push_str(&format!(
            "  (subpath {})\n",
            sbpl_quote(&root.to_string_lossy())
        ));
    }
    out.push_str(")\n\n");

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

    // ADR-0140: no system service that starts, drives or configures a
    // program outside the jail on the jail's behalf.
    out.push_str(";; Services that launch or drive programs outside the jail.\n");
    out.push_str("(deny mach-lookup\n");
    for (name, prefix) in REFUSED_MACH_SERVICES {
        let filter = if *prefix {
            "global-name-prefix"
        } else {
            "global-name"
        };
        out.push_str(&format!("  ({filter} {})\n", sbpl_quote(name)));
    }
    out.push_str(")\n");
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
    out
}

/// The system services the jail may not reach (ADR-0140), `true` for a
/// name prefix. Each one would start, drive or configure a program outside
/// the jail, which then runs with none of its limits. Measured on macOS 26:
///
/// - `com.apple.coreservices.` and `com.apple.lsd.`: LaunchServices
///   (`open`, `NSWorkspace`, URL and file handlers, the handler database)
///   and Apple events (`osascript` driving Finder, Terminal, System Events).
/// - `com.apple.siri`, `com.apple.WorkflowKit.`, `com.apple.shortcuts`,
///   `com.apple.linkd.`, `com.apple.private.alloy.shortcuts`: Shortcuts,
///   whose `shortcuts run` executes actions (shell scripts among them) in
///   its own daemon.
/// - `com.apple.backgroundtaskmanagement` and `com.apple.xpc.smd`: login
///   items and helper registration, which run at the next login.
/// - `com.apple.dock.`: the Dock launches applications.
/// - `com.apple.pbs.` and `com.apple.finder.ServiceProvider`: the Services
///   menu, which runs a service inside another application.
///
/// `launchctl bootstrap`/`load`/`submit`/`setenv` are refused by launchd to
/// any sandboxed process, setuid programs (`crontab`, `at`) cannot be
/// executed under the profile, and the keychain is a file the write jail
/// already closes; the kernel tests keep each of these honest.
#[cfg(target_os = "macos")]
pub(super) const REFUSED_MACH_SERVICES: &[(&str, bool)] = &[
    ("com.apple.coreservices.", true),
    ("com.apple.lsd.", true),
    ("com.apple.siri", true),
    ("com.apple.WorkflowKit.", true),
    ("com.apple.shortcuts", true),
    ("com.apple.linkd.", true),
    ("com.apple.private.alloy.shortcuts", true),
    ("com.apple.backgroundtaskmanagement", true),
    ("com.apple.xpc.smd", false),
    ("com.apple.dock.", true),
    ("com.apple.pbs.", true),
    ("com.apple.finder.ServiceProvider", false),
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
) -> Option<std::path::PathBuf> {
    write_profile(
        app,
        hermes_home,
        agent_cli_access,
        working_dir,
        RUNTIME_PROFILE_FILE,
    )
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
    let _ = write_profile(app, &sandboxed, false, None, READER_PROFILE_FILE);
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
    let temp_roots = sandbox_temp_roots();
    // `working_dir` only ever arrives here through
    // `hermes_working_dir::validate_working_dir` (the spawn re-validates on
    // every start): the "explicit, validated grant" that lets the jail span
    // one user-picked folder without ever widening past it.
    let profile = build_sandbox_profile(&SandboxGrants {
        home: &home,
        hermes_home: &hermes_home,
        runtime_dir: &runtime_dir,
        closed_homes: &closed_homes,
        temp_roots: &temp_roots,
        agent_cli_access,
        working_dir,
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
    _file_name: &str,
) -> Option<std::path::PathBuf> {
    None
}

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
