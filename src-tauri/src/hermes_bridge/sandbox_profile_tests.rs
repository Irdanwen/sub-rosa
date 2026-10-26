//! The profile's text, and the profile run for real by the kernel
//! (`sandbox-exec`), so a malformed rule, a bad escape or a section in the
//! wrong order fails here rather than on someone's machine.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::hermes_bridge::SANDBOX_EXEC_PATH;

fn grants<'a>(
    home: &'a Path,
    hermes_home: &'a Path,
    runtime_dir: &'a Path,
    temp_roots: &'a [PathBuf],
    agent_cli_access: bool,
    working_dir: Option<&'a Path>,
) -> SandboxGrants<'a> {
    SandboxGrants {
        home,
        hermes_home,
        runtime_dir,
        temp_roots,
        agent_cli_access,
        working_dir,
    }
}

const HOME: &str = "/Users/test";
const HERMES_HOME: &str = "/Users/test/Library/Application Support/xyz.carpediem.subrosa/hermes";
const RUNTIME: &str =
    "/Users/test/Library/Application Support/xyz.carpediem.subrosa/hermes-runtime";

fn fixed_profile(agent_cli_access: bool, working_dir: Option<&Path>) -> String {
    let temp = [
        PathBuf::from("/private/tmp"),
        PathBuf::from("/private/var/tmp"),
    ];
    build_sandbox_profile(&grants(
        Path::new(HOME),
        Path::new(HERMES_HOME),
        Path::new(RUNTIME),
        &temp,
        agent_cli_access,
        working_dir,
    ))
}

#[test]
fn temp_roots_are_scoped_and_exclude_the_var_folders_blanket() {
    let roots = sandbox_temp_roots();
    assert!(roots.contains(&PathBuf::from("/private/tmp")));
    // The blanket /private/var/folders (parent of every app's caches) must
    // not be a write root: only this app's $TMPDIR may slip under it.
    assert!(!roots.contains(&PathBuf::from("/private/var/folders")));
    for root in &roots {
        assert!(root != &PathBuf::from("/"), "root / granted");
        let home = std::env::var_os("HOME").map(PathBuf::from);
        assert!(
            Some(root) != home.as_ref(),
            "home dir granted as a write root"
        );
    }
}

/// Every path the profile lets the jail write, in the order it appears:
/// the arguments of each `(allow file-write* ...)` form.
fn write_grants(profile: &str) -> Vec<String> {
    let mut grants = Vec::new();
    let mut inside = false;
    for line in profile.lines() {
        let line = line.trim();
        if line == "(allow file-write*" {
            inside = true;
            continue;
        }
        if inside && line == ")" {
            inside = false;
            continue;
        }
        if inside {
            grants.push(line.to_string());
        }
    }
    grants
}

/// ADR-0140, the gate on the list: every place the jail may write, spelled
/// out here by hand rather than read from the constants, so a new write
/// root fails this test until someone decides it belongs on the list.
#[test]
fn the_write_grants_are_exactly_the_declared_list() {
    let h = HERMES_HOME;
    let mut expected: Vec<String> = vec![
        "(subpath \"/private/tmp\")".into(),
        "(subpath \"/private/var/tmp\")".into(),
    ];
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
        expected.push(format!("(literal \"{device}\")"));
    }
    expected.push("(regex #\"^/dev/fd/[0-9]+$\")".into());
    expected.push("(regex #\"^/dev/ttys[0-9]+$\")".into());
    for dir in [
        "workspace",
        "sessions",
        "logs",
        "cache",
        "images",
        "image_cache",
        "audio_cache",
    ] {
        expected.push(format!("(subpath \"{h}/{dir}\")"));
    }
    for file in [
        "state.db",
        "state.db-wal",
        "state.db-shm",
        "state.db-journal",
        "verification_evidence.db",
        "verification_evidence.db-wal",
        "verification_evidence.db-shm",
        "verification_evidence.db-journal",
        "auth.lock",
    ] {
        expected.push(format!("(literal \"{h}/{file}\")"));
    }
    assert_eq!(write_grants(&fixed_profile(false, None)), expected);

    // The two opt-ins add exactly their own grants, nothing else.
    let with_folder = write_grants(&fixed_profile(
        false,
        Some(Path::new("/Users/test/Projects/a")),
    ));
    assert_eq!(with_folder.len(), expected.len() + 1);
    assert!(with_folder.contains(&"(subpath \"/Users/test/Projects/a\")".to_string()));
    let with_cli = write_grants(&fixed_profile(true, None));
    assert_eq!(
        with_cli.len(),
        expected.len() + AGENT_CLI_STATE_DIRS.len() + AGENT_CLI_STATE_FILE_PREFIXES.len()
    );
}

#[test]
fn the_home_is_closed_after_every_grant_and_reopened_for_its_state_only() {
    let profile = fixed_profile(true, Some(Path::new("/Users/test/Projects/a")));
    assert!(profile.contains("(allow default)"));
    let deny_all = profile.find("(deny file-write*)").expect("blanket deny");
    let folder = profile
        .find("(subpath \"/Users/test/Projects/a\")")
        .expect("folder grant");
    let cli = profile
        .find("(subpath \"/Users/test/.claude\")")
        .expect("cli");
    let close = profile
        .find(";; The runtime's home and installation: closed as a whole")
        .expect("home closed");
    let reopen = profile
        .find(";; ...and re-opened only where the runtime keeps its working state.")
        .expect("state reopened");
    let secret_write = profile.find(";; Secret-write denylist").expect("secrets");
    assert!(deny_all < folder && folder < close && cli < close);
    assert!(close < reopen && reopen < secret_write);
    assert!(profile[close..reopen].contains(&format!("(subpath \"{HERMES_HOME}\")")));
    assert!(profile[close..reopen].contains(&format!("(subpath \"{RUNTIME}\")")));
    // The settings the app writes appear nowhere as a grant.
    for owned in [
        "config.yaml",
        ".env",
        "SOUL.md",
        "plugins",
        "skills",
        "cron",
        "memories",
    ] {
        assert!(
            !write_grants(&profile)
                .iter()
                .any(|grant| grant.contains(&format!("{HERMES_HOME}/{owned}"))),
            "{owned} is writable"
        );
    }
    // Credential stores stay unreadable even though reads are otherwise open.
    assert!(profile.contains("(deny file-read*"));
    assert!(profile.contains("(subpath \"/Users/test/.ssh\")"));
    assert!(profile.contains("(subpath \"/Users/test/Library/Keychains\")"));
}

#[test]
fn without_the_opt_in_no_agent_cli_state_is_writable() {
    let profile = fixed_profile(false, None);
    for name in [".claude", ".codex", ".gemini", "opencode"] {
        assert!(!profile.contains(name), "{name} appears");
    }
    let with_cli = fixed_profile(true, None);
    assert!(with_cli.contains("(subpath \"/Users/test/.claude\")"));
    assert!(with_cli.contains("(subpath \"/Users/test/.config/opencode\")"));
    assert!(with_cli.contains("(regex #\"^/Users/test/\\.claude\\.json.*$\")"));
}

#[test]
fn sbpl_regex_escape_neutralizes_metacharacters() {
    assert_eq!(
        sbpl_regex_escape("/Users/test/.claude.json"),
        "/Users/test/\\.claude\\.json"
    );
    assert_eq!(sbpl_regex_escape("a+b(c)[d]"), "a\\+b\\(c\\)\\[d\\]");
}

#[test]
fn sbpl_quote_escapes_quotes_and_backslashes() {
    assert_eq!(sbpl_quote("/plain/path"), "\"/plain/path\"");
    assert_eq!(sbpl_quote("/with space/x"), "\"/with space/x\"");
    assert_eq!(sbpl_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
}

/// A home, an installation and a person's folders laid out in a temp dir,
/// with the app's real profile over them. The temp dir sits under `$TMPDIR`,
/// which is itself a write root: the strongest case for the ordering.
pub(super) struct KernelJail {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub hermes_home: PathBuf,
    pub runtime_dir: PathBuf,
    pub profile_path: PathBuf,
}

impl KernelJail {
    pub fn new(agent_cli_access: bool, working_dir: Option<&str>) -> Option<KernelJail> {
        if !Path::new(SANDBOX_EXEC_PATH).exists() {
            eprintln!("sandbox-exec is not available; skipped");
            return None;
        }
        let dir = tempfile::tempdir().ok()?;
        let root = std::fs::canonicalize(dir.path()).ok()?;
        let hermes_home = root.join("hermes");
        let runtime_dir = root.join("hermes-runtime");
        std::fs::create_dir_all(runtime_dir.join("hermes-agent/venv/bin")).ok()?;
        std::fs::create_dir_all(&hermes_home).ok()?;
        crate::hermes_bridge::home_prep::create_skeleton(&hermes_home).ok()?;
        let working = working_dir.map(|relative| root.join(relative));
        if let Some(working) = &working {
            std::fs::create_dir_all(working).ok()?;
        }
        let temp = sandbox_temp_roots();
        let profile = build_sandbox_profile(&SandboxGrants {
            home: &root,
            hermes_home: &hermes_home,
            runtime_dir: &runtime_dir,
            temp_roots: &temp,
            agent_cli_access,
            working_dir: working.as_deref(),
        });
        let profile_path = root.join("profile.sb");
        std::fs::write(&profile_path, profile).ok()?;
        Some(KernelJail {
            _dir: dir,
            root,
            hermes_home,
            runtime_dir,
            profile_path,
        })
    }

    /// Runs `script` with `/bin/sh` under the profile.
    pub fn sh(&self, script: &str) -> std::process::Output {
        Command::new(SANDBOX_EXEC_PATH)
            .arg("-f")
            .arg(&self.profile_path)
            .arg("/bin/sh")
            .arg("-c")
            .arg(script)
            .output()
            .expect("run sandbox-exec")
    }

    /// Whether the jail can create or overwrite `path` (its parent folder is
    /// made outside the jail first, so only the file write itself is tried).
    pub fn can_write(&self, path: &Path) -> bool {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        let before = std::fs::read(path).ok();
        let out = self.sh(&format!("printf planted > {}", shell_quote(path)));
        let after = std::fs::read(path).ok();
        out.status.success() || (after.is_some() && after != before)
    }
}

pub(super) fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// The vectors two audits measured (ADR-0140): each is a file a process
/// outside the jail reads with authority, or the runtime itself reads to
/// decide what needs a person's approval. Relative to the runtime's home.
pub(super) const VECTORS: &[&str] = &[
    "config.yaml",
    ".config_planted.tmp",
    ".env",
    ".env_planted.tmp",
    ".op.env",
    "active_profile",
    "profiles/planted/config.yaml",
    "profiles/planted/.env",
    "cron/jobs.json",
    "cron/.jobs_planted.tmp",
    "scripts/planted.sh",
    "hooks/planted/HOOK.yaml",
    "hooks/planted/handler.py",
    "bin/tirith",
    "bin/uvx",
    "plugins/planted/__init__.py",
    "plugins/subrosa_guard/__init__.py",
    "mcp-installs/planted/run.sh",
    "skills/planted/SKILL.md",
    "memories/MEMORY.md",
    "memories/USER.md",
    "SOUL.md",
    "subrosa-guard.json",
    "auth.json",
    "kanban.db",
    "projects.db",
    "pairing/planted.json",
    "platforms/pairing/planted.json",
    "lsp/bin/planted",
    "node/bin/node",
    "shell-hooks-allowlist.json",
    "pending/skills/planted.json",
    "planted-at-the-top",
];

#[test]
fn the_kernel_refuses_every_vector_and_allows_the_runtime_state() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let mut written = Vec::new();
    for vector in VECTORS {
        if jail.can_write(&jail.hermes_home.join(vector)) {
            written.push(*vector);
        }
    }
    // The runtime's installation, source and interpreter alike.
    for installed in ["hermes-agent/run_agent.py", "hermes-agent/venv/bin/python3"] {
        if jail.can_write(&jail.runtime_dir.join(installed)) {
            written.push(installed);
        }
    }
    assert!(written.is_empty(), "the jail wrote {written:?}");

    // Replacing a file it cannot write, by rename or by unlink, is refused too.
    let config = jail.hermes_home.join("config.yaml");
    std::fs::write(&config, "approvals:\n  mode: manual\n").unwrap();
    let swap = jail.sh(&format!(
        "printf 'approvals:\\n  mode: off\\n' > {tmp} && mv {tmp} {config}",
        tmp = shell_quote(&jail.hermes_home.join("workspace/c.yaml")),
        config = shell_quote(&config),
    ));
    assert!(!swap.status.success());
    let unlink = jail.sh(&format!("rm -f {}", shell_quote(&config)));
    assert!(!unlink.status.success() || config.exists());
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        "approvals:\n  mode: manual\n"
    );

    // What the runtime needs to live stays writable.
    for dir in RUNTIME_STATE_DIRS {
        let path = jail.hermes_home.join(dir).join("nested/file.txt");
        let out = jail.sh(&format!(
            "mkdir -p {} && printf ok > {}",
            shell_quote(path.parent().unwrap()),
            shell_quote(&path)
        ));
        assert!(out.status.success(), "{dir} refused");
    }
    for file in RUNTIME_STATE_FILES {
        assert!(
            jail.can_write(&jail.hermes_home.join(file)),
            "{file} refused"
        );
    }
    // Outside every grant (the temp dir itself is one, so probe the home).
    if let Some(home) = std::env::var_os("HOME") {
        let probe = PathBuf::from(home)
            .join("Library/Caches")
            .join(format!(".subrosa-jail-probe-{}", std::process::id()));
        let wrote = jail.can_write(&probe);
        let _ = std::fs::remove_file(&probe);
        assert!(!wrote, "a write outside every grant succeeded");
    }
}

#[test]
fn a_working_folder_spanning_the_home_does_not_reopen_it() {
    // Validation refuses such a folder; the profile must hold on its own.
    let Some(jail) = KernelJail::new(true, Some(".")) else {
        return;
    };
    let project = jail.root.join("Projects/demo app/notes.md");
    assert!(jail.can_write(&project), "the working folder is writable");
    for vector in ["config.yaml", ".env", "cron/jobs.json", "hooks/x/HOOK.yaml"] {
        assert!(
            !jail.can_write(&jail.hermes_home.join(vector)),
            "{vector} written through the working folder"
        );
    }
    assert!(!jail.can_write(&jail.runtime_dir.join("hermes-agent/x.py")));
    // A credential store stays unwritable inside the granted folder.
    assert!(!jail.can_write(&jail.root.join(".ssh/id_new")));
    // The CLI opt-in grant holds, atomic temp names included.
    let out = jail.sh(&format!(
        "mkdir -p {dir} && printf s > {state} && printf c > {tmp} && mv {tmp} {cfg}",
        dir = shell_quote(&jail.root.join(".claude")),
        state = shell_quote(&jail.root.join(".claude/session.json")),
        tmp = shell_quote(&jail.root.join(".claude.json.1a2b")),
        cfg = shell_quote(&jail.root.join(".claude.json")),
    ));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn credential_stores_stay_unreadable() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let secret = jail.root.join(".ssh/id_secret");
    std::fs::create_dir_all(secret.parent().unwrap()).unwrap();
    std::fs::write(&secret, "TOPSECRET").unwrap();
    let out = jail.sh(&format!("cat {}", shell_quote(&secret)));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("TOPSECRET"));
}
