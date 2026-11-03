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

/// A `git` command on `folder`, with every layer. Fails closed: where the
/// jail engages and git cannot be confined, or where the folder's
/// configuration defines a program git would run, no git runs.
pub(crate) fn command(folder: &Path) -> Result<Command, AppError> {
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
    refuse_planted_programs(folder, sandbox.as_ref())?;
    Ok(build(folder, sandbox.as_ref(), true))
}

/// The same, for async callers.
pub(crate) fn tokio_command(folder: &Path) -> Result<tokio::process::Command, AppError> {
    command(folder).map(tokio::process::Command::from)
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
/// and refuses the folder when it defines a program (`names_a_program`).
/// A folder git cannot read the configuration of is left to the command
/// itself, which fails the same way.
pub(crate) fn refuse_planted_programs(
    folder: &Path,
    sandbox: Option<&Sandbox>,
) -> Result<(), AppError> {
    let output = build(folder, sandbox, true)
        .args(["config", "--list", "-z"])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| AppError::new("git_unavailable", error.to_string()))?;
    if !output.status.success() {
        return Ok(());
    }
    for entry in output.stdout.split(|byte| *byte == 0) {
        let key = entry
            .split(|byte| *byte == b'\n')
            .next()
            .unwrap_or_default();
        let key = String::from_utf8_lossy(key);
        if names_a_program(&key) {
            return Err(AppError::new(
                "git_unsafe_folder",
                format!(
                    "This folder's git configuration defines a program git would run ({key}); Sub Rosa does not run git on it."
                ),
            ));
        }
    }
    Ok(())
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
#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Places {
    pub(crate) tree: PathBuf,
    pub(crate) stores: Vec<PathBuf>,
}

/// Finds the repository `folder` is in, as git would, without running git.
/// A `.git` file the jail wrote could point anywhere: a store outside the
/// working tree is taken only when it is a linked worktree's
/// (`<store>/worktrees/<name>`, the store holding `HEAD` and `objects`).
#[cfg(target_os = "macos")]
pub(crate) fn places(folder: &Path) -> Places {
    let folder = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
    for dir in folder.ancestors() {
        let dot_git = dir.join(".git");
        let Ok(meta) = dot_git.symlink_metadata() else {
            continue;
        };
        if meta.is_dir() {
            return Places {
                tree: dir.to_path_buf(),
                stores: Vec::new(),
            };
        }
        if meta.is_file() {
            let stores = linked_store(dir, &dot_git).unwrap_or_default();
            return Places {
                tree: dir.to_path_buf(),
                stores,
            };
        }
    }
    Places {
        tree: folder,
        stores: Vec::new(),
    }
}

#[cfg(target_os = "macos")]
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
    let places = places(folder);
    Ok(Sandbox {
        git: install.git.clone(),
        profile: render_profile(install, &places, &tmp),
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
/// anywhere (git finds its repository by its parents), never its content.
#[cfg(target_os = "macos")]
fn render_profile(install: &GitInstall, places: &Places, tmp: &Path) -> String {
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
    out.push_str(&format!("(allow file-write* (subpath {}))\n", quote(tmp)));
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
            let refused = refuse_planted_programs(&planted.repo, None);
            assert!(refused.is_err(), "a defined program was not refused");
            planted.assert_untouched(&[]);
        }
        let neutralized = planted_repository(Plant::Neutralized);
        assert!(refuse_planted_programs(&neutralized.repo, None).is_ok());
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
        let commands: Vec<Command> = reads
            .iter()
            .map(|args| {
                let mut cmd = command(&planted.repo).unwrap();
                cmd.args(args);
                cmd
            })
            .collect();
        planted.plant(Plant::Programs);
        let mut outputs = Vec::new();
        for mut cmd in commands {
            let output = cmd.output().unwrap();
            outputs.push(output.stdout);
            outputs.push(output.stderr);
        }
        planted.assert_untouched(&outputs);
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
        let out = command(&planted.repo)
            .unwrap()
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
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
        let found = places(&linked);
        assert_eq!(found.stores.len(), 2, "{found:?}");
        let out = command(&linked)
            .unwrap()
            .args(["log", "--oneline", "-1"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        // A `.git` file that names the home folder gives no store.
        let stray = planted.dir.path().join("stray");
        std::fs::create_dir_all(&stray).unwrap();
        let home = std::env::var("HOME").unwrap();
        std::fs::write(stray.join(".git"), format!("gitdir: {home}\n")).unwrap();
        assert_eq!(places(&stray).stores, Vec::<PathBuf>::new());
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
                        .map(|_| {
                            command(&repo)
                                .unwrap()
                                .args(["rev-parse", "HEAD"])
                                .output()
                                .unwrap()
                                .status
                                .success()
                        })
                        .filter(|ok| !ok)
                        .count()
                })
            })
            .collect();
        let failed: usize = threads.into_iter().map(|t| t.join().unwrap()).sum();
        assert_eq!(failed, 0, "{failed} concurrent call(s) failed");
    }
}
