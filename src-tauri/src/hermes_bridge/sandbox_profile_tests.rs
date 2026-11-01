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
    closed_homes: &'a [PathBuf],
    temp_roots: &'a [PathBuf],
    agent_cli_access: bool,
    working_dir: Option<&'a Path>,
) -> SandboxGrants<'a> {
    SandboxGrants {
        home,
        hermes_home,
        runtime_dir,
        closed_homes,
        temp_roots,
        agent_cli_access,
        working_dir,
        result_dir: None,
        jail_tmp: None,
    }
}

const HOME: &str = "/Users/test";
const HERMES_HOME: &str =
    "/Users/test/Library/Application Support/xyz.carpediem.subrosa/hermes-sandboxed";
const SHARED_HOME: &str = "/Users/test/Library/Application Support/xyz.carpediem.subrosa/hermes";
const RUNTIME: &str =
    "/Users/test/Library/Application Support/xyz.carpediem.subrosa/hermes-runtime";

fn fixed_profile(agent_cli_access: bool, working_dir: Option<&Path>) -> String {
    let temp = [
        PathBuf::from("/private/tmp"),
        PathBuf::from("/private/var/tmp"),
    ];
    let closed = [PathBuf::from(SHARED_HOME)];
    build_sandbox_profile(&grants(
        Path::new(HOME),
        Path::new(HERMES_HOME),
        Path::new(RUNTIME),
        &closed,
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
        "mcp-tokens",
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
    // ADR-0140 (a): nothing of the shared home, the unrestricted runtime's
    // and the gateway's, is ever a grant, and it is closed as a whole.
    let profile = fixed_profile(true, Some(Path::new("/Users/test/Projects/a")));
    for grant in write_grants(&profile) {
        assert!(
            !grant.contains(&format!("{SHARED_HOME}/"))
                && !grant.contains(&format!("{SHARED_HOME}\"")),
            "the shared home is writable: {grant}"
        );
    }
    assert!(profile.contains(&format!("(subpath \"{SHARED_HOME}\")")));

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
    /// The shared home of the unrestricted runtime and the gateway.
    pub shared_home: PathBuf,
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
        let hermes_home = root.join("hermes-sandboxed");
        let shared_home = root.join("hermes");
        std::fs::create_dir_all(&shared_home).ok()?;
        let runtime_dir = root.join("hermes-runtime");
        std::fs::create_dir_all(runtime_dir.join("hermes-agent/venv/bin")).ok()?;
        std::fs::create_dir_all(&hermes_home).ok()?;
        crate::hermes_bridge::home_prep::create_skeleton(&hermes_home).ok()?;
        let working = working_dir.map(|relative| root.join(relative));
        if let Some(working) = &working {
            std::fs::create_dir_all(working).ok()?;
        }
        let temp = sandbox_temp_roots();
        let jail_tmp = root.join("jail-tmp");
        std::fs::create_dir_all(&jail_tmp).ok()?;
        let profile = build_sandbox_profile(&SandboxGrants {
            home: &root,
            hermes_home: &hermes_home,
            runtime_dir: &runtime_dir,
            closed_homes: std::slice::from_ref(&shared_home),
            temp_roots: &temp,
            agent_cli_access,
            working_dir: working.as_deref(),
            result_dir: None,
            jail_tmp: Some(&jail_tmp),
        });
        let profile_path = root.join("profile.sb");
        std::fs::write(&profile_path, profile).ok()?;
        Some(KernelJail {
            _dir: dir,
            root,
            hermes_home,
            shared_home,
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
    // No link where processes outside the jail open by name (ADR-0140):
    // neither symbolic nor hard, nor a symbolic one renamed into `uploads`;
    // the workspace keeps its links.
    let target = jail.root.join("outside-target");
    std::fs::write(&target, "keep").unwrap();
    for at in [
        "logs/gateway.log",
        "sessions/sessions.json",
        "cache/x",
        "images/x.png",
        "workspace/uploads/report.pdf.txt",
        "state.db",
    ] {
        let path = jail.hermes_home.join(at);
        let symbolic = jail.sh(&format!(
            "ln -s {} {}",
            shell_quote(&target),
            shell_quote(&path)
        ));
        assert!(!symbolic.status.success(), "a symbolic link at {at}");
        let inner = jail.hermes_home.join("logs/agent.log");
        std::fs::write(&inner, "log").unwrap();
        let hard = jail.sh(&format!(
            "ln {} {}",
            shell_quote(&inner),
            shell_quote(&path)
        ));
        assert!(!hard.status.success(), "a hard link at {at}");
    }
    let workspace_link = jail.sh(&format!(
        "ln -s {} {}",
        shell_quote(&target),
        shell_quote(&jail.hermes_home.join("workspace/project-link"))
    ));
    assert!(
        workspace_link.status.success(),
        "the workspace keeps its links"
    );
    let renamed = jail.sh(&format!(
        "mv {} {} && mv {} {}",
        shell_quote(&jail.hermes_home.join("workspace/uploads")),
        shell_quote(&jail.hermes_home.join("workspace/uploads-old")),
        shell_quote(&jail.hermes_home.join("workspace/project-link")),
        shell_quote(&jail.hermes_home.join("workspace/uploads")),
    ));
    assert!(!renamed.status.success(), "a link renamed into uploads");
    assert!(!jail
        .hermes_home
        .join("workspace/uploads")
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink()));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");

    // No pipe or socket either where others open by name.
    let fifo = jail.sh(&format!(
        "mkfifo {}",
        shell_quote(&jail.hermes_home.join("logs/gateway.err"))
    ));
    assert!(!fifo.status.success(), "a pipe in logs/");
    // A re-opened folder's own name stays a folder: removable (it is the
    // jail's), never replaced by a link out of the home.
    let swapped = jail.sh(&format!(
        "rm -rf {ws} && ln -s {root} {ws}",
        ws = shell_quote(&jail.hermes_home.join("sessions")),
        root = shell_quote(&jail.root),
    ));
    assert!(!swapped.status.success(), "sessions/ replaced by a link");
    assert!(!jail
        .hermes_home
        .join("sessions")
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink()));

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

/// The auditor's rename-parent: with a working folder spanning the home's
/// parent, carrying the parent off, rewriting the home elsewhere and
/// bringing it back is refused (each ancestor is closed), as is replacing
/// the workspace with a link to the person's home.
#[test]
fn the_way_to_the_home_cannot_be_moved_or_replaced() {
    let Some(jail) = KernelJail::new(false, Some(".")) else {
        return;
    };
    let config = jail.hermes_home.join("config.yaml");
    std::fs::write(&config, "approvals:\n  mode: manual\n").unwrap();
    // The working folder is the parent of the home here (validation would
    // refuse it; the kernel must hold anyway).
    let moved = jail.root.join("moved");
    let out = jail.sh(&format!(
        "mv {home} {moved} && printf 'approvals:\\n  mode: off\\n' > {moved}/config.yaml && mv {moved} {home}",
        home = shell_quote(&jail.hermes_home),
        moved = shell_quote(&moved),
    ));
    assert!(!out.status.success(), "the home was moved");
    let out = jail.sh(&format!(
        "mv {root} {root}.old",
        root = shell_quote(&jail.root)
    ));
    assert!(!out.status.success(), "an ancestor of the home was moved");
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        "approvals:\n  mode: manual\n"
    );
    // Writing inside an ancestor stays as granted.
    assert!(jail.can_write(&jail.root.join("Projects/notes.md")));
    // The workspace may be emptied, never turned into a link.
    let ws = jail.hermes_home.join("workspace");
    let out = jail.sh(&format!(
        "rm -rf {ws} && ln -s {home} {ws}",
        ws = shell_quote(&ws),
        home = shell_quote(&jail.root),
    ));
    assert!(!out.status.success(), "the workspace became a link");
    assert!(!ws
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink()));
}

/// ADR-0140 (a), for real: nothing of the shared home can be written, not
/// its sessions, its logs (which the gateway's service opens by name), its
/// workspace, nor its settings.
#[test]
fn the_shared_home_is_closed_to_the_jail_as_a_whole() {
    let Some(jail) = KernelJail::new(false, Some(".")) else {
        return;
    };
    for relative in [
        "state.db",
        "state.db-wal",
        "sessions/sessions.json",
        "logs/gateway.log",
        "workspace/x",
        "cache/x",
        "config.yaml",
        "cron/jobs.json",
        "new-file",
    ] {
        assert!(
            !jail.can_write(&jail.shared_home.join(relative)),
            "the shared home's {relative} was written"
        );
    }
    let moved = jail.sh(&format!(
        "mv {home} {home}.old",
        home = shell_quote(&jail.shared_home)
    ));
    assert!(!moved.status.success(), "the shared home was moved");
}

/// ADR-0140 (b): the auditor's carrier, a folder of the jail's own that
/// holds links and a pipe, cannot take the place of a re-opened folder,
/// whether by removing it first or by renaming over it.
#[test]
fn a_carrier_folder_cannot_take_a_reopened_folders_place() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let carrier = std::env::temp_dir().join(format!("subrosa-carrier-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&carrier);
    std::fs::create_dir_all(&carrier).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", carrier.join("gateway.log")).unwrap();
    let logs = jail.hermes_home.join("logs");
    let out = jail.sh(&format!("rm -rf {logs}", logs = shell_quote(&logs)));
    assert!(!out.status.success() || logs.is_dir(), "logs/ was removed");
    let out = jail.sh(&format!(
        "mv {carrier} {logs}",
        carrier = shell_quote(&carrier),
        logs = shell_quote(&logs)
    ));
    let replaced = logs
        .join("gateway.log")
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink());
    assert!(
        !replaced,
        "the carrier took logs/'s place ({})",
        String::from_utf8_lossy(&out.stderr)
    );
    let _ = std::fs::remove_dir_all(&carrier);
}

/// ADR-0140 (c): no signal leaves the jail (the gateway, the app, the
/// unrestricted runtime), while the runtime still stops its own children,
/// in their own process groups too.
#[test]
fn the_jail_cannot_signal_a_process_outside_it() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let mut outside = Command::new("/bin/sleep");
    outside.arg("60");
    std::os::unix::process::CommandExt::process_group(&mut outside, 0);
    let mut outside = outside.spawn().unwrap();
    let out = jail.sh(&format!("kill -TERM {}", outside.id()));
    std::thread::sleep(std::time::Duration::from_millis(200));
    let alive = outside.try_wait().unwrap().is_none();
    let _ = outside.kill();
    let _ = outside.wait();
    assert!(
        !out.status.success() && alive,
        "the jail stopped a process outside it"
    );
    let own = jail.sh(
        "python3 -c 'import os,signal,subprocess,time; p=subprocess.Popen([\"sleep\",\"30\"],start_new_session=True); time.sleep(0.2); os.killpg(p.pid, signal.SIGTERM); print(p.wait())'",
    );
    assert!(
        own.status.success(),
        "{}",
        String::from_utf8_lossy(&own.stderr)
    );
}

/// Asks launchd for each service by name from inside the jail: 0 is
/// found, 1100 is refused by the sandbox, 1102 is unknown on this system.
const LOOKUP_PROBE: &str = "import ctypes,sys\nlibc=ctypes.CDLL(None)\nbp=ctypes.c_uint.in_dll(libc,'bootstrap_port')\nf=libc.bootstrap_look_up\nf.argtypes=[ctypes.c_uint,ctypes.c_char_p,ctypes.POINTER(ctypes.c_uint)]\nfor n in sys.argv[1:]:\n    p=ctypes.c_uint(0)\n    print(n, f(bp.value,n.encode(),ctypes.byref(p)))\n";

/// One real service behind each refused name (ADR-0140, C1).
const SERVICES_THAT_START_PROGRAMS: &[&str] = &[
    "com.apple.coreservices.appleevents",
    "com.apple.coreservices.launchservicesd",
    "com.apple.lsd.open",
    "com.apple.lsd.openurl",
    "com.apple.lsd.modifydb",
    "com.apple.siriactionsd.xpc",
    "com.apple.WorkflowKit.ShortcutsViewService",
    "com.apple.linkd.autoShortcut",
    "com.apple.private.alloy.shortcuts-idswake",
    "com.apple.backgroundtaskmanagementagent",
    "com.apple.xpc.smd",
    "com.apple.dock.server",
    "com.apple.pbs.fetch_services",
    "com.apple.finder.ServiceProvider",
    // ADR-0140 (D2): the screen, synthesized events, privacy answers, the
    // pasteboard.
    "com.apple.windowserver.active",
    "com.apple.tccd",
    "com.apple.pasteboard.1",
];

fn look_up(jail: Option<&KernelJail>, names: &[&str]) -> Vec<(String, i64)> {
    let mut command = match jail {
        Some(jail) => {
            let mut command = Command::new(SANDBOX_EXEC_PATH);
            command
                .arg("-f")
                .arg(&jail.profile_path)
                .arg("/usr/bin/python3");
            command
        }
        None => Command::new("/usr/bin/python3"),
    };
    let out = command
        .arg("-I")
        .arg("-c")
        .arg(LOOKUP_PROBE)
        .args(names)
        .output()
        .expect("run the lookup probe");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (name, code) = line.rsplit_once(' ')?;
            Some((name.to_string(), code.parse().ok()?))
        })
        .collect()
}

/// ADR-0140 (C1): every service that would start or drive a program outside
/// the jail is refused to it, while the services a runtime needs answer.
#[test]
fn no_service_that_starts_a_program_outside_answers_the_jail() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let outside = look_up(None, SERVICES_THAT_START_PROGRAMS);
    let inside = look_up(Some(&jail), SERVICES_THAT_START_PROGRAMS);
    let mut checked = 0;
    for (name, code) in &outside {
        if *code != 0 {
            continue; // not on this system
        }
        let jailed = inside.iter().find(|(n, _)| n == name).map(|(_, c)| *c);
        assert_eq!(jailed, Some(1100), "{name} answers the jail");
        checked += 1;
    }
    assert!(checked >= 10, "only {checked} services exist to check");
    // Every service of the allowlist still answers.
    let needed = look_up(Some(&jail), ALLOWED_MACH_SERVICES);
    assert_eq!(needed.len(), ALLOWED_MACH_SERVICES.len());
    for (name, code) in needed {
        assert_eq!(code, 0, "{name} is refused to the jail");
    }
}

/// ADR-0140 (D2): whatever the app was granted (Accessibility, posting
/// events, recording the screen), every privacy check answers no in the
/// jail, and the window server cannot be reached.
#[test]
fn the_jail_holds_none_of_the_apps_privacy_grants() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let probe = "import ctypes\nA = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')\nG = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')\nfor lib, name in ((A, 'AXIsProcessTrusted'), (G, 'CGPreflightPostEventAccess'), (G, 'CGPreflightScreenCaptureAccess'), (G, 'CGPreflightListenEventAccess')):\n    f = getattr(lib, name)\n    f.restype = ctypes.c_bool\n    print(name, f())\nG.CGMainDisplayID.restype = ctypes.c_uint32\nprint('display', G.CGMainDisplayID())\n";
    let out = Command::new(SANDBOX_EXEC_PATH)
        .arg("-f")
        .arg(&jail.profile_path)
        .args(["/usr/bin/python3", "-I", "-c", probe])
        .output()
        .expect("run the privacy probe");
    let said = String::from_utf8_lossy(&out.stdout);
    for name in [
        "AXIsProcessTrusted",
        "CGPreflightPostEventAccess",
        "CGPreflightScreenCaptureAccess",
        "CGPreflightListenEventAccess",
    ] {
        assert!(said.contains(&format!("{name} False")), "{said}");
    }
    assert!(said.contains("display 0"), "{said}");
}

/// ADR-0140 (C1): `open` of an application from the jail starts nothing.
/// The application would write into the shared home, closed to the jail.
#[test]
fn opening_an_application_from_the_jail_starts_nothing() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let marker = jail.shared_home.join("opened-from-the-jail");
    let app = jail.root.join("Probe.app/Contents");
    std::fs::create_dir_all(app.join("MacOS")).unwrap();
    std::fs::write(
        app.join("Info.plist"),
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>xyz.subrosa.jail-open-probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n",
    )
    .unwrap();
    let exe = app.join("MacOS/probe");
    std::fs::write(&exe, format!("#!/bin/sh\ntouch {}\n", shell_quote(&marker))).unwrap();
    std::fs::set_permissions(&exe, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let out = jail.sh(&format!(
        "/usr/bin/open -g -n {}; /usr/bin/open https://example.invalid/",
        shell_quote(&jail.root.join("Probe.app"))
    ));
    std::thread::sleep(std::time::Duration::from_secs(3));
    assert!(!marker.exists(), "an application started outside the jail");
    assert!(!out.status.success(), "open succeeded from the jail");
}

/// ADR-0140 (C1): launchd takes no job and no environment from the jail,
/// and no preference is written for a program that starts later.
#[test]
fn launchd_and_preferences_take_nothing_from_the_jail() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let marker = jail.shared_home.join("launched-from-the-jail");
    let label = format!("xyz.subrosa.jail-probe-{}", std::process::id());
    let plist = jail.root.join(format!("{label}.plist"));
    std::fs::write(
        &plist,
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>\n",
            marker.display()
        ),
    )
    .unwrap();
    let uid = String::from_utf8_lossy(
        &Command::new("/usr/bin/id")
            .arg("-u")
            .output()
            .unwrap()
            .stdout,
    )
    .trim()
    .to_string();
    let bootstrap = jail.sh(&format!(
        "/bin/launchctl bootstrap gui/{uid} {}",
        shell_quote(&plist)
    ));
    let submit = jail.sh(&format!(
        "/bin/launchctl submit -l {label}-submit -- /usr/bin/touch {}",
        shell_quote(&marker)
    ));
    let setenv = jail.sh("/bin/launchctl setenv SUBROSA_JAIL_PROBE 1");
    let defaults = jail.sh(&format!(
        "/usr/bin/defaults write {label} planted -string yes"
    ));
    std::thread::sleep(std::time::Duration::from_secs(2));
    let planted_pref = Command::new("/usr/bin/defaults")
        .args(["read", &label, "planted"])
        .output()
        .unwrap();
    let env = Command::new("/bin/launchctl")
        .args(["getenv", "SUBROSA_JAIL_PROBE"])
        .output()
        .unwrap();
    for job in [label.clone(), format!("{label}-submit")] {
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &format!("gui/{uid}/{job}")])
            .output();
        let _ = Command::new("/bin/launchctl")
            .args(["remove", &job])
            .output();
    }
    let _ = Command::new("/bin/launchctl")
        .args(["unsetenv", "SUBROSA_JAIL_PROBE"])
        .output();
    let _ = Command::new("/usr/bin/defaults")
        .args(["delete", &label])
        .output();
    assert!(
        !bootstrap.status.success(),
        "launchd took a job from the jail"
    );
    assert!(!submit.status.success(), "launchd took a submitted job");
    assert!(
        !setenv.status.success(),
        "launchd took an environment variable"
    );
    assert!(env.stdout.iter().all(u8::is_ascii_whitespace));
    assert!(!defaults.status.success(), "a preference was written");
    assert!(!planted_pref.status.success(), "a preference was written");
    assert!(!marker.exists(), "a job ran outside the jail");
}

/// ADR-0140 (M1): the runtime starts in a session of its own, so nothing
/// in the jail can join the app's process group (from where its signals
/// would no longer count as going to "others") and signal the app.
#[test]
fn the_jail_cannot_join_the_apps_process_group() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let app = std::process::id();
    let mut cmd = Command::new(SANDBOX_EXEC_PATH);
    cmd.arg("-f")
        .arg(&jail.profile_path)
        .arg("/usr/bin/python3")
        .arg("-I")
        .arg("-c")
        .arg(format!(
            "import os\ntry:\n    os.setpgid(0, os.getpgid({app}))\n    print('joined')\nexcept OSError as e:\n    print('refused', e.errno)\n"
        ));
    super::own_session(&mut cmd);
    let out = cmd.output().expect("run the probe");
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(said.starts_with("refused"), "{said}");
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

/// ADR-0140 (D4): a sandboxed session is told it can open nothing on the
/// person's screen, and to give the link or the path instead.
#[test]
fn a_sandboxed_session_is_told_to_give_the_link() {
    let hint = crate::hermes_bridge::environment_hint_for_spawn(false, true, None).unwrap();
    assert!(hint.contains("You cannot open links"), "{hint}");
    assert!(hint.contains("give the user the link"), "{hint}");
    let soul = crate::hermes_bridge::JUNE_SOUL_SANDBOX_MD;
    assert!(soul.contains("opening a link, a file or an application"));
    assert!(soul.contains("give them the link or the path"));
    let unrestricted = crate::hermes_bridge::environment_hint_for_spawn(true, true, None).unwrap();
    assert!(!unrestricted.contains("You cannot open links"));
}

/// ADR-0140 (D5): the one-off reader answers into a folder of the app's
/// data that the runtime's jail cannot write, but the reader's can. Laid out
/// outside the temp folders, as the app's data is.
#[test]
fn the_runtime_cannot_write_the_readers_answers() {
    if !Path::new(SANDBOX_EXEC_PATH).exists() {
        return;
    }
    let caches = PathBuf::from(std::env::var_os("HOME").unwrap()).join("Library/Caches");
    let dir = tempfile::tempdir_in(caches).unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let home = root.join("hermes-sandboxed");
    let shared = root.join("hermes");
    let runtime = root.join("hermes-runtime");
    for folder in [&home, &shared, &runtime] {
        std::fs::create_dir_all(folder).unwrap();
    }
    let results = super::reader_result_dir(&home);
    assert_eq!(results.parent(), Some(root.as_path()));
    super::create_private_dir(&results).unwrap();
    let temp = sandbox_temp_roots();
    let write = |result_dir: Option<&Path>| {
        let profile = root.join("p.sb");
        std::fs::write(
            &profile,
            build_sandbox_profile(&SandboxGrants {
                home: &root,
                hermes_home: &home,
                runtime_dir: &runtime,
                closed_homes: std::slice::from_ref(&shared),
                temp_roots: &temp,
                agent_cli_access: false,
                working_dir: None,
                result_dir,
                jail_tmp: None,
            }),
        )
        .unwrap();
        let target = results.join("admin-result-x.json");
        let _ = std::fs::remove_file(&target);
        let _ = Command::new(SANDBOX_EXEC_PATH)
            .arg("-f")
            .arg(&profile)
            .args([
                "/bin/sh",
                "-c",
                &format!("printf x > {}", shell_quote(&target)),
            ])
            .output();
        target.exists()
    };
    assert!(!write(None), "the runtime's jail wrote the reader's answer");
    assert!(write(Some(&results)), "the reader cannot write its answer");
}

/// ADR-0140 (D2): what a runtime needs from the system still works under the
/// allowlist: users and groups, name resolution, subprocesses.
#[test]
fn a_runtime_still_resolves_users_and_names_in_the_jail() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let out = Command::new(SANDBOX_EXEC_PATH)
        .arg("-f")
        .arg(&jail.profile_path)
        .args([
            "/usr/bin/python3",
            "-I",
            "-c",
            "import grp, os, pwd, socket, subprocess\npwd.getpwuid(os.getuid())\ngrp.getgrgid(os.getgid())\nsocket.getaddrinfo('localhost', 80)\nsubprocess.run(['/bin/echo', 'ok'], check=True)\nprint('LIVES')\n",
        ])
        .output()
        .expect("run python in the jail");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("LIVES"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// ADR-0140 (M1): from the jail, no agent's or engine's unix socket answers
/// (the ssh agent behind launchd's listeners, gpg, a container engine, a
/// terminal multiplexer in the shared temp folder), while the jail's own
/// sockets and name resolution still work.
#[test]
fn the_jail_reaches_no_agent_or_engine_socket() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let mut refused = vec![
        jail.root.join(".gnupg/S.gpg-agent"),
        jail.root.join(".colima/default/docker.sock"),
        jail.root.join("tmux-501/default"),
    ];
    let own = jail.root.join("jail-tmp/own.sock");
    let mut listeners = Vec::new();
    for path in refused.iter().chain(std::iter::once(&own)) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        listeners.push(std::os::unix::net::UnixListener::bind(path).unwrap());
    }
    // The person's real ssh agent, when there is one.
    if let Some(agent) = std::env::var_os("SSH_AUTH_SOCK").map(PathBuf::from) {
        if agent.exists() {
            refused.push(std::fs::canonicalize(&agent).unwrap_or(agent));
        }
    }
    let probe = "import socket, sys\nfor p in sys.argv[1:]:\n    s = socket.socket(socket.AF_UNIX)\n    try:\n        s.connect(p)\n        print('CONNECTED', p)\n    except OSError as e:\n        print('refused', p)\n    s.close()\nsocket.getaddrinfo('localhost', 80)\nprint('NAMES')\n";
    let out = Command::new(SANDBOX_EXEC_PATH)
        .arg("-f")
        .arg(&jail.profile_path)
        .args(["/usr/bin/python3", "-I", "-c", probe])
        .args(&refused)
        .arg(&own)
        .output()
        .expect("run the socket probe");
    let said = String::from_utf8_lossy(&out.stdout);
    for path in &refused {
        assert!(
            said.contains(&format!("refused {}", path.display())),
            "{} answered the jail:\n{said}",
            path.display()
        );
    }
    assert!(
        said.contains(&format!("CONNECTED {}", own.display())),
        "{said}"
    );
    assert!(said.contains("NAMES"), "{said}");
    // A working folder spanning them does not reopen the agents' or the
    // engines' sockets.
    let spanning = KernelJail::new(false, Some(".")).unwrap();
    let mut listeners2 = Vec::new();
    let inside = [
        spanning.root.join(".gnupg/S.gpg-agent"),
        spanning.root.join(".colima/default/docker.sock"),
    ];
    for path in &inside {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        listeners2.push(std::os::unix::net::UnixListener::bind(path).unwrap());
    }
    let out = Command::new(SANDBOX_EXEC_PATH)
        .arg("-f")
        .arg(&spanning.profile_path)
        .args(["/usr/bin/python3", "-I", "-c", probe])
        .args(&inside)
        .output()
        .expect("run the socket probe");
    let said = String::from_utf8_lossy(&out.stdout);
    for path in &inside {
        assert!(
            said.contains(&format!("refused {}", path.display())),
            "{} answered through the working folder:\n{said}",
            path.display()
        );
    }
    drop(listeners);
    drop(listeners2);
}

/// ADR-0140 (M1): a jailed process inherits no way to the person's agents,
/// and gets its own temp folder.
#[test]
fn a_jailed_process_inherits_no_agent_socket() {
    let mut cmd = Command::new("/usr/bin/true");
    cmd.env("SSH_AUTH_SOCK", "/private/var/run/x/Listeners")
        .env("DOCKER_HOST", "unix:///x");
    super::apply_jail_env(&mut cmd, Some(Path::new("/data/jail-tmp")));
    let envs: Vec<_> = cmd.get_envs().collect();
    for name in super::INHERITED_SOCKET_VARS {
        assert!(
            envs.iter()
                .any(|(key, value)| key == name && value.is_none()),
            "{name} is passed down"
        );
    }
    assert!(envs
        .iter()
        .any(|(key, value)| *key == "TMPDIR"
            && *value == Some(std::ffi::OsStr::new("/data/jail-tmp"))));
}

/// ADR-0140 (M2): the launchd client cannot run in the jail.
#[test]
fn the_launchd_client_cannot_run_in_the_jail() {
    let Some(jail) = KernelJail::new(false, None) else {
        return;
    };
    let out = jail.sh("/bin/launchctl version");
    assert!(!out.status.success(), "launchctl ran in the jail");
}
