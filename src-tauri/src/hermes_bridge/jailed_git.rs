//! Every `git` the app runs on a folder the jail can write (ADR-0140, final
//! pass).
//!
//! The code review and the council read a session's working folder with
//! git, outside the jail, while a sandboxed session writes that folder,
//! `.git` included. Git obeys what it finds there: `core.fsmonitor` in
//! `.git/config` is a command run by `git status`, and so are a diff driver,
//! a textconv, a clean or smudge filter named by `.gitattributes`, a hook, an
//! ssh command. Measured: the jail wrote `[core] fsmonitor = <cmd>`, and a
//! `git status` the app ran executed it outside the jail.
//!
//! Two layers, each enough on its own for what was measured:
//!
//! 1. The command's own configuration, which outranks the repository's:
//!    no system or global file, `core.fsmonitor=false`, hooks pointed at
//!    `/dev/null`, no external diff, no ssh command, no protocol, no
//!    attributes file; the in-tree attributes read from the empty tree
//!    (`GIT_ATTR_SOURCE`, git 2.42 and later), so `.gitattributes` names no
//!    filter or driver; optional locks off, a plain locale.
//! 2. On macOS, git itself runs under a read-only Seatbelt profile: it reads
//!    what the person can read (credential stores excepted), writes nowhere
//!    but a temp folder of the app's, reaches no network and only the
//!    system services the jail has. Whatever git still runs (a filter named
//!    by `.git/info/attributes`, which no setting turns off; an older git
//!    that ignores `GIT_ATTR_SOURCE`) runs there.
//!
//! The callers also ask for no external diff and no textconv, and read a
//! file's past content with `cat-file blob`, never through filters.

use std::path::{Path, PathBuf};
use std::process::Command;

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
    ("core.pager", "cat"),
    ("core.untrackedCache", "false"),
];

/// A `git` command on `folder`, with both layers. Fails closed: where the
/// jail engages and the read-only profile cannot be written, no git runs.
pub(crate) fn command(folder: &Path) -> Result<Command, AppError> {
    let profile = if super::sandbox_profile::jail_engages() {
        Some(read_only_profile().map_err(|error| {
            AppError::new(
                "git_unavailable",
                format!("Git cannot be run safely here: {error}"),
            )
        })?)
    } else {
        None
    };
    Ok(build(folder, profile.as_deref(), true))
}

/// The same, for async callers.
pub(crate) fn tokio_command(folder: &Path) -> Result<tokio::process::Command, AppError> {
    command(folder).map(tokio::process::Command::from)
}

/// Builds the command: under `profile` when given, with the neutral
/// configuration when `neutral` (both, outside tests).
pub(crate) fn build(folder: &Path, profile: Option<&Path>, neutral: bool) -> Command {
    let mut cmd = match profile {
        Some(profile) => {
            let mut cmd = Command::new(super::SANDBOX_EXEC_PATH);
            cmd.arg("-f").arg(profile).arg("git");
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
    cmd.env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat");
    if let Some(tmp) = git_tmp() {
        cmd.env("TMPDIR", tmp);
    }
    if neutral {
        cmd.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_SOURCE", EMPTY_TREE)
            .env("GIT_CONFIG_COUNT", NEUTRAL_CONFIG.len().to_string());
        for (index, (key, value)) in NEUTRAL_CONFIG.iter().enumerate() {
            cmd.env(format!("GIT_CONFIG_KEY_{index}"), key)
                .env(format!("GIT_CONFIG_VALUE_{index}"), value);
        }
    }
    cmd
}

/// The temp folder git may write (its own, under the app's).
fn git_tmp() -> Option<PathBuf> {
    let base = std::env::temp_dir();
    let base = std::fs::canonicalize(&base).unwrap_or(base);
    let dir = base.join("sr-git");
    super::sandbox_profile::create_private_dir(&dir).ok()?;
    Some(dir)
}

/// Writes the read-only profile beside git's temp folder and returns its
/// path.
#[cfg(target_os = "macos")]
pub(crate) fn read_only_profile() -> std::io::Result<PathBuf> {
    let tmp = git_tmp().ok_or_else(|| std::io::Error::other("no temp folder for git"))?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("no home"))?;
    // Beside git's temp folder, not in it: what git runs may write there.
    let path = tmp.with_file_name("sr-git.sb");
    std::fs::write(&path, render_profile(&home, &tmp))?;
    Ok(path)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_only_profile() -> std::io::Result<PathBuf> {
    Err(std::io::Error::other("no jail on this system"))
}

/// Read what the person can read but credential stores; write nowhere but
/// `tmp` and the devices; no network; the jail's system services only; no
/// launchd client, no signal outside.
#[cfg(target_os = "macos")]
pub(crate) fn render_profile(home: &Path, tmp: &Path) -> String {
    use super::sandbox_profile::{push_secret_stores, sbpl_quote, ALLOWED_MACH_SERVICES};
    let mut out = String::new();
    out.push_str("(version 1)\n;; Git run by Sub Rosa on a folder its jail writes (ADR-0140).\n");
    out.push_str("(allow default)\n(deny file-write*)\n(allow file-write*\n");
    out.push_str(&format!(
        "  (subpath {})\n",
        sbpl_quote(&tmp.to_string_lossy())
    ));
    for device in [
        "/dev/null",
        "/dev/zero",
        "/dev/tty",
        "/dev/stdout",
        "/dev/stderr",
    ] {
        out.push_str(&format!("  (literal {})\n", sbpl_quote(device)));
    }
    out.push_str("  (regex #\"^/dev/fd/[0-9]+$\")\n)\n");
    out.push_str("(deny network*)\n");
    out.push_str("(deny mach-lookup)\n(allow mach-lookup\n");
    for name in ALLOWED_MACH_SERVICES {
        out.push_str(&format!("  (global-name {})\n", sbpl_quote(name)));
    }
    out.push_str(")\n(deny user-preference-write)\n");
    out.push_str("(deny process-exec (literal \"/bin/launchctl\"))\n");
    out.push_str("(deny signal (target others))\n(allow signal (target same-sandbox))\n");
    out.push_str("(deny file-read*\n");
    push_secret_stores(&mut out, home);
    out.push_str(")\n(deny file-write*\n");
    push_secret_stores(&mut out, home);
    out.push_str(")\n");
    out
}

/// A repository a jail could have written, for the tests of every caller.
#[cfg(test)]
#[cfg(target_os = "macos")]
pub(crate) mod planted {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// A repository a jail could have written: a committed file changed
    /// since, an fsmonitor command in `.git/config`, a clean filter named by
    /// `.gitattributes`, an external diff and a textconv. Each command would
    /// leave a mark in `marks` if git ran it.
    pub(crate) fn planted_repository() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let caches = PathBuf::from(std::env::var_os("HOME").unwrap()).join("Library/Caches");
        let dir = tempfile::tempdir_in(caches).unwrap();
        let repo = dir.path().join("repo");
        let marks = dir.path().join("marks");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&marks).unwrap();
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
        // What the jail plants.
        let mark = |name: &str| format!("touch {}", marks.join(name).display());
        let config = format!(
            "\n[core]\n\tfsmonitor = \"{}\"\n[filter \"evil\"]\n\tclean = \"{}\"\n\tsmudge = \"{}\"\n[diff]\n\texternal = \"{}\"\n[diff \"evil\"]\n\ttextconv = \"{}\"\n",
            mark("fsmonitor"),
            mark("clean"),
            mark("smudge"),
            mark("external"),
            mark("textconv"),
        );
        let path = repo.join(".git/config");
        let mut existing = std::fs::read_to_string(&path).unwrap();
        existing.push_str(&config);
        std::fs::write(&path, existing).unwrap();
        std::fs::write(repo.join(".gitattributes"), "* filter=evil diff=evil\n").unwrap();
        (dir, repo, marks)
    }

    pub(crate) fn marks_in(marks: &Path) -> Vec<String> {
        std::fs::read_dir(marks)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::planted::{marks_in, planted_repository};
    use super::*;

    fn run_the_apps_reads(cmd: impl Fn() -> Command) {
        for args in [
            vec!["status", "--porcelain"],
            vec!["diff", "--no-ext-diff", "--no-textconv", "HEAD"],
            vec!["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"],
            vec!["diff", "--name-only", "-z", "--relative", "HEAD", "--"],
            vec!["cat-file", "blob", "HEAD:./a.txt"],
        ] {
            let _ = cmd().args(&args).output();
        }
    }

    /// The control: plain git, as the app ran it before, executes what the
    /// jail planted.
    #[test]
    fn plain_git_runs_what_the_jail_planted() {
        let (_dir, repo, marks) = planted_repository();
        run_the_apps_reads(|| {
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(&repo);
            cmd
        });
        assert!(
            !marks_in(&marks).is_empty(),
            "the planted commands did not run"
        );
    }

    /// Layer 1 alone: the command's configuration runs nothing planted.
    #[test]
    fn the_neutral_configuration_runs_nothing_planted() {
        let (_dir, repo, marks) = planted_repository();
        run_the_apps_reads(|| build(&repo, None, true));
        assert_eq!(marks_in(&marks), Vec::<String>::new());
    }

    /// Layer 2 alone: under the read-only profile, a planted command that
    /// runs cannot write.
    #[test]
    fn the_read_only_profile_contains_what_runs() {
        let (_dir, repo, marks) = planted_repository();
        let profile = read_only_profile().unwrap();
        run_the_apps_reads(|| build(&repo, Some(&profile), false));
        assert_eq!(marks_in(&marks), Vec::<String>::new());
    }

    /// Both layers, as the code review and the council run git, and git
    /// still answers.
    #[test]
    fn git_still_reads_the_folder() {
        let (_dir, repo, _marks) = planted_repository();
        let out = command(&repo)
            .unwrap()
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(said.contains("a.txt") && said.contains("new.txt"), "{said}");
    }
}
