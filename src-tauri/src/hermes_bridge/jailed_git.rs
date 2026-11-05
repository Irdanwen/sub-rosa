//! Every `git` the app runs on a folder the jail can write (ADR-0140, final
//! pass and its addendum of 2026-11-03).
//!
//! The code review and the council read a session's working folder with
//! git, outside the jail, while a sandboxed session writes that folder,
//! `.git` included. Git obeys what it finds there: `core.fsmonitor` in
//! `.git/config` is a command run by `git status`, and so are a diff driver,
//! a textconv, a clean or smudge filter named by `.gitattributes` or
//! `.git/info/attributes`, a hook, an ssh command. Measured: the jail wrote
//! `[core] fsmonitor = <cmd>`, and a `git status` the app ran executed it
//! outside the jail.
//!
//! Three layers, each holding on its own for what it covers:
//!
//! 1. The command's own configuration, which outranks the repository's:
//!    no system or global file, `core.fsmonitor=false`, hooks pointed at
//!    `/dev/null`, no external diff, no ssh command, no protocol, no
//!    attributes or excludes file; the in-tree attributes read from the
//!    empty tree (`GIT_ATTR_SOURCE`, git 2.42 and later; the machine's is
//!    2.50), so `.gitattributes` names no filter or driver.
//! 2. Before each command, the configuration git would read is listed, and
//!    a filter, a diff command, a textconv or a merge driver defined in it
//!    refuses the folder: no setting turns those off, and
//!    `.git/info/attributes`, which the jail can write too, could name them.
//! 3. On macOS, git runs under a profile that refuses by default: it may run
//!    only git and its helpers, read only git's installation, the system's
//!    libraries, the repository (its working tree and store) and a temp
//!    folder of the app's, write only that temp folder, and reach no
//!    network. Whatever git still runs (a filter planted between the check
//!    and the command) runs there, where `/bin/sh` does not even start. The
//!    profile travels as an argument (`sandbox-exec -p`), never through a
//!    shared file another call could be rewriting.
//!
//! The process keeps the app's privacy responsibility: measured, a git
//! started with it disclaimed cannot read a folder under `~/Documents`
//! ("Unable to read current working directory: Operation not permitted"),
//! where working folders usually are; the profile bounds what those grants
//! reach to the paths above.
//!
//! The callers also ask for no external diff and no textconv, and read a
//! file's past content with `cat-file blob`, never through filters.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::domain::types::AppError;

/// The empty tree's object name: attributes read from it are none.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// The settings each git command carries, which outrank the repository's.
pub(crate) const NEUTRAL_CONFIG: &[(&str, &str)] = &[
    ("core.fsmonitor", "false"),
    ("core.hooksPath", "/dev/null"),
    ("diff.external", ""),
    ("core.sshCommand", "false"),
    ("protocol.allow", "never"),
    ("core.attributesFile", "/dev/null"),
    ("core.excludesFile", "/dev/null"),
    ("core.pager", "cat"),
    ("core.untrackedCache", "false"),
];

/// Git under the profile: the binary to run and the profile's text.
#[derive(Clone, Debug)]
pub(crate) struct Sandbox {
    git: PathBuf,
    profile: String,
}

/// How long any git the app runs may take. A folder the jail writes can
/// make git wait for ever (a named pipe included by `.git/config`,
/// measured): past this, git and what it started are stopped.
pub(crate) const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Runs git `args` on `folder` with every layer, within `GIT_TIMEOUT`.
/// Fails closed: where the jail engages and git cannot be confined, or
/// where the folder's configuration names a program or a working tree
/// elsewhere, no git runs.
pub(crate) fn run(folder: &Path, args: &[&str]) -> Result<Output, AppError> {
    run_within(folder, args, GIT_TIMEOUT)
}

/// The same, within `timeout`.
pub(crate) fn run_within(
    folder: &Path,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<Output, AppError> {
    let sandbox = if super::sandbox_profile::jail_engages() {
        Some(sandbox_for(folder).map_err(|error| {
            AppError::new(
                "git_unavailable",
                format!("Git cannot be run safely here: {error}"),
            )
        })?)
    } else {
        None
    };
    refuse_planted_programs(folder, sandbox.as_ref(), timeout)?;
    #[cfg(test)]
    AFTER_THE_CHECK.with(|hook| hook.take().map(|hook| hook()));
    let mut cmd = build(folder, sandbox.as_ref(), true);
    cmd.args(confined_args(args));
    output_within(cmd, timeout)
}

// Tests only: what happens between the check and the command (the jail
// writing the folder meanwhile).
#[cfg(test)]
thread_local! {
    static AFTER_THE_CHECK: std::cell::Cell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::Cell::new(None) };
}

/// For async callers: the check and git itself run off the async runtime
/// (on a blocking thread), never on one of its threads.
pub(crate) async fn run_async(folder: PathBuf, args: Vec<String>) -> Result<Output, AppError> {
    run_async_within(folder, args, GIT_TIMEOUT).await
}

/// The same, within `timeout`.
pub(crate) async fn run_async_within(
    folder: PathBuf,
    args: Vec<String>,
    timeout: std::time::Duration,
) -> Result<Output, AppError> {
    tokio::task::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run_within(&folder, &args, timeout)
    })
    .await
    .map_err(|error| AppError::new("git_unavailable", error.to_string()))?
}

/// The arguments as git gets them: `status` and `diff` never go into a
/// submodule, whose configuration and attributes the check has not read
/// (measured: only the command-line option holds; the same setting in the
/// command's configuration loses to a `submodule.<name>.ignore` the folder
/// sets).
pub(crate) fn confined_args<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut out = args.to_vec();
    if matches!(args.first(), Some(&"status") | Some(&"diff")) {
        out.insert(1, "--ignore-submodules=all");
    }
    out
}

/// Runs `cmd` and collects its output, all within `timeout`: one deadline
/// for the process and for its pipes (a process it started may hold them
/// open after it ended). Past it, git's whole process group is killed (git
/// starts its helpers in it) and the pipes are not waited on any longer.
fn output_within(mut cmd: Command, timeout: std::time::Duration) -> Result<Output, AppError> {
    use std::io::Read as _;
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let deadline = std::time::Instant::now() + timeout;
    let mut child = cmd
        .spawn()
        .map_err(|error| AppError::new("git_unavailable", error.to_string()))?;
    let (sender, received) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    let drain = |pipe: Option<Box<dyn std::io::Read + Send>>, is_out: bool| {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            let _ = sender.send((is_out, bytes));
        });
    };
    drain(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn std::io::Read + Send>),
        true,
    );
    drain(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn std::io::Read + Send>),
        false,
    );
    drop(sender);
    let timed_out = |child: &mut std::process::Child| {
        #[cfg(unix)]
        super::jail_reaper_gate::killpg_child(child, libc::SIGKILL);
        #[cfg(not(unix))]
        let _ = child.kill();
        let _ = child.wait();
        AppError::new(
            "git_timed_out",
            "Git took too long on this folder and was stopped.",
        )
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => return Err(AppError::new("git_unavailable", error.to_string())),
        }
        if std::time::Instant::now() >= deadline {
            return Err(timed_out(&mut child));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    // The pipes, by the same deadline.
    let (mut stdout, mut stderr, mut open) = (Vec::new(), Vec::new(), 2);
    while open > 0 {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match received.recv_timeout(left) {
            Ok((true, bytes)) => stdout = bytes,
            Ok((false, bytes)) => stderr = bytes,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(timed_out(&mut child));
            }
        }
        open -= 1;
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Builds the command: under `sandbox` when given, with the neutral
/// configuration when `neutral` (both, outside tests).
pub(crate) fn build(folder: &Path, sandbox: Option<&Sandbox>, neutral: bool) -> Command {
    let mut cmd = match sandbox {
        Some(sandbox) => {
            let mut cmd = Command::new(super::SANDBOX_EXEC_PATH);
            cmd.arg("-p").arg(&sandbox.profile).arg(&sandbox.git);
            cmd
        }
        None => Command::new("git"),
    };
    cmd.arg("-C").arg(folder);
    // Nothing of the caller's git environment: a GIT_DIR or a config of its
    // own would be read instead of the folder's.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(key);
        }
    }
    // No system or global file, ever: the profile would refuse reading
    // them, and they are the person's, not the folder's.
    cmd.env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat");
    if let Some(tmp) = git_tmp() {
        cmd.env("TMPDIR", tmp);
    }
    if neutral {
        // The working tree is the one the app found, never one the folder's
        // configuration names (which would have git look at files
        // elsewhere). Measured: only `GIT_WORK_TREE` (or `--work-tree`)
        // outranks a `core.worktree` the folder sets; the same key in the
        // command's configuration does not.
        if let Some(found) = places(folder) {
            cmd.env("GIT_WORK_TREE", found.tree);
        }
        // The person's own excludes file, read as a list of patterns: what
        // they ignore everywhere (an `.env`) stays ignored here.
        let excludes = person_excludes_file();
        let excludes = excludes
            .as_deref()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/dev/null".to_string());
        cmd.env("GIT_ATTR_SOURCE", EMPTY_TREE)
            .env("GIT_CONFIG_COUNT", NEUTRAL_CONFIG.len().to_string());
        for (index, (key, value)) in NEUTRAL_CONFIG.iter().enumerate() {
            let value = if *key == "core.excludesFile" {
                excludes.as_str()
            } else {
                value
            };
            cmd.env(format!("GIT_CONFIG_KEY_{index}"), key)
                .env(format!("GIT_CONFIG_VALUE_{index}"), value);
        }
    }
    cmd
}

// Tests only: the home the person's git configuration is read from.
#[cfg(test)]
pub(crate) static TEST_HOME: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// The person's global excludes file, found the way git finds it without
/// running git on the global configuration: `core.excludesFile` read as
/// text from `$XDG_CONFIG_HOME/git/config` then `~/.gitconfig` (the later
/// wins), `[include]` files followed as text, `~/` expanded; otherwise the
/// default `$XDG_CONFIG_HOME/git/ignore`. A conditional include
/// (`[includeIf]`) depends on the repository and is not followed, nor is a
/// relative path: then the default applies. `None` when there is no such
/// file. Found once per start (the configuration is the person's, read as
/// they left it when the app started).
pub(crate) fn person_excludes_file() -> Option<PathBuf> {
    #[cfg(not(test))]
    {
        static FOUND: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
        FOUND.get_or_init(find_person_excludes_file).clone()
    }
    #[cfg(test)]
    find_person_excludes_file()
}

fn find_person_excludes_file() -> Option<PathBuf> {
    #[cfg(test)]
    let home = TEST_HOME
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))?;
    #[cfg(not(test))]
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    let mut named: Option<PathBuf> = None;
    for file in [config_home.join("git/config"), home.join(".gitconfig")] {
        read_excludes_setting(&file, &home, 0, &mut named);
    }
    let path = named.unwrap_or_else(|| config_home.join("git/ignore"));
    let path = std::fs::canonicalize(path).ok()?;
    std::fs::metadata(&path).ok()?.is_file().then_some(path)
}

/// Reads `core.excludesFile` from one configuration file as text, following
/// `[include] path` the same way; nothing is run.
fn read_excludes_setting(file: &Path, home: &Path, depth: usize, named: &mut Option<PathBuf>) {
    if depth > 8 {
        return;
    }
    let Some(text) = read_person_config(file) else {
        return;
    };
    let mut section = String::new();
    for raw in text.lines() {
        let line = strip_comment(raw).trim().to_string();
        if let Some(header) = line.strip_prefix('[') {
            let header = header.trim_end_matches(']').trim();
            // `[includeIf "..."]` and any other subsection are kept apart.
            section = if header.contains('"') {
                String::new()
            } else {
                header.to_ascii_lowercase()
            };
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"').to_string();
        match (section.as_str(), key.as_str()) {
            ("core", "excludesfile") => {
                if let Some(path) = expand_home(&value, home) {
                    *named = Some(path);
                }
            }
            ("include", "path") => {
                let included = expand_home(&value, home).or_else(|| {
                    let relative = Path::new(&value);
                    (!value.is_empty() && relative.is_relative())
                        .then(|| file.parent().map(|dir| dir.join(relative)))
                        .flatten()
                });
                if let Some(included) = included {
                    read_excludes_setting(&included, home, depth + 1, named);
                }
            }
            _ => {}
        }
    }
}

/// One configuration file of the person's, through the confined reader: a
/// regular file of a bounded size only (a pipe answers at once, never
/// waited on). It may be a link to their dotfiles: resolved first, since the
/// jail cannot write the person's home configuration.
fn read_person_config(file: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(file).ok()?;
    let bytes = crate::confined_read::read_resolved(&resolved, 1 << 20).ok()?;
    String::from_utf8(bytes).ok()
}

/// `~/...` and absolute paths; anything else (relative, `~user`) is not
/// resolved.
fn expand_home(value: &str, home: &Path) -> Option<PathBuf> {
    if let Some(rest) = value.strip_prefix("~/") {
        return Some(home.join(rest));
    }
    let path = Path::new(value);
    path.is_absolute().then(|| path.to_path_buf())
}

/// A configuration line without its comment (`#` or `;` outside quotes).
fn strip_comment(line: &str) -> &str {
    let mut quoted = false;
    for (index, ch) in line.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '#' | ';' if !quoted => return &line[..index],
            _ => {}
        }
    }
    line
}

/// Whether a configuration key defines a program git would run that no
/// setting of the command can turn off: a filter, a diff driver's command
/// or textconv, a merge driver.
pub(crate) fn names_a_program(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let Some((section, rest)) = key.split_once('.') else {
        return false;
    };
    let Some((_, variable)) = rest.rsplit_once('.') else {
        return false;
    };
    match section {
        "filter" => true,
        "diff" => matches!(variable, "command" | "textconv"),
        "merge" => variable == "driver",
        _ => false,
    }
}

/// Lists the configuration git would read in `folder` (includes followed),
/// and refuses the folder when it defines a program (`names_a_program`) or
/// names a working tree other than the one the app found. It fails
/// closed: a configuration git cannot list (unreadable, invalid) refuses
/// the folder too, since what it would hold is unknown.
pub(crate) fn refuse_planted_programs(
    folder: &Path,
    sandbox: Option<&Sandbox>,
    timeout: std::time::Duration,
) -> Result<(), AppError> {
    let mut cmd = build(folder, sandbox, true);
    cmd.args(["config", "--list", "-z"]);
    let output = output_within(cmd, timeout)?;
    if !output.status.success() {
        eprintln!(
            "git: refused {} (its configuration could not be listed)",
            folder.display()
        );
        return Err(AppError::new(
            "git_unsafe_folder",
            "This folder's git configuration names a program git would run, or a working tree elsewhere, so Sub Rosa does not run git on it.",
        ));
    }
    let tree = places(folder).map(|found| found.tree);
    for entry in output.stdout.split(|byte| *byte == 0) {
        let mut lines = entry.splitn(2, |byte| *byte == b'\n');
        let key = String::from_utf8_lossy(lines.next().unwrap_or_default());
        let value = String::from_utf8_lossy(lines.next().unwrap_or_default());
        let elsewhere = key.eq_ignore_ascii_case("core.worktree")
            && tree
                .as_deref()
                .map_or(true, |tree| !same_folder(tree, Path::new(value.as_ref())));
        if names_a_program(&key) || elsewhere {
            eprintln!("git: refused {} ({key})", folder.display());
            return Err(AppError::new(
                "git_unsafe_folder",
                "This folder's git configuration names a program git would run, or a working tree elsewhere, so Sub Rosa does not run git on it.",
            ));
        }
    }
    Ok(())
}

/// Whether `named` (as the configuration wrote it) is the folder `tree`.
fn same_folder(tree: &Path, named: &Path) -> bool {
    std::fs::canonicalize(named).is_ok_and(|named| named == tree)
}

/// The temp folder git may write (its own, under the app's).
fn git_tmp() -> Option<PathBuf> {
    let base = std::env::temp_dir();
    let base = std::fs::canonicalize(&base).unwrap_or(base);
    let dir = base.join("sr-git");
    super::sandbox_profile::create_private_dir(&dir).ok()?;
    Some(dir)
}

/// Where git is installed: its binary and its prefix (`…/usr`), read once
/// from `/usr/bin/git --exec-path` run outside any folder. Git is run by its
/// real path, not through the `/usr/bin/git` shim, which needs far more than
/// git does.
#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
struct GitInstall {
    git: PathBuf,
    exec_path: PathBuf,
    prefix: PathBuf,
}

#[cfg(target_os = "macos")]
fn git_install() -> Option<&'static GitInstall> {
    static INSTALL: std::sync::OnceLock<Option<GitInstall>> = std::sync::OnceLock::new();
    INSTALL
        .get_or_init(|| {
            let output = Command::new("/usr/bin/git")
                .arg("--exec-path")
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .current_dir("/")
                .stdin(std::process::Stdio::null())
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let exec_path = String::from_utf8(output.stdout).ok()?;
            let exec_path = std::fs::canonicalize(exec_path.trim()).ok()?;
            let prefix = exec_path.parent()?.parent()?.to_path_buf();
            let git = prefix.join("bin/git");
            git.is_file().then_some(GitInstall {
                git,
                exec_path,
                prefix,
            })
        })
        .as_ref()
}

/// The places of a repository git reads: its working tree, and its store
/// when that lives elsewhere (a linked worktree's, under the main store's
/// `worktrees/`).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Places {
    pub(crate) tree: PathBuf,
    pub(crate) stores: Vec<PathBuf>,
}

/// Finds the repository `folder` is in, as git would, without running git;
/// `None` outside any. A `.git` file the jail wrote could point anywhere: a
/// store outside the working tree is taken only when it is a linked
/// worktree's (`<store>/worktrees/<name>`, the store holding `HEAD` and
/// `objects`).
pub(crate) fn places(folder: &Path) -> Option<Places> {
    let folder = std::fs::canonicalize(folder).ok()?;
    for dir in folder.ancestors() {
        let dot_git = dir.join(".git");
        let Ok(meta) = dot_git.symlink_metadata() else {
            continue;
        };
        if meta.is_dir() {
            return Some(Places {
                tree: dir.to_path_buf(),
                stores: Vec::new(),
            });
        }
        if meta.is_file() {
            let stores = linked_store(dir, &dot_git).unwrap_or_default();
            return Some(Places {
                tree: dir.to_path_buf(),
                stores,
            });
        }
    }
    None
}

fn linked_store(tree: &Path, dot_git: &Path) -> Option<Vec<PathBuf>> {
    let text = std::fs::read_to_string(dot_git).ok()?;
    let target = text.lines().next()?.strip_prefix("gitdir: ")?.trim();
    let gitdir = std::fs::canonicalize(tree.join(target)).ok()?;
    if gitdir.starts_with(tree) {
        return Some(Vec::new());
    }
    let worktrees = gitdir.parent()?;
    let store = worktrees.parent()?;
    let is_store = worktrees.file_name()? == "worktrees"
        && store.join("HEAD").is_file()
        && store.join("objects").is_dir();
    is_store.then(|| vec![gitdir.clone(), store.to_path_buf()])
}

/// The profile for git on `folder`.
#[cfg(target_os = "macos")]
pub(crate) fn sandbox_for(folder: &Path) -> std::io::Result<Sandbox> {
    let install = git_install().ok_or_else(|| std::io::Error::other("no git installation"))?;
    let tmp = git_tmp().ok_or_else(|| std::io::Error::other("no temp folder for git"))?;
    // Outside any repository, git reads the folder alone.
    let places = places(folder).unwrap_or_else(|| Places {
        tree: std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf()),
        stores: Vec::new(),
    });
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("no home"))?;
    Ok(Sandbox {
        git: install.git.clone(),
        profile: render_profile(install, &places, &tmp, &home),
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn sandbox_for(_folder: &Path) -> std::io::Result<Sandbox> {
    Err(std::io::Error::other("no jail on this system"))
}

/// Refuses by default; the system's base (`system.sb`: the dynamic loader,
/// the system's libraries and a few of its services, no network but the
/// system log); runs only git and its helpers; reads git's installation,
/// the repository and `tmp`; writes only `tmp`; looks up what a path is
/// anywhere (git finds its repository by its parents), never its content,
/// and not even that in the credential stores the jail cannot see.
#[cfg(target_os = "macos")]
fn render_profile(install: &GitInstall, places: &Places, tmp: &Path, home: &Path) -> String {
    use super::sandbox_profile::sbpl_quote;
    let quote = |path: &Path| sbpl_quote(&path.to_string_lossy());
    let mut out = String::new();
    out.push_str("(version 1)\n;; Git run by Sub Rosa on a folder its jail writes (ADR-0140).\n");
    out.push_str("(deny default)\n(import \"system.sb\")\n(allow process-fork)\n");
    out.push_str(&format!(
        "(allow process-exec (literal {}) (subpath {}))\n",
        quote(&install.git),
        quote(&install.exec_path)
    ));
    out.push_str("(allow file-read-metadata)\n(allow file-read*\n");
    out.push_str(&format!("  (subpath {})\n", quote(&install.prefix)));
    out.push_str(&format!("  (subpath {})\n", quote(&places.tree)));
    for store in &places.stores {
        out.push_str(&format!("  (subpath {})\n", quote(store)));
    }
    out.push_str(&format!("  (subpath {}))\n", quote(tmp)));
    // The person's excludes file, that file alone.
    if let Some(excludes) = person_excludes_file() {
        out.push_str(&format!(
            "(allow file-read* (literal {}))\n",
            quote(&excludes)
        ));
    }
    out.push_str(&format!("(allow file-write* (subpath {}))\n", quote(tmp)));
    out.push_str("(deny file-read*\n");
    super::sandbox_profile::push_secret_stores(&mut out, home);
    out.push_str(")\n");
    out
}

/// Repositories a jail could have written, for the tests of every caller.
#[cfg(test)]
#[cfg(target_os = "macos")]
pub(crate) mod planted {
    use std::io::Read as _;
    use std::path::PathBuf;
    use std::process::Command;

    /// What the jail planted, and how to tell whether it ran: each planted
    /// command is one script, outside the repository, that leaves a mark,
    /// prints a token and a secret file's content (both outside the
    /// repository), and calls a local listener.
    pub(crate) struct Planted {
        pub(crate) dir: tempfile::TempDir,
        pub(crate) repo: PathBuf,
        pub(crate) secret_path: PathBuf,
        marks: PathBuf,
        secret: String,
        listener: std::net::TcpListener,
        script: PathBuf,
        inside: PathBuf,
    }

    /// The token the planted script prints.
    pub(crate) const TOKEN: &str = "SR-PLANTED-RAN";

    impl Planted {
        /// The marks the planted script left.
        pub(crate) fn marks(&self) -> Vec<String> {
            std::fs::read_dir(&self.marks)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        }

        /// Whether `output` carries what only the planted script could
        /// print: its token or the secret it read.
        pub(crate) fn leaked(&self, output: &[u8]) -> bool {
            let text = String::from_utf8_lossy(output);
            text.contains(TOKEN) || text.contains(&self.secret)
        }

        /// Whether the planted script reached the network.
        pub(crate) fn called(&self) -> bool {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0u8; 16];
                    let _ = stream.read(&mut buffer);
                    true
                }
                Err(_) => false,
            }
        }

        /// Forgets what ran so far (setting the repository up, a control):
        /// its marks and its calls.
        pub(crate) fn forget_marks(&self) {
            for entry in std::fs::read_dir(&self.marks).unwrap().flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
            while self.listener.accept().is_ok() {}
        }

        /// Nothing ran, nothing read outside, nothing called.
        pub(crate) fn assert_untouched(&self, outputs: &[Vec<u8>]) {
            assert_eq!(self.marks(), Vec::<String>::new(), "a planted command ran");
            for output in outputs {
                assert!(
                    !self.leaked(output),
                    "a planted command ran or read outside: {}",
                    String::from_utf8_lossy(output)
                );
            }
            assert!(!self.called(), "a planted command reached the network");
        }
    }

    /// A home for the person's git configuration, for the time of a test
    /// (tests that set one take turns).
    pub(crate) struct FakeHome {
        pub(crate) dir: tempfile::TempDir,
        _turn: std::sync::MutexGuard<'static, ()>,
    }

    static ONE_HOME_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

    impl FakeHome {
        /// A home whose `.gitconfig` includes a file that names the excludes
        /// file, which holds `patterns`.
        pub(crate) fn ignoring(patterns: &str) -> FakeHome {
            let turn = ONE_HOME_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
            let dir = tempfile::tempdir_in(
                PathBuf::from(std::env::var_os("HOME").unwrap()).join("Library/Caches"),
            )
            .unwrap();
            std::fs::write(
                dir.path().join(".gitconfig"),
                "[user]\n\tname = t ; a comment\n[include]\n\tpath = more.cfg\n",
            )
            .unwrap();
            std::fs::write(
                dir.path().join("more.cfg"),
                "[core]\n\texcludesFile = \"~/ignores/global\" # where\n",
            )
            .unwrap();
            std::fs::create_dir_all(dir.path().join("ignores")).unwrap();
            std::fs::write(dir.path().join("ignores/global"), patterns).unwrap();
            *super::TEST_HOME.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(dir.path().to_path_buf());
            FakeHome { dir, _turn: turn }
        }
    }

    impl Drop for FakeHome {
        fn drop(&mut self) {
            *super::TEST_HOME.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    /// What the jail can plant.
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Plant {
        /// Settings the command's own configuration outranks: an fsmonitor,
        /// an external diff, a pager, an ssh command, and drivers named by
        /// `.gitattributes` that nothing defines.
        Neutralized,
        /// Programs defined in `.git/config` (a clean and smudge filter, a
        /// diff command, a textconv), named by `.gitattributes` only.
        ProgramsInTheTree,
        /// The same programs, named by `.git/info/attributes` too, which no
        /// setting turns off.
        Programs,
    }

    /// A repository with a committed file changed since and an untracked
    /// one, and what the jail planted.
    pub(crate) fn planted_repository(plant: Plant) -> Planted {
        let caches = PathBuf::from(std::env::var_os("HOME").unwrap()).join("Library/Caches");
        let dir = tempfile::tempdir_in(caches).unwrap();
        let repo = dir.path().join("repo");
        let marks = dir.path().join("marks");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&marks).unwrap();
        let secret = format!("secret-{}", std::process::id() ^ 0x5eed);
        let secret_path = dir.path().join("secret.txt");
        std::fs::write(&secret_path, &secret).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = dir.path().join("planted.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ntouch \"{marks}/ran-$$\"\necho {TOKEN}\ncat \"{secret}\"\n/usr/bin/curl -s -m 1 http://127.0.0.1:{port}/ >/dev/null 2>&1\nexit 0\n",
                marks = marks.display(),
                secret = secret_path.display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "one"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        // A script inside the repository too, as the jail can write one:
        // readable there, so only the profile's exec rule stops it.
        let inside = repo.join(".git/planted-inside.sh");
        std::fs::write(&inside, format!("#!/bin/sh\necho {TOKEN}\nexit 0\n")).unwrap();
        std::fs::set_permissions(&inside, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let planted = Planted {
            dir,
            repo,
            secret_path,
            marks,
            secret,
            listener,
            script,
            inside,
        };
        planted.plant(plant);
        planted
    }

    impl Planted {
        /// Plants `plant` in the repository (again, or later).
        pub(crate) fn plant(&self, plant: Plant) {
            let run = self.script.display().to_string();
            let inside = self.inside.display().to_string();
            let config = match plant {
                Plant::Neutralized => format!(
                    "\n[core]\n\tfsmonitor = \"{run}\"\n\tpager = \"{run}\"\n\tsshCommand = \"{run}\"\n[diff]\n\texternal = \"{run}\"\n"
                ),
                Plant::ProgramsInTheTree | Plant::Programs => format!(
                    "\n[core]\n\tfsmonitor = \"{run}\"\n[filter \"evil\"]\n\tclean = \"{run} clean\"\n\tsmudge = \"{run} smudge\"\n[diff]\n\texternal = \"{inside}\"\n[diff \"evil\"]\n\tcommand = \"{inside}\"\n\ttextconv = \"{run}\"\n"
                ),
            };
            let path = self.repo.join(".git/config");
            let mut existing = std::fs::read_to_string(&path).unwrap();
            existing.push_str(&config);
            std::fs::write(&path, existing).unwrap();
            std::fs::write(
                self.repo.join(".gitattributes"),
                "* filter=evil diff=evil\n",
            )
            .unwrap();
            if plant == Plant::Programs {
                std::fs::create_dir_all(self.repo.join(".git/info")).unwrap();
                std::fs::write(
                    self.repo.join(".git/info/attributes"),
                    "* filter=evil diff=evil\n",
                )
                .unwrap();
            }
        }
    }

    /// The reads the code review and the council make, each one's output.
    pub(crate) fn run_the_apps_reads(cmd: impl Fn() -> Command) -> Vec<Vec<u8>> {
        let mut outputs = Vec::new();
        for args in [
            vec!["status", "--porcelain"],
            vec!["diff", "--no-ext-diff", "--no-textconv", "HEAD"],
            vec!["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"],
            vec!["diff", "--name-only", "-z", "--relative", "HEAD", "--"],
            vec!["cat-file", "blob", "HEAD:./a.txt"],
            // And what a planted filter waits for.
            vec!["diff", "HEAD"],
            vec!["add", "-A"],
            vec!["write-tree"],
        ] {
            if let Ok(output) = cmd().args(&args).output() {
                outputs.push(output.stdout);
                outputs.push(output.stderr);
            }
        }
        outputs
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::planted::{planted_repository, run_the_apps_reads, Plant};
    use super::*;

    /// The control: plain git, as the app ran it before, executes what the
    /// jail planted, reads outside the folder and calls out.
    #[test]
    fn plain_git_runs_what_the_jail_planted() {
        let planted = planted_repository(Plant::Programs);
        let outputs = run_the_apps_reads(|| {
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(&planted.repo);
            cmd
        });
        assert!(
            !planted.marks().is_empty(),
            "the planted commands did not run"
        );
        assert!(
            outputs.iter().any(|output| planted.leaked(output)),
            "the planted commands read nothing outside"
        );
        assert!(planted.called(), "the planted commands reached no network");
    }

    /// Layer 1 alone: the command's configuration runs nothing it outranks,
    /// nor a filter `.gitattributes` alone names.
    #[test]
    fn the_neutral_configuration_runs_nothing_planted() {
        for plant in [Plant::Neutralized, Plant::ProgramsInTheTree] {
            let planted = planted_repository(plant);
            let outputs = run_the_apps_reads(|| build(&planted.repo, None, true));
            planted.assert_untouched(&outputs);
        }
    }

    /// Layer 2 alone: a configuration that defines a program refuses the
    /// folder, before any git command runs on it; one that only sets what
    /// layer 1 outranks does not.
    #[test]
    fn a_folder_whose_configuration_defines_a_program_is_refused() {
        for plant in [Plant::ProgramsInTheTree, Plant::Programs] {
            let planted = planted_repository(plant);
            let refused = refuse_planted_programs(&planted.repo, None, GIT_TIMEOUT);
            assert!(refused.is_err(), "a defined program was not refused");
            planted.assert_untouched(&[]);
        }
        let neutralized = planted_repository(Plant::Neutralized);
        assert!(refuse_planted_programs(&neutralized.repo, None, GIT_TIMEOUT).is_ok());
    }

    #[test]
    fn the_keys_that_define_a_program() {
        for key in [
            "filter.evil.clean",
            "filter.evil.smudge",
            "filter.evil.process",
            "filter.a.b.required",
            "diff.evil.command",
            "diff.evil.textconv",
            "Diff.Evil.TextConv",
            "merge.evil.driver",
        ] {
            assert!(names_a_program(key), "{key}");
        }
        for key in [
            "core.fsmonitor",
            "diff.external",
            "diff.renames",
            "diff.evil.binary",
            "merge.conflictstyle",
            "user.name",
            "filter",
        ] {
            assert!(!names_a_program(key), "{key}");
        }
    }

    /// Layer 3 alone: under the profile, with the folder's own
    /// configuration and `.git/info/attributes` naming defined programs,
    /// nothing planted runs, reads outside or calls out.
    #[test]
    fn the_profile_contains_what_runs() {
        let planted = planted_repository(Plant::Programs);
        let sandbox = sandbox_for(&planted.repo).unwrap();
        let outputs = run_the_apps_reads(|| build(&planted.repo, Some(&sandbox), false));
        planted.assert_untouched(&outputs);
        // And git ran: the test proves nothing if git stopped at once.
        let status = build(&planted.repo, Some(&sandbox), false)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&status.stdout);
        assert!(said.contains("a.txt"), "git did not run: {status:?}");
    }

    /// A program planted between the check and the command (the jail
    /// writes the folder while the app reads it) runs nothing either: the
    /// profile, not the check, holds there.
    #[test]
    fn a_program_planted_after_the_check_runs_nothing() {
        let planted = planted_repository(Plant::Neutralized);
        let reads = [
            vec!["diff", "HEAD"],
            vec!["status", "--porcelain"],
            vec!["add", "-A"],
            vec!["write-tree"],
        ];
        let planted = std::rc::Rc::new(planted);
        let mut outputs = Vec::new();
        for (index, args) in reads.iter().enumerate() {
            if index == 0 {
                // The check passes, then the jail plants the programs.
                let later = planted.clone();
                AFTER_THE_CHECK
                    .with(|hook| hook.set(Some(Box::new(move || later.plant(Plant::Programs)))));
            }
            // Later commands meet the planted programs at the check: a
            // refusal is fine, it ran nothing.
            match run(&planted.repo, args) {
                Ok(output) => {
                    outputs.push(output.stdout);
                    outputs.push(output.stderr);
                }
                Err(error) => {
                    assert_eq!(error.code, "git_unsafe_folder", "{error:?}");
                    outputs.push(Vec::new());
                    outputs.push(Vec::new());
                }
            }
        }
        planted.assert_untouched(&outputs);
        // And git ran (the diff, first, after the check): nothing is
        // proven otherwise.
        assert!(
            String::from_utf8_lossy(&outputs[0]).contains("a.txt")
                || String::from_utf8_lossy(&outputs[1]).contains("a.txt"),
            "git did not run: {}",
            String::from_utf8_lossy(&outputs[1])
        );
    }

    /// Layer 3 reads the repository and nothing beside it.
    #[test]
    fn the_profile_reads_the_repository_only() {
        let planted = planted_repository(Plant::Neutralized);
        let sandbox = sandbox_for(&planted.repo).unwrap();
        let inside = build(&planted.repo, Some(&sandbox), true)
            .args(["hash-object", "a.txt"])
            .output()
            .unwrap();
        assert!(inside.status.success(), "{inside:?}");
        let outside = build(&planted.repo, Some(&sandbox), true)
            .arg("hash-object")
            .arg(&planted.secret_path)
            .output()
            .unwrap();
        assert!(
            !outside.status.success(),
            "git read a file outside the repository"
        );
        assert!(!planted.leaked(&outside.stdout));
    }

    /// Every layer, as the code review and the council run git, and git
    /// still answers.
    #[test]
    fn git_still_reads_the_folder() {
        let planted = planted_repository(Plant::Neutralized);
        let out = run(&planted.repo, &["status", "--porcelain"]).unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(said.contains("a.txt") && said.contains("new.txt"), "{said}");
    }

    /// A linked worktree (its store elsewhere) is read too; a `.git` file
    /// pointing anywhere else gives no store.
    #[test]
    fn a_linked_worktree_is_read_and_a_stray_store_is_not() {
        let planted = planted_repository(Plant::Neutralized);
        let linked = planted.dir.path().join("linked");
        let status = Command::new("git")
            .arg("-C")
            .arg(&planted.repo)
            .args(["worktree", "add", "-q", "--detach"])
            .arg(&linked)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .status()
            .unwrap();
        assert!(status.success());
        let found = places(&linked).unwrap();
        assert_eq!(found.stores.len(), 2, "{found:?}");
        let out = run(&linked, &["log", "--oneline", "-1"]).unwrap();
        assert!(out.status.success(), "{out:?}");
        // A `.git` file that names the home folder gives no store.
        let stray = planted.dir.path().join("stray");
        std::fs::create_dir_all(&stray).unwrap();
        let home = std::env::var("HOME").unwrap();
        std::fs::write(stray.join(".git"), format!("gitdir: {home}\n")).unwrap();
        assert_eq!(places(&stray).unwrap().stores, Vec::<PathBuf>::new());
    }

    fn plain_git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A named pipe the folder's configuration includes: git would wait for
    /// ever. It is stopped at its time limit, with what it started.
    fn hanging_repository() -> super::planted::Planted {
        let planted = planted_repository(Plant::Neutralized);
        let fifo = planted.repo.join(".git/hang.cfg");
        let path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path in the test's own folder.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let config = planted.repo.join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[include]\n\tpath = hang.cfg\n");
        std::fs::write(&config, text).unwrap();
        planted
    }

    #[test]
    fn a_pipe_in_the_configuration_stops_git_at_its_limit() {
        let planted = hanging_repository();
        let started = std::time::Instant::now();
        let result = run_within(
            &planted.repo,
            &["status", "--porcelain"],
            std::time::Duration::from_secs(2),
        );
        let error = result.expect_err("git returned from a pipe");
        assert_eq!(error.code, "git_timed_out", "{error:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    /// A process git started that keeps the pipes open after git ended
    /// counts against the same deadline: past it, its group is killed and
    /// the pipes are not waited on.
    #[test]
    fn a_process_holding_the_pipes_stops_at_the_same_limit() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "/bin/sleep 6 & echo started"]);
        let started = std::time::Instant::now();
        let result = output_within(cmd, std::time::Duration::from_secs(1));
        let took = started.elapsed();
        assert_eq!(result.expect_err("returned").code, "git_timed_out");
        assert!(took < std::time::Duration::from_secs(3), "took {took:?}");
    }

    /// The check and git run off the async runtime: a task beside them
    /// keeps running while git hangs, on a runtime of one thread.
    #[tokio::test(flavor = "current_thread")]
    async fn the_check_never_blocks_the_async_runtime() {
        let planted = hanging_repository();
        let ticks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = ticks.clone();
        let ticker = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
        let result = run_async_within(
            planted.repo.clone(),
            vec!["status".to_string(), "--porcelain".to_string()],
            std::time::Duration::from_secs(2),
        )
        .await;
        ticker.abort();
        assert_eq!(result.expect_err("git returned").code, "git_timed_out");
        let ticked = ticks.load(std::sync::atomic::Ordering::Relaxed);
        assert!(ticked >= 50, "the runtime was blocked: {ticked} ticks");
    }

    /// A filter in a submodule's own configuration, which the check does
    /// not read: `status` and `diff` never go into the submodule, so layer
    /// 1 alone runs nothing (measured: only the command-line option holds,
    /// even against a `submodule.<name>.ignore = none` the folder sets).
    #[test]
    fn a_filter_in_a_submodule_runs_nothing() {
        let planted = planted_repository(Plant::Neutralized);
        let inner = planted.dir.path().join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        plain_git(&inner, &["init", "-q"]);
        plain_git(&inner, &["config", "user.email", "t@example.test"]);
        plain_git(&inner, &["config", "user.name", "t"]);
        std::fs::write(inner.join("f.txt"), "a\n").unwrap();
        plain_git(&inner, &["add", "f.txt"]);
        plain_git(&inner, &["commit", "-qm", "one"]);
        plain_git(
            &planted.repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                &inner.to_string_lossy(),
                "sub",
            ],
        );
        plain_git(&planted.repo, &["commit", "-qm", "sub"]);
        let modules = planted.repo.join(".git/modules/sub");
        let script = planted.dir.path().join("planted.sh");
        let mut config = std::fs::read_to_string(modules.join("config")).unwrap();
        config.push_str(&format!(
            "[filter \"evil\"]\n\tclean = \"{0} clean\"\n\tsmudge = \"{0} smudge\"\n",
            script.display()
        ));
        std::fs::write(modules.join("config"), config).unwrap();
        std::fs::create_dir_all(modules.join("info")).unwrap();
        std::fs::write(modules.join("info/attributes"), "* filter=evil\n").unwrap();
        // And the folder asks git to go into the submodule.
        let outer = planted.repo.join(".git/config");
        let mut text = std::fs::read_to_string(&outer).unwrap();
        text.push_str("[submodule \"sub\"]\n\tignore = none\n");
        std::fs::write(&outer, text).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(planted.repo.join("sub/f.txt"), "b\n").unwrap();
        // Setting it up with plain git ran the planted fsmonitor: only what
        // follows counts.
        planted.forget_marks();
        // The control: the same command without the option goes into the
        // submodule and runs its filter.
        let _ = build(&planted.repo, None, true)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(
            !planted.marks().is_empty(),
            "without the option, nothing ran in the submodule"
        );
        planted.forget_marks();
        let mut outputs = Vec::new();
        for args in [
            vec!["status", "--porcelain"],
            vec!["diff", "--no-ext-diff", "--no-textconv", "HEAD"],
        ] {
            let output = build(&planted.repo, None, true)
                .args(confined_args(&args))
                .output()
                .unwrap();
            outputs.push(output.stdout);
            outputs.push(output.stderr);
        }
        planted.assert_untouched(&outputs);
        assert!(
            String::from_utf8_lossy(&outputs[0]).contains("a.txt"),
            "git did not run"
        );
    }

    /// A `core.worktree` the folder names elsewhere: the check refuses the
    /// folder, and the command's `GIT_WORK_TREE` (layer 1) alone keeps git
    /// on the folder, so it tells nothing of the files elsewhere.
    #[test]
    fn a_working_tree_named_elsewhere_is_never_looked_at() {
        let dir = tempfile::tempdir_in(
            PathBuf::from(std::env::var_os("HOME").unwrap()).join("Library/Caches"),
        )
        .unwrap();
        let store = dir.path().join("secretstore");
        let folder = dir.path().join("folder");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(store.join("id_present"), "key\n").unwrap();
        plain_git(&folder, &["init", "-q"]);
        let empty = Command::new("git")
            .args(["hash-object", "-w", "--stdin"])
            .current_dir(&folder)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        let hash = String::from_utf8_lossy(&empty.stdout).trim().to_string();
        for name in ["id_present", "id_absent"] {
            plain_git(
                &folder,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("100644,{hash},{name}"),
                ],
            );
        }
        plain_git(
            &folder,
            &["config", "core.worktree", &store.to_string_lossy()],
        );
        let refused = run(&folder, &["status", "--porcelain"]).expect_err("not refused");
        assert_eq!(refused.code, "git_unsafe_folder");
        let output = build(&folder, None, true)
            .args(confined_args(&["status", "--porcelain"]))
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&output.stdout);
        assert!(said.contains("id_present"), "{said}");
        let line = |name: &str| {
            said.lines()
                .find(|line| line.ends_with(name))
                .map(|line| line[..2].to_string())
        };
        assert_eq!(
            line("id_present"),
            line("id_absent"),
            "git told one file elsewhere from the other: {said}"
        );
    }

    /// The person's excludes file is found by reading their configuration
    /// as text, an `[include]` followed, `~/` expanded.
    #[test]
    fn the_persons_excludes_file_is_found_as_text() {
        let home = super::planted::FakeHome::ignoring(".env\n");
        let found = person_excludes_file().expect("not found");
        assert_eq!(
            found,
            std::fs::canonicalize(home.dir.path().join("ignores/global")).unwrap()
        );
    }

    /// A pipe named by the person's configuration (an include) is never
    /// waited on: the default applies at once.
    #[test]
    fn a_pipe_in_the_persons_configuration_never_blocks() {
        let home = super::planted::FakeHome::ignoring(".env\n");
        let fifo = home.dir.path().join("more.cfg");
        std::fs::remove_file(&fifo).unwrap();
        let path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path in the test's own folder.
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let started = std::time::Instant::now();
        let _ = person_excludes_file();
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    /// What the person ignores everywhere (their global excludes) stays
    /// ignored by the app's git: a `.env` there is not a new file. The
    /// control: without it, the `.env` shows.
    #[test]
    fn what_the_person_ignores_everywhere_stays_ignored() {
        let planted = planted_repository(Plant::Neutralized);
        std::fs::write(planted.repo.join(".env"), "TOKEN=secret\n").unwrap();
        {
            let _home = super::planted::FakeHome::ignoring("# mine\n");
            let shown = run(&planted.repo, &["status", "--porcelain"]).unwrap();
            assert!(String::from_utf8_lossy(&shown.stdout).contains(".env"));
        }
        let _home = super::planted::FakeHome::ignoring(".env\n");
        let status = run(&planted.repo, &["status", "--porcelain"]).unwrap();
        let said = String::from_utf8_lossy(&status.stdout);
        assert!(said.contains("new.txt"), "git did not run: {status:?}");
        assert!(
            !said.contains(".env"),
            "a globally ignored .env showed: {said}"
        );
    }

    /// The check fails closed: a configuration git cannot list (invalid, or
    /// unreadable) refuses the folder.
    #[test]
    fn a_configuration_git_cannot_list_refuses_the_folder() {
        let invalid = planted_repository(Plant::Neutralized);
        let config = invalid.repo.join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[core\n\tbroken = = =\n");
        std::fs::write(&config, text).unwrap();
        let refused = run(&invalid.repo, &["status", "--porcelain"]).expect_err("not refused");
        assert_eq!(refused.code, "git_unsafe_folder");
        let unreadable = planted_repository(Plant::Neutralized);
        let included = unreadable.repo.join(".git/more.cfg");
        std::fs::write(&included, "[core]\n").unwrap();
        std::fs::set_permissions(
            &included,
            std::os::unix::fs::PermissionsExt::from_mode(0o000),
        )
        .unwrap();
        let config = unreadable.repo.join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[include]\n\tpath = more.cfg\n");
        std::fs::write(&config, text).unwrap();
        let refused = run(&unreadable.repo, &["status", "--porcelain"]);
        std::fs::set_permissions(
            &included,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        assert_eq!(refused.expect_err("not refused").code, "git_unsafe_folder");
    }

    /// The profile is an argument of each call: calls at once all run.
    #[test]
    fn calls_at_once_all_run() {
        let planted = planted_repository(Plant::Neutralized);
        let repo = planted.repo.clone();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let repo = repo.clone();
                std::thread::spawn(move || {
                    (0..6)
                        .map(|_| run(&repo, &["rev-parse", "HEAD"]).unwrap().status.success())
                        .filter(|ok| !ok)
                        .count()
                })
            })
            .collect();
        let failed: usize = threads.into_iter().map(|t| t.join().unwrap()).sum();
        assert_eq!(failed, 0, "{failed} concurrent call(s) failed");
    }
}
