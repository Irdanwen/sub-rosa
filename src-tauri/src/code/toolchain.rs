//! Language servers and build toolchains under the write jail (ADR-0125).
//!
//! Hermes already sends a language server's diagnostics back after
//! `write_file` and `patch` (`agent/lsp/`, docs/hermes-code-surface.md §2),
//! and the agent already runs the project's builds and tests through its
//! terminal. Under Sub Rosa's Seatbelt profile neither worked: an app started
//! from the Dock has no `node` or `npm` on its `PATH`, and npm, pip, Go and
//! Cargo all write their caches in the person's home, which the jail denies.
//! This module gives the runtime what it needs, for the app's spawn and the
//! headless CLI's alike (one code path, `hermes_bridge` and
//! `hermes_bridge::headless` both call it):
//!
//! - [`apply_runtime_env`]: the person's login-shell `PATH`, and every cache
//!   pointed inside the runtime's own home (`$HERMES_HOME/cache`), which the
//!   jail lets it write. Cargo builds into a target folder of its own per
//!   working folder, there too; `~/.cargo/bin` and the toolchains stay
//!   read-only (the profile denies them by name).
//! - [`lsp_config_block`]: the `lsp:` key of `config.yaml`, written
//!   explicitly, with a TypeScript launcher the app ships (TypeScript 7 has
//!   no `tsserver.js` and serves the protocol itself as `tsc --lsp`) and the
//!   real `rust-analyzer` when the machine has one.
//! - [`start_preinstall`]: at runtime start, in the background, installs the
//!   servers the working folder's languages need, so the first edit does not
//!   spend Hermes' 8 s baseline budget on an npm install (a timeout there
//!   marks the server broken until the runtime restarts).
//!
//! The servers themselves are only ever started by Hermes, inside the jail.
//! The app never runs one: the preinstall runs under the runtime's own
//! profile (unjailed only when the runtime itself is, in Full mode), and the
//! only programs the app runs outside it are the person's login shell (to
//! read its `PATH`) and `rustup which`.

use std::{
    ffi::{OsStr, OsString},
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use sha2::Digest as _;

/// The language-server packages the preinstall puts in
/// `$HERMES_HOME/lsp/subrosa`. Pinned: the first edit should not depend on
/// what npm calls latest that day (typescript 7, for one, broke
/// typescript-language-server). The TypeScript beside the server is the last
/// line with a `tsserver.js`; a project's own TypeScript wins over it.
pub(crate) const TYPESCRIPT_LANGUAGE_SERVER: (&str, &str) = ("typescript-language-server", "6.0.2");
pub(crate) const TYPESCRIPT_FOR_SERVER: (&str, &str) = ("typescript", "6.0.3");
pub(crate) const PYRIGHT: (&str, &str) = ("pyright", "1.1.414");
/// gopls is built by the Go toolchain, Hermes' own recipe.
const GOPLS_MODULE: &str = "golang.org/x/tools/gopls@latest";

/// How long the person's login shell gets to print its `PATH`.
const LOGIN_PATH_TIMEOUT: Duration = Duration::from_secs(5);
const PATH_START: &str = "__SUBROSA_PATH__";
const PATH_END: &str = "__SUBROSA_PATH_END__";
/// Beside the Hermes home, never inside it: the jail cannot write there, so
/// the launcher the runtime executes cannot be rewritten from inside a run.
const LAUNCHER_DIR: &str = "code-toolchain";
const TYPESCRIPT_LAUNCHER: &str = "typescript-lsp";
const NPM_TIMEOUT: Duration = Duration::from_secs(300);
const GO_TIMEOUT: Duration = Duration::from_secs(600);

/// What the runtime is told about where builds go, appended to its
/// environment hint when it works in a folder.
pub(crate) const BUILD_NOTE: &str = "Builds and package caches: Cargo builds into $CARGO_TARGET_DIR (not ./target), and the npm, pip, uv, Go and Cargo caches point into the runtime's own folder, so builds and tests of the working folder run as they would in a terminal.";

/// One install at a time per app process: the app's two runtimes (Sandboxed
/// and Full) share a home, and two npm installs in one prefix corrupt it.
static PREINSTALL: Mutex<()> = Mutex::new(());

/// Where the runtime's caches live, inside its home.
fn cache_dir(hermes_home: &Path) -> PathBuf {
    hermes_home.join("cache")
}

/// The npm prefix (and `bin` for gopls) of the servers the preinstall puts
/// in. Separate from Hermes' own `$HERMES_HOME/lsp`, so a first edit that
/// beats the preinstall and installs by itself never shares an npm tree
/// with it.
pub(crate) fn server_prefix(hermes_home: &Path) -> PathBuf {
    hermes_home.join("lsp").join("subrosa")
}

/// Cargo's target folder for a working folder: one per folder, so two
/// projects never share artefacts, named so a person can tell which is which.
pub(crate) fn cargo_target_dir(hermes_home: &Path, working_dir: Option<&Path>) -> PathBuf {
    let key = match working_dir {
        Some(dir) => {
            let digest = sha2::Sha256::digest(dir.as_os_str().as_encoded_bytes());
            let hex: String = digest
                .iter()
                .take(6)
                .map(|byte| format!("{byte:02x}"))
                .collect();
            let name: String = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                        ch
                    } else {
                        '_'
                    }
                })
                .take(40)
                .collect();
            if name.is_empty() {
                hex
            } else {
                format!("{name}-{hex}")
            }
        }
        None => "workspace".to_string(),
    };
    cache_dir(hermes_home).join("cargo-target").join(key)
}

/// How many Cargo target folders a runtime home keeps, the current one
/// included, and how long an untouched one is kept at most. A Rust target
/// weighs gigabytes; without a bound every folder a person ever opened would
/// stay on disk.
const CARGO_TARGET_KEEP: usize = 3;
const CARGO_TARGET_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(14 * 24 * 3600);
const CARGO_TARGET_STAMP: &str = ".subrosa-last-used";

/// Marks `working_dir`'s target as used now and removes the others past the
/// bound: older than [`CARGO_TARGET_MAX_AGE`], or beyond the
/// [`CARGO_TARGET_KEEP`] most recently used. Returns what it removed.
pub(crate) fn prune_cargo_targets(
    hermes_home: &Path,
    working_dir: Option<&Path>,
    now: std::time::SystemTime,
) -> Vec<PathBuf> {
    let root = cache_dir(hermes_home).join("cargo-target");
    let current = working_dir.map(|dir| cargo_target_dir(hermes_home, Some(dir)));
    if let Some(current) = &current {
        if std::fs::create_dir_all(current).is_ok() {
            let _ = std::fs::write(current.join(CARGO_TARGET_STAMP), b"");
        }
    }
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut others: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && Some(path) != current.as_ref())
        .map(|path| {
            let used = std::fs::metadata(path.join(CARGO_TARGET_STAMP))
                .or_else(|_| std::fs::metadata(&path))
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (used, path)
        })
        .collect();
    others.sort_by(|a, b| b.0.cmp(&a.0));
    let room = CARGO_TARGET_KEEP.saturating_sub(usize::from(current.is_some()));
    let mut removed = Vec::new();
    for (index, (used, path)) in others.into_iter().enumerate() {
        let stale = now.duration_since(used).unwrap_or_default() > CARGO_TARGET_MAX_AGE;
        if (stale || index >= room) && std::fs::remove_dir_all(&path).is_ok() {
            removed.push(path);
        }
    }
    removed
}

/// The variables the runtime gets on top of what it inherits. Pure, so the
/// whole set can be asserted.
pub(crate) fn toolchain_env(
    hermes_home: &Path,
    working_dir: Option<&Path>,
    path: OsString,
    rustup_home: Option<PathBuf>,
) -> Vec<(&'static str, OsString)> {
    let cache = cache_dir(hermes_home);
    let mut env: Vec<(&'static str, OsString)> = vec![
        ("PATH", path),
        ("npm_config_cache", cache.join("npm").into_os_string()),
        ("npm_config_update_notifier", "false".into()),
        ("PIP_CACHE_DIR", cache.join("pip").into_os_string()),
        ("UV_CACHE_DIR", cache.join("uv").into_os_string()),
        ("GOPATH", cache.join("go").into_os_string()),
        (
            "GOMODCACHE",
            cache.join("go").join("pkg").join("mod").into_os_string(),
        ),
        ("GOCACHE", cache.join("go-build").into_os_string()),
        // A Cargo home of the runtime's own: the registry and git checkouts
        // it downloads land here. The person's `~/.cargo/registry` is not
        // made writable instead, because its extracted sources are what
        // their own unjailed builds compile, and a run could rewrite them.
        // Their `~/.cargo/config.toml` is still read (Cargo walks up from
        // the project), and their tools in `~/.cargo/bin` stay on `PATH`.
        ("CARGO_HOME", cache.join("cargo").into_os_string()),
        (
            "CARGO_TARGET_DIR",
            cargo_target_dir(hermes_home, working_dir).into_os_string(),
        ),
        // A toolchain a project pins and the machine lacks fails at once,
        // rather than trying to install into the read-only rustup home.
        ("RUSTUP_AUTO_INSTALL", "0".into()),
    ];
    if let Some(rustup_home) = rustup_home {
        // Moving CARGO_HOME must not move rustup's own home with it.
        env.push(("RUSTUP_HOME", rustup_home.into_os_string()));
    }
    env
}

/// Sets the toolchain environment on a runtime spawn, after
/// `apply_isolated_hermes_env`.
pub(crate) fn apply_runtime_env(cmd: &mut Command, hermes_home: &Path, working_dir: Option<&Path>) {
    for (key, value) in runtime_env(hermes_home, working_dir) {
        cmd.env(key, value);
    }
    if working_dir.is_some() {
        let hint = cmd
            .get_envs()
            .find(|(key, _)| *key == "HERMES_ENVIRONMENT_HINT")
            .and_then(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()));
        let hint = match hint {
            Some(hint) if !hint.is_empty() => format!("{hint} {BUILD_NOTE}"),
            _ => BUILD_NOTE.to_string(),
        };
        cmd.env("HERMES_ENVIRONMENT_HINT", hint);
    }
}

/// [`toolchain_env`] for this machine.
pub(crate) fn runtime_env(
    hermes_home: &Path,
    working_dir: Option<&Path>,
) -> Vec<(&'static str, OsString)> {
    toolchain_env(
        hermes_home,
        working_dir,
        runtime_path(hermes_home),
        rustup_home(),
    )
}

/// The rustup home in force, when there is one.
fn rustup_home() -> Option<PathBuf> {
    let home = std::env::var_os("RUSTUP_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".rustup")))?;
    home.is_dir().then_some(home)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The directories the jail must never let a run write, even when a grant
/// spans them: the toolchains themselves and the tools installed beside
/// them. Read and run only.
pub(crate) fn protected_toolchain_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![home.join(".cargo").join("bin"), home.join(".rustup")];
    if let Some(cargo_home) = std::env::var_os("CARGO_HOME").filter(|value| !value.is_empty()) {
        dirs.push(PathBuf::from(cargo_home).join("bin"));
    }
    if let Some(rustup_home) = std::env::var_os("RUSTUP_HOME").filter(|value| !value.is_empty()) {
        dirs.push(PathBuf::from(rustup_home));
    }
    let mut unique: Vec<PathBuf> = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        if !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

// --- PATH ------------------------------------------------------------------

/// The runtime's `PATH`: the person's login shell's first (what their
/// terminal finds), then the usual install places that exist, then what the
/// app inherited, and Hermes' own Node last, as a fallback for a machine
/// without one.
pub(crate) fn runtime_path(hermes_home: &Path) -> OsString {
    let home = home_dir();
    let known: Vec<PathBuf> = known_tool_dirs(home.as_deref())
        .into_iter()
        .filter(|dir| dir.is_dir())
        .collect();
    compose_path(
        login_path(),
        std::env::var_os("PATH").as_deref(),
        &known,
        &hermes_home.join("node").join("bin"),
    )
}

/// Pure: joins the sources in order, without duplicates or empty entries.
pub(crate) fn compose_path(
    login: Option<&str>,
    inherited: Option<&OsStr>,
    known: &[PathBuf],
    hermes_node: &Path,
) -> OsString {
    let mut entries: Vec<PathBuf> = Vec::new();
    let mut push = |entry: PathBuf| {
        if !entry.as_os_str().is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    };
    if let Some(login) = login {
        for entry in std::env::split_paths(OsStr::new(login)) {
            push(entry);
        }
    }
    for entry in known {
        push(entry.clone());
    }
    if let Some(inherited) = inherited {
        for entry in std::env::split_paths(inherited) {
            push(entry);
        }
    }
    for system in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        if cfg!(unix) {
            push(PathBuf::from(system));
        }
    }
    push(hermes_node.to_path_buf());
    std::env::join_paths(entries).unwrap_or_default()
}

/// Where people install toolchains, for a login shell that could not be
/// read (or that does not set them).
fn known_tool_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/go/bin",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = home {
        for relative in [
            ".cargo/bin",
            ".local/bin",
            "go/bin",
            ".volta/bin",
            ".bun/bin",
            ".deno/bin",
        ] {
            dirs.push(home.join(relative));
        }
    }
    dirs
}

/// The person's login-shell `PATH`, read once per app process.
pub(crate) fn login_path() -> Option<&'static str> {
    static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();
    LOGIN_PATH.get_or_init(read_login_path).as_deref()
}

/// The `PATH` between the markers, or `None` when the shell printed none.
pub(crate) fn parse_marked_path(output: &str) -> Option<String> {
    let start = output.rfind(PATH_START)? + PATH_START.len();
    let end = output[start..].find(PATH_END)? + start;
    let path = output[start..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

#[cfg(unix)]
fn read_login_path() -> Option<String> {
    let shell = login_shell()?;
    let name = Path::new(&shell).file_name()?.to_str()?.to_string();
    // The shells that take `-l -i -c` (the set Hermes' own terminal uses);
    // fish and the like fall back to the known install places.
    if !matches!(
        name.as_str(),
        "zsh" | "bash" | "sh" | "dash" | "ksh" | "mksh"
    ) {
        return None;
    }
    let probe = format!("printf '\\n{PATH_START}%s{PATH_END}\\n' \"$PATH\"");
    // The startup files a login shell sources can sit in a folder the jail
    // may write (a dotfiles repository opened in Code mode), so the probe
    // runs with every write refused: it can do no more than the agent itself.
    let mut cmd = login_probe_command(&shell);
    cmd.args(["-l", "-i", "-c", &probe]);
    crate::child_env::scrub(&mut cmd);
    let started = Instant::now();
    let output = capture_stdout(cmd, LOGIN_PATH_TIMEOUT, Some(PATH_END))?;
    let path = parse_marked_path(&output);
    eprintln!(
        "Read the login shell PATH ({name}) in {} ms: {}.",
        started.elapsed().as_millis(),
        if path.is_some() { "found" } else { "none" }
    );
    path
}

/// The login shell, under a write-refusing Seatbelt profile on macOS.
#[cfg(unix)]
fn login_probe_command(shell: &str) -> Command {
    #[cfg(target_os = "macos")]
    {
        const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
        if Path::new(SANDBOX_EXEC).exists() {
            let mut cmd = Command::new(SANDBOX_EXEC);
            cmd.args(["-p", LOGIN_PROBE_PROFILE, shell]);
            return cmd;
        }
    }
    Command::new(shell)
}

/// Everything the shell does, except write: no file, no rc file, no history.
#[cfg(target_os = "macos")]
const LOGIN_PROBE_PROFILE: &str = "(version 1)(allow default)(deny file-write*)";

#[cfg(not(unix))]
fn read_login_path() -> Option<String> {
    None
}

/// `$SHELL`, else the account's shell.
#[cfg(unix)]
fn login_shell() -> Option<String> {
    if let Some(shell) = std::env::var_os("SHELL").filter(|value| !value.is_empty()) {
        return Some(shell.to_string_lossy().into_owned());
    }
    // SAFETY: getpwuid returns a pointer into static storage or null; it is
    // read at once and not kept.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_shell.is_null() {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr((*entry).pw_shell)
                .to_string_lossy()
                .into_owned(),
        )
    }
}

/// Runs `cmd` and returns its stdout, stopping at `stop_marker` or at EOF,
/// whichever comes first; `None` past `timeout`. The child's process group
/// is reaped either way, so an rc file that starts a daemon holding stdout
/// open cannot hang the spawn.
fn capture_stdout(
    mut cmd: Command,
    timeout: Duration,
    stop_marker: Option<&str>,
) -> Option<String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let marker = stop_marker.map(str::to_string);
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut collected = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    collected.extend_from_slice(&buffer[..read]);
                    if let Some(marker) = &marker {
                        if String::from_utf8_lossy(&collected).contains(marker.as_str()) {
                            break;
                        }
                    }
                }
            }
        }
        let _ = sender.send(String::from_utf8_lossy(&collected).into_owned());
    });
    let output = receiver.recv_timeout(timeout).ok();
    reap(&mut child, Duration::from_millis(500));
    output
}

/// Waits a little for `child`, then kills its process group.
fn reap(child: &mut Child, grace: Duration) {
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    #[cfg(unix)]
    // SAFETY: a plain signal to the group this function's caller created.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The first executable called `name` on `path`.
pub(crate) fn which_in(name: &str, path: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

// --- Language servers --------------------------------------------------------

/// The servers the `lsp:` key names explicitly.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LspSetup {
    /// The TypeScript launcher, when this platform can run one.
    pub typescript: Option<PathBuf>,
    pub pyright: PathBuf,
    pub gopls: PathBuf,
    /// The real rust-analyzer binary, or `None` to switch the server off.
    pub rust_analyzer: Option<PathBuf>,
}

/// Writes the launcher, finds rust-analyzer, and renders the `lsp:` key.
pub(crate) fn lsp_config_block(hermes_home: &Path) -> String {
    render_lsp_config(&prepare_lsp(hermes_home))
}

/// What [`render_lsp_config`] needs, resolved on this machine.
pub(crate) fn prepare_lsp(hermes_home: &Path) -> LspSetup {
    let prefix = server_prefix(hermes_home);
    let rust_analyzer = find_rust_analyzer(&runtime_path(hermes_home));
    if rust_analyzer.is_none() {
        eprintln!("No working rust-analyzer on this machine: Rust diagnostics stay off (it is never downloaded).");
    }
    LspSetup {
        typescript: write_typescript_launcher(hermes_home),
        pyright: prefix
            .join("node_modules")
            .join(".bin")
            .join("pyright-langserver"),
        gopls: prefix.join("bin").join("gopls"),
        rust_analyzer,
    }
}

/// The `lsp:` key. Hermes uses only `command[0]`, and only when that path
/// exists; otherwise it looks on `PATH`, then installs by itself (under the
/// jail, which the cache variables now let succeed). Pure.
pub(crate) fn render_lsp_config(setup: &LspSetup) -> String {
    let quote = |path: &Path| {
        serde_json::to_string(&path.to_string_lossy()).unwrap_or_else(|_| "\"\"".to_string())
    };
    let mut out = String::from(
        "lsp:\n  enabled: true\n  wait_mode: document\n  wait_timeout: 5.0\n  install_strategy: auto\n  servers:\n",
    );
    if let Some(launcher) = &setup.typescript {
        out.push_str(&format!(
            "    typescript:\n      command: [{}]\n",
            quote(launcher)
        ));
    }
    out.push_str(&format!(
        "    pyright:\n      command: [{}]\n",
        quote(&setup.pyright)
    ));
    out.push_str(&format!(
        "    gopls:\n      command: [{}]\n",
        quote(&setup.gopls)
    ));
    match &setup.rust_analyzer {
        Some(binary) => out.push_str(&format!(
            "    rust-analyzer:\n      command: [{}]\n",
            quote(binary)
        )),
        // Hermes would otherwise find rustup's proxy on PATH, fail to start
        // it, and spend the first edit's budget learning that.
        None => out.push_str("    rust-analyzer:\n      disabled: true\n"),
    }
    out
}

/// The TypeScript launcher's text. Pure.
pub(crate) fn typescript_launcher_script(prefix: &Path, hermes_lsp_bin: &Path) -> String {
    let quote = |path: PathBuf| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let ours = quote(
        prefix
            .join("node_modules")
            .join(".bin")
            .join("typescript-language-server"),
    );
    let hermes = quote(hermes_lsp_bin.join("typescript-language-server"));
    format!(
        r#"#!/bin/sh
# Generated by Sub Rosa (ADR-0125) at every runtime start. Do not edit.
# The TypeScript language server Hermes starts, inside the write jail, from
# the project root. TypeScript 7 ships no tsserver.js, which
# typescript-language-server needs, and serves the protocol itself
# (tsc --lsp). A project on an older TypeScript keeps the language server,
# which then loads the project's own tsserver.
dir=$PWD
while :; do
  if [ -f "$dir/node_modules/typescript/package.json" ]; then
    if [ ! -f "$dir/node_modules/typescript/lib/tsserver.js" ] && [ -x "$dir/node_modules/.bin/tsc" ]; then
      exec "$dir/node_modules/.bin/tsc" --lsp "$@"
    fi
    break
  fi
  if [ "$dir" = / ] || [ -z "$dir" ]; then
    break
  fi
  dir=$(dirname "$dir")
done
for server in {ours} {hermes}; do
  if [ -x "$server" ]; then
    exec "$server" "$@"
  fi
done
exec typescript-language-server "$@"
"#
    )
}

/// Writes the launcher beside the home (see [`LAUNCHER_DIR`]) and returns
/// its path. `None` off Unix, where a shell launcher cannot run.
fn write_typescript_launcher(hermes_home: &Path) -> Option<PathBuf> {
    if !cfg!(unix) {
        return None;
    }
    let dir = hermes_home.parent()?.join(LAUNCHER_DIR);
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(TYPESCRIPT_LAUNCHER);
    let body = typescript_launcher_script(
        &server_prefix(hermes_home),
        &hermes_home.join("lsp").join("bin"),
    );
    if std::fs::read_to_string(&path).ok().as_deref() == Some(body.as_str()) && is_executable(&path)
    {
        return Some(path);
    }
    let temp = dir.join(format!(".{TYPESCRIPT_LAUNCHER}.tmp"));
    std::fs::write(&temp, &body).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755)).ok()?;
    }
    std::fs::rename(&temp, &path).ok()?;
    Some(path)
}

/// The rust-analyzer that actually runs. rustup installs a proxy for it on
/// every machine, which fails unless the component is installed, so a proxy
/// is resolved through `rustup which` to the toolchain's own binary.
fn find_rust_analyzer(path: &OsStr) -> Option<PathBuf> {
    let found = which_in("rust-analyzer", path)?;
    // The app runs `rustup` itself, outside the jail, so it never takes one
    // from `path`: the runtime's `PATH` holds folders the jail can write.
    let Some(rustup) = trusted_rustup() else {
        return Some(found);
    };
    if !same_binary(&found, &rustup) {
        return Some(found);
    }
    let mut cmd = Command::new(&rustup);
    cmd.args(["which", "rust-analyzer"])
        .env("PATH", path)
        .env("RUSTUP_AUTO_INSTALL", "0");
    crate::child_env::scrub(&mut cmd);
    let output = capture_stdout(cmd, Duration::from_secs(5), None)?;
    let real = PathBuf::from(output.trim());
    (real.is_absolute() && is_executable(&real)).then_some(real)
}

/// A `rustup` the app may run unjailed: only from where rustup installs
/// itself (`~/.cargo/bin`, whose writes the jail refuses by name) or a system
/// package prefix, never a folder found on the runtime's `PATH`.
fn trusted_rustup() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(cargo_home) = std::env::var_os("CARGO_HOME").filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(cargo_home).join("bin").join("rustup"));
    }
    if let Some(home) = home_dir() {
        candidates.push(home.join(".cargo").join("bin").join("rustup"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/rustup"));
    candidates.push(PathBuf::from("/usr/local/bin/rustup"));
    candidates
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

/// Whether two paths are the same program (a symlink or a hard link).
fn same_binary(left: &Path, right: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::canonicalize(left), std::fs::canonicalize(right)) else {
        return false;
    };
    if a == b {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        if let (Ok(a), Ok(b)) = (std::fs::metadata(&a), std::fs::metadata(&b)) {
            return a.dev() == b.dev() && a.ino() == b.ino();
        }
    }
    false
}

// --- Preinstall ----------------------------------------------------------------

/// The languages a folder holds, from its markers, at most two levels down.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Languages {
    pub typescript: bool,
    pub python: bool,
    pub rust: bool,
    pub go: bool,
}

impl Languages {
    fn any(self) -> bool {
        self.typescript || self.python || self.rust || self.go
    }
}

/// Folders a marker scan never enters.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "venv",
    "__pycache__",
    "vendor",
];

/// Reads markers in `dir` and its direct sub-folders. Bounded: at most a few
/// thousand entries, so a huge folder costs milliseconds.
pub(crate) fn detect_languages(dir: &Path) -> Languages {
    let mut found = Languages::default();
    let mut budget = 4000usize;
    scan(dir, 0, &mut found, &mut budget);
    found
}

fn scan(dir: &Path, depth: usize, found: &mut Languages, budget: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if is_dir {
            if depth < 1 && !name.starts_with('.') && !SKIPPED_DIRS.contains(&name.as_ref()) {
                children.push(entry.path());
            }
            continue;
        }
        match name.as_ref() {
            "package.json" | "tsconfig.json" => found.typescript = true,
            "pyproject.toml" | "setup.py" | "setup.cfg" | "requirements.txt" | "Pipfile" => {
                found.python = true;
            }
            "Cargo.toml" => found.rust = true,
            "go.mod" | "go.work" => found.go = true,
            _ => {
                let extension = Path::new(name.as_ref())
                    .extension()
                    .and_then(OsStr::to_str)
                    .unwrap_or("");
                match extension {
                    "ts" | "tsx" | "mts" | "cts" => found.typescript = true,
                    "py" => found.python = true,
                    "rs" => found.rust = true,
                    "go" => found.go = true,
                    _ => {}
                }
            }
        }
    }
    for child in children {
        scan(&child, depth + 1, found, budget);
    }
}

/// One preinstall step: a program to run, or a line to log.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Step {
    Run {
        label: String,
        program: PathBuf,
        args: Vec<OsString>,
        env: Vec<(&'static str, OsString)>,
        timeout: Duration,
    },
    Note(String),
}

/// The installed version of an npm package in `prefix`, if any.
fn installed_npm_version(prefix: &Path, package: &str) -> Option<String> {
    let manifest = std::fs::read_to_string(
        prefix
            .join("node_modules")
            .join(package)
            .join("package.json"),
    )
    .ok()?;
    let value: serde_json::Value = serde_json::from_str(&manifest).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// What to install for `languages`, given the runtime's `PATH`. Pure apart
/// from reading what is already installed.
pub(crate) fn preinstall_plan(
    languages: Languages,
    hermes_home: &Path,
    path: &OsStr,
    rust_analyzer: Option<&Path>,
) -> Vec<Step> {
    let prefix = server_prefix(hermes_home);
    let mut steps = Vec::new();
    let mut packages: Vec<(&str, &str)> = Vec::new();
    if languages.typescript {
        packages.push(TYPESCRIPT_LANGUAGE_SERVER);
        packages.push(TYPESCRIPT_FOR_SERVER);
    }
    if languages.python {
        packages.push(PYRIGHT);
    }
    packages.retain(|(name, version)| {
        installed_npm_version(&prefix, name).as_deref() != Some(*version)
    });
    if !packages.is_empty() {
        match which_in("npm", path) {
            Some(npm) => {
                let mut args: Vec<OsString> = vec![
                    "install".into(),
                    "--prefix".into(),
                    prefix.clone().into_os_string(),
                    "--no-fund".into(),
                    "--no-audit".into(),
                    "--ignore-scripts".into(),
                    "--loglevel=error".into(),
                ];
                args.extend(
                    packages
                        .iter()
                        .map(|(name, version)| OsString::from(format!("{name}@{version}"))),
                );
                steps.push(Step::Run {
                    label: format!(
                        "npm install {}",
                        packages
                            .iter()
                            .map(|(name, version)| format!("{name}@{version}"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    ),
                    program: npm,
                    args,
                    env: Vec::new(),
                    timeout: NPM_TIMEOUT,
                });
            }
            None => steps.push(Step::Note(
                "npm is not on the runtime's PATH: the TypeScript and Python servers are not preinstalled.".to_string(),
            )),
        }
    }
    if languages.go
        && which_in("gopls", path).is_none()
        && !is_executable(&prefix.join("bin").join("gopls"))
    {
        match which_in("go", path) {
            Some(go) => steps.push(Step::Run {
                label: format!("go install {GOPLS_MODULE}"),
                program: go,
                args: vec!["install".into(), GOPLS_MODULE.into()],
                env: vec![("GOBIN", prefix.join("bin").into_os_string())],
                timeout: GO_TIMEOUT,
            }),
            None => steps.push(Step::Note(
                "go is not on the runtime's PATH: gopls is not preinstalled.".to_string(),
            )),
        }
    }
    if languages.rust {
        steps.push(Step::Note(match rust_analyzer {
            Some(binary) => format!("rust-analyzer: {}", binary.display()),
            None => "rust-analyzer is not on this machine and is not downloaded: Rust diagnostics stay off.".to_string(),
        }));
    }
    steps
}

/// Installs, in the background, the servers `working_dir`'s languages need.
/// `jail` is the runtime's own `(sandbox-exec, profile)`, `None` when the
/// runtime runs unjailed. Best-effort and logged to
/// `$HERMES_HOME/logs/lsp-preinstall.log`; nothing waits for it.
pub(crate) fn start_preinstall(
    hermes_home: &Path,
    working_dir: Option<&Path>,
    jail: Option<(&Path, &Path)>,
) {
    {
        let hermes_home = hermes_home.to_path_buf();
        let working_dir = working_dir.map(Path::to_path_buf);
        std::thread::spawn(move || {
            for removed in prune_cargo_targets(
                &hermes_home,
                working_dir.as_deref(),
                std::time::SystemTime::now(),
            ) {
                eprintln!(
                    "Removed an unused Cargo target folder: {}",
                    removed.display()
                );
            }
        });
    }
    let Some(working_dir) = working_dir else {
        return;
    };
    let languages = detect_languages(working_dir);
    if !languages.any() {
        return;
    }
    let hermes_home = hermes_home.to_path_buf();
    let working_dir = working_dir.to_path_buf();
    let jail = jail.map(|(exec, profile)| (exec.to_path_buf(), profile.to_path_buf()));
    std::thread::spawn(move || {
        let _one_at_a_time = PREINSTALL.lock();
        let path = runtime_path(&hermes_home);
        let rust_analyzer = if languages.rust {
            find_rust_analyzer(&path)
        } else {
            None
        };
        let steps = preinstall_plan(languages, &hermes_home, &path, rust_analyzer.as_deref());
        if steps.is_empty() {
            return;
        }
        let env = runtime_env(&hermes_home, Some(&working_dir));
        let jail = jail
            .as_ref()
            .map(|(exec, profile)| (exec.as_path(), profile.as_path()));
        run_steps(&hermes_home, &steps, &env, jail, &format!("{languages:?}"));
    });
}

/// Runs the steps one after the other, logging each.
pub(crate) fn run_steps(
    hermes_home: &Path,
    steps: &[Step],
    env: &[(&'static str, OsString)],
    jail: Option<(&Path, &Path)>,
    context: &str,
) -> Vec<Option<i32>> {
    let log_dir = hermes_home.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("lsp-preinstall.log"))
        .ok();
    let mut line = |text: String| {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        if let Some(log) = log.as_mut() {
            let _ = writeln!(log, "[{stamp}] {text}");
        }
    };
    line(format!(
        "preinstall for {context}, {}",
        if jail.is_some() {
            "under the runtime's jail"
        } else {
            "unjailed (the runtime is)"
        }
    ));
    let mut codes = Vec::new();
    for step in steps {
        match step {
            Step::Note(note) => line(note.clone()),
            Step::Run {
                label,
                program,
                args,
                env: step_env,
                timeout,
            } => {
                let mut cmd = match jail {
                    Some((exec, profile)) => {
                        let mut cmd = Command::new(exec);
                        cmd.arg("-f").arg(profile).arg(program);
                        cmd
                    }
                    None => Command::new(program),
                };
                cmd.args(args);
                crate::child_env::scrub(&mut cmd);
                for (key, value) in env.iter().chain(step_env) {
                    cmd.env(key, value);
                }
                cmd.current_dir(hermes_home).stdin(Stdio::null());
                let output = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log_dir.join("lsp-preinstall.log"));
                match output.and_then(|file| Ok((file.try_clone()?, file))) {
                    Ok((out, err)) => {
                        cmd.stdout(out).stderr(err);
                    }
                    Err(_) => {
                        cmd.stdout(Stdio::null()).stderr(Stdio::null());
                    }
                }
                #[cfg(unix)]
                {
                    use std::os::unix::process::CommandExt as _;
                    cmd.process_group(0);
                }
                let started = Instant::now();
                let code = match cmd.spawn() {
                    Ok(mut child) => wait_with_timeout(&mut child, *timeout),
                    Err(error) => {
                        line(format!("{label}: could not start ({error})"));
                        codes.push(None);
                        continue;
                    }
                };
                line(format!(
                    "{label}: {} in {:.1} s",
                    match code {
                        Some(0) => "done".to_string(),
                        Some(code) => format!("exit {code}"),
                        None => "timed out or killed".to_string(),
                    },
                    started.elapsed().as_secs_f64()
                ));
                codes.push(code);
            }
        }
    }
    codes
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                reap(child, Duration::ZERO);
                return None;
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn every_cache_points_inside_the_home_and_cargo_builds_beside_the_project() {
        let home = Path::new("/data/hermes");
        let env = toolchain_env(
            home,
            Some(Path::new("/work/My repo")),
            OsString::from("/usr/bin"),
            Some(PathBuf::from("/Users/me/.rustup")),
        );
        let get = |key: &str| {
            env.iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| PathBuf::from(value))
                .unwrap()
        };
        for key in [
            "npm_config_cache",
            "PIP_CACHE_DIR",
            "UV_CACHE_DIR",
            "GOPATH",
            "GOMODCACHE",
            "GOCACHE",
            "CARGO_HOME",
            "CARGO_TARGET_DIR",
        ] {
            assert!(get(key).starts_with("/data/hermes/cache"), "{key}");
        }
        let target = get("CARGO_TARGET_DIR");
        let name = target.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("My_repo-"), "{name}");
        assert_eq!(get("RUSTUP_HOME"), PathBuf::from("/Users/me/.rustup"));
        assert_eq!(get("PATH"), PathBuf::from("/usr/bin"));
        // Two folders never share a target, one folder always gets the same.
        assert_ne!(
            cargo_target_dir(home, Some(Path::new("/a/repo"))),
            cargo_target_dir(home, Some(Path::new("/b/repo")))
        );
        assert_eq!(
            cargo_target_dir(home, Some(Path::new("/a/repo"))),
            cargo_target_dir(home, Some(Path::new("/a/repo")))
        );
    }

    #[test]
    fn the_runtime_path_puts_the_login_shell_first_and_hermes_node_last() {
        let joined = compose_path(
            Some("/Users/me/.local/bin:/opt/homebrew/bin"),
            Some(OsStr::new("/usr/bin:/opt/homebrew/bin")),
            &[PathBuf::from("/Users/me/.cargo/bin")],
            Path::new("/data/hermes/node/bin"),
        );
        let entries: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(entries[0], PathBuf::from("/Users/me/.local/bin"));
        assert_eq!(entries[1], PathBuf::from("/opt/homebrew/bin"));
        assert_eq!(entries[2], PathBuf::from("/Users/me/.cargo/bin"));
        assert_eq!(
            entries.last().unwrap(),
            &PathBuf::from("/data/hermes/node/bin")
        );
        let homebrew = entries
            .iter()
            .filter(|entry| *entry == Path::new("/opt/homebrew/bin"))
            .count();
        assert_eq!(homebrew, 1, "no duplicates");
    }

    #[test]
    fn the_login_path_is_read_between_its_markers_only() {
        let noisy = format!("Welcome!\nlast login\n\n{PATH_START}/a:/b{PATH_END}\n");
        assert_eq!(parse_marked_path(&noisy).as_deref(), Some("/a:/b"));
        assert_eq!(parse_marked_path("no markers here"), None);
        assert_eq!(parse_marked_path(&format!("{PATH_START}{PATH_END}")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_never_finishes_is_given_up_on() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        let started = Instant::now();
        assert_eq!(capture_stdout(cmd, Duration::from_millis(300), None), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        let mut cmd = Command::new("/bin/sh");
        cmd.args([
            "-c",
            &format!("printf '{PATH_START}/x{PATH_END}\\n'; sleep 30"),
        ]);
        let output = capture_stdout(cmd, Duration::from_secs(5), Some(PATH_END)).unwrap();
        assert_eq!(parse_marked_path(&output).as_deref(), Some("/x"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_lsp_key_names_the_launcher_and_switches_off_a_missing_rust_analyzer() {
        let setup = LspSetup {
            typescript: Some(PathBuf::from("/data/code-toolchain/typescript-lsp")),
            pyright: PathBuf::from("/data/hermes/lsp/subrosa/node_modules/.bin/pyright-langserver"),
            gopls: PathBuf::from("/data/hermes/lsp/subrosa/bin/gopls"),
            rust_analyzer: None,
        };
        let parsed: serde_yaml::Value = serde_yaml::from_str(&render_lsp_config(&setup)).unwrap();
        let lsp = &parsed["lsp"];
        assert_eq!(lsp["enabled"], true);
        assert_eq!(lsp["wait_mode"], "document");
        assert_eq!(lsp["wait_timeout"], 5.0);
        assert_eq!(lsp["install_strategy"], "auto");
        assert_eq!(
            lsp["servers"]["typescript"]["command"][0],
            "/data/code-toolchain/typescript-lsp"
        );
        assert_eq!(lsp["servers"]["rust-analyzer"]["disabled"], true);
        let with_rust = LspSetup {
            rust_analyzer: Some(PathBuf::from("/Users/me/Application Support/ra")),
            ..setup
        };
        let parsed: serde_yaml::Value =
            serde_yaml::from_str(&render_lsp_config(&with_rust)).unwrap();
        assert_eq!(
            parsed["lsp"]["servers"]["rust-analyzer"]["command"][0],
            "/Users/me/Application Support/ra"
        );
    }

    #[test]
    fn the_launcher_quotes_its_paths_and_prefers_tsc_lsp_without_tsserver() {
        let script = typescript_launcher_script(
            Path::new("/Users/me/Library/Application Support/x/hermes/lsp/subrosa"),
            Path::new("/Users/me/it's/lsp/bin"),
        );
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("'/Users/me/Library/Application Support/x/hermes/lsp/subrosa/node_modules/.bin/typescript-language-server'"));
        assert!(script.contains("'/Users/me/it'\\''s/lsp/bin/typescript-language-server'"));
        assert!(script.contains("--lsp \"$@\""));
        assert!(script.contains("tsserver.js"));
    }

    #[test]
    fn languages_come_from_markers_two_levels_down_and_skip_dependencies() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "").unwrap();
        std::fs::create_dir_all(dir.path().join("web")).unwrap();
        std::fs::write(dir.path().join("web/tsconfig.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::write(dir.path().join("node_modules/x/setup.py"), "").unwrap();
        std::fs::create_dir_all(dir.path().join("deep/er")).unwrap();
        std::fs::write(dir.path().join("deep/er/go.mod"), "").unwrap();
        let found = detect_languages(dir.path());
        assert_eq!(
            found,
            Languages {
                typescript: true,
                python: false,
                rust: true,
                go: false,
            }
        );
    }

    #[test]
    fn the_plan_installs_only_what_is_missing_or_off_its_pin() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let npm = bin.path().join("npm");
        std::fs::write(&npm, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = bin.path().as_os_str();
        let all = Languages {
            typescript: true,
            python: true,
            rust: true,
            go: true,
        };
        let steps = preinstall_plan(all, home.path(), path, None);
        let Step::Run { label, args, .. } = &steps[0] else {
            panic!("npm first: {steps:?}")
        };
        assert!(label.contains("typescript-language-server@6.0.2"));
        assert!(label.contains("pyright@"));
        assert!(args.iter().any(|arg| arg == "--ignore-scripts"));
        assert!(steps
            .iter()
            .any(|step| matches!(step, Step::Note(note) if note.contains("go is not"))));
        assert!(steps
            .iter()
            .any(|step| matches!(step, Step::Note(note) if note.contains("not downloaded"))));
        // Installed at the pin: nothing to do for Python.
        let installed = server_prefix(home.path()).join("node_modules/pyright");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(
            installed.join("package.json"),
            format!(r#"{{"version":"{}"}}"#, PYRIGHT.1),
        )
        .unwrap();
        let python_only = Languages {
            python: true,
            ..Languages::default()
        };
        assert!(preinstall_plan(python_only, home.path(), path, None).is_empty());
    }

    #[test]
    fn the_hint_gains_the_build_note_only_with_a_working_folder() {
        let home = Path::new("/data/hermes");
        let mut with_folder = Command::new("/usr/bin/true");
        with_folder.env("HERMES_ENVIRONMENT_HINT", "Sandboxed.");
        apply_runtime_env(&mut with_folder, home, Some(Path::new("/work")));
        let hint = with_folder
            .get_envs()
            .find(|(key, _)| *key == "HERMES_ENVIRONMENT_HINT")
            .and_then(|(_, value)| value)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(hint.starts_with("Sandboxed. "));
        assert!(hint.contains("CARGO_TARGET_DIR"));
        let mut chat = Command::new("/usr/bin/true");
        apply_runtime_env(&mut chat, home, None);
        assert!(!chat
            .get_envs()
            .any(|(key, _)| key == "HERMES_ENVIRONMENT_HINT"));
    }

    #[test]
    fn cargo_targets_are_bounded_by_count_and_age() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("cache").join("cargo-target");
        let now = std::time::SystemTime::now();
        let folders: Vec<PathBuf> = (0..5)
            .map(|n| PathBuf::from(format!("/work/p{n}")))
            .collect();
        // Five folders used one after the other, the last one first.
        for folder in &folders {
            prune_cargo_targets(home.path(), Some(folder), now);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let left: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(left.len(), CARGO_TARGET_KEEP);
        for kept in &folders[2..] {
            assert!(
                cargo_target_dir(home.path(), Some(kept)).is_dir(),
                "{kept:?}"
            );
        }
        // Weeks later, only the folder in use stays.
        let later = now + CARGO_TARGET_MAX_AGE + std::time::Duration::from_secs(60);
        let removed = prune_cargo_targets(home.path(), Some(&folders[4]), later);
        assert_eq!(removed.len(), CARGO_TARGET_KEEP - 1);
        assert!(cargo_target_dir(home.path(), Some(&folders[4])).is_dir());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_login_shell_probe_cannot_write() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("written");
        let mut cmd = login_probe_command("/bin/sh");
        cmd.args(["-c", &format!("echo x > '{}'", target.display())]);
        let _ = cmd.status();
        assert!(!target.exists(), "the probe wrote a file");
    }
}
