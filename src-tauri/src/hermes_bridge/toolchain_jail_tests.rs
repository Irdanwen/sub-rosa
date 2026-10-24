//! The jail, run for real against the toolchains (ADR-0125).
//!
//! Each test renders the app's real Seatbelt profile (`build_sandbox_profile`
//! over `sandbox_write_roots`, with a granted working folder) and runs the
//! real toolchain environment (`code::toolchain::runtime_env`) under it. Free:
//! no model, no download beyond what the preinstall asks npm for in the
//! ignored latency harness.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::code::toolchain;

struct Jail {
    data: tempfile::TempDir,
    home: PathBuf,
    hermes_home: PathBuf,
    runtime_dir: PathBuf,
    work: PathBuf,
    profile: PathBuf,
    env: Vec<(&'static str, OsString)>,
}

impl Jail {
    /// `None` where the jail cannot engage (no `sandbox-exec`, no `HOME`).
    fn new(runtime_dir: Option<PathBuf>) -> Option<Jail> {
        if !Path::new(super::SANDBOX_EXEC_PATH).exists() {
            eprintln!("sandbox-exec is not available; skipped");
            return None;
        }
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let data = tempfile::tempdir().ok()?;
        let root = data.path().canonicalize().ok()?;
        let hermes_home = root.join("hermes");
        let runtime_dir = runtime_dir.unwrap_or_else(|| root.join("hermes-runtime"));
        let work = root.join("work");
        for dir in [&hermes_home, &runtime_dir, &work] {
            std::fs::create_dir_all(dir).ok()?;
        }
        let profile = root.join("hermes-sandbox.sb");
        std::fs::write(
            &profile,
            profile_for(&home, &hermes_home, &runtime_dir, &work),
        )
        .ok()?;
        let env = toolchain::runtime_env(&hermes_home, Some(&work));
        Some(Jail {
            data,
            home,
            hermes_home,
            runtime_dir,
            work,
            profile,
            env,
        })
    }

    fn path(&self) -> OsString {
        self.env
            .iter()
            .find(|(key, _)| *key == "PATH")
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    }

    /// `program args` under the profile, with the runtime's environment.
    fn command(&self, program: &Path, args: &[&str], cwd: &Path) -> Command {
        let mut cmd = Command::new(super::SANDBOX_EXEC_PATH);
        cmd.arg("-f").arg(&self.profile).arg(program).args(args);
        crate::child_env::scrub(&mut cmd);
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
        // A compiler cache of the developer's would write outside the jail;
        // a run inherits none from the app.
        cmd.env_remove("RUSTC_WRAPPER")
            .env_remove("RUSTC_WORKSPACE_WRAPPER")
            .env("HERMES_HOME", &self.hermes_home)
            .current_dir(cwd)
            .stdin(Stdio::null());
        cmd
    }
}

fn profile_for(home: &Path, hermes_home: &Path, runtime_dir: &Path, work: &Path) -> String {
    super::build_sandbox_profile(
        home,
        &super::sandbox_write_roots(hermes_home, runtime_dir),
        &super::sandbox_config_write_path(hermes_home),
        &super::sandbox_config_temp_prefix(hermes_home),
        false,
        Some(work),
    )
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A run builds and tests a crate with the person's toolchain, its build in
/// the runtime's home, and cannot write `~/.cargo/bin`, not even when its
/// working folder spans `~/.cargo`.
#[test]
fn a_run_builds_and_tests_a_crate_in_the_jail_but_never_writes_the_toolchain() {
    let Some(jail) = Jail::new(None) else {
        return;
    };
    let Some(cargo) = toolchain::which_in("cargo", &jail.path()) else {
        eprintln!("cargo is not on the runtime PATH; skipped");
        return;
    };
    let toy = jail.work.join("toy");
    write(
        &toy.join("Cargo.toml"),
        "[package]\nname = \"toy\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n",
    );
    write(
        &toy.join("src/lib.rs"),
        "pub fn add(a: u32, b: u32) -> u32 { a + b }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(super::add(2, 2), 4); }\n}\n",
    );
    let output = jail
        .command(&cargo, &["test", "--offline", "-q"], &toy)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "cargo test failed in the jail: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    let target = toolchain::cargo_target_dir(&jail.hermes_home, Some(&jail.work));
    assert!(target.join("debug").is_dir(), "the build lands in the home");
    assert!(!toy.join("target").exists(), "and not in the project");

    let cargo_bin = jail.home.join(".cargo").join("bin");
    if !cargo_bin.is_dir() {
        eprintln!("no ~/.cargo/bin on this machine; the write check is skipped");
        return;
    }
    let probe = cargo_bin.join(format!(".subrosa-jail-probe-{}", std::process::id()));
    let try_write = |profile: &Path| -> bool {
        let _ = std::fs::remove_file(&probe);
        let status = Command::new(super::SANDBOX_EXEC_PATH)
            .arg("-f")
            .arg(profile)
            .arg("/bin/sh")
            .arg("-c")
            .arg(format!("echo x > '{}'", probe.display()))
            .stderr(Stdio::null())
            .status()
            .unwrap();
        let wrote = status.success() || probe.exists();
        let _ = std::fs::remove_file(&probe);
        wrote
    };
    assert!(!try_write(&jail.profile), "a run wrote ~/.cargo/bin");
    // Even a working folder that spans the Cargo home leaves its bin read-only.
    let cargo_home = jail.home.join(".cargo").canonicalize().unwrap();
    let spanning = jail.data.path().join("spanning.sb");
    std::fs::write(
        &spanning,
        profile_for(
            &jail.home,
            &jail.hermes_home,
            &jail.runtime_dir,
            &cargo_home,
        ),
    )
    .unwrap();
    assert!(
        !try_write(&spanning),
        "a grant of ~/.cargo opened ~/.cargo/bin"
    );
}

/// The TypeScript the project ships, checked by `npx tsc --noEmit` in the
/// jail: npm's cache is the runtime's, so npx starts, and the check is real
/// (an error makes it fail).
#[test]
fn a_run_type_checks_a_typescript_project_with_npx_in_the_jail() {
    let Some(jail) = Jail::new(None) else {
        return;
    };
    let Some(npx) = toolchain::which_in("npx", &jail.path()) else {
        eprintln!("npx is not on the runtime PATH; skipped");
        return;
    };
    let typescript = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/typescript")
        .canonicalize();
    let Ok(typescript) = typescript else {
        eprintln!("no node_modules/typescript in the repository (pnpm install); skipped");
        return;
    };
    let web = jail.work.join("web");
    write(
        &web.join("package.json"),
        "{\"name\": \"web\", \"private\": true}\n",
    );
    write(
        &web.join("tsconfig.json"),
        "{\"compilerOptions\": {\"strict\": true, \"noEmit\": true}, \"include\": [\"src\"]}\n",
    );
    write(&web.join("src/index.ts"), "export const n: number = 1;\n");
    std::fs::create_dir_all(web.join("node_modules/.bin")).unwrap();
    std::os::unix::fs::symlink(&typescript, web.join("node_modules/typescript")).unwrap();
    std::os::unix::fs::symlink("../typescript/bin/tsc", web.join("node_modules/.bin/tsc")).unwrap();
    let check = || {
        jail.command(&npx, &["--no-install", "tsc", "--noEmit", "-p", "."], &web)
            .output()
            .unwrap()
    };
    let clean = check();
    assert!(
        clean.status.success(),
        "npx tsc failed in the jail: {}{}",
        String::from_utf8_lossy(&clean.stdout),
        String::from_utf8_lossy(&clean.stderr)
    );
    write(
        &web.join("src/index.ts"),
        "export const n: number = \"one\";\n",
    );
    let broken = check();
    assert!(!broken.status.success(), "the type error went unseen");
    assert!(String::from_utf8_lossy(&broken.stdout).contains("TS2322"));
    assert!(
        jail.hermes_home.join("cache").join("npm").is_dir(),
        "npm used the runtime's cache"
    );
}

/// The P1 gate's measurement (docs/hermes-code-surface.md, measurements):
/// the real profile, environment, `lsp:` key and preinstall, then
/// `scripts/code-eval/lsp_latency.py` inside the jail with the installed
/// runtime's Python. See that script for the options.
#[test]
#[ignore = "measures for a few minutes; needs the installed runtime and npm"]
fn lsp_latency_under_the_jail() {
    let runtime = std::env::var_os("SUBROSA_HERMES_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap())
                .join("Library/Application Support/xyz.carpediem.subrosa-dev/hermes-runtime")
        });
    let python = runtime.join("hermes-agent/venv/bin/python3");
    assert!(python.exists(), "no runtime at {}", runtime.display());
    let Some(jail) = Jail::new(Some(runtime.canonicalize().unwrap())) else {
        return;
    };
    let mut setup = toolchain::prepare_lsp(&jail.hermes_home);
    if let Some(binary) = std::env::var_os("SUBROSA_LSP_RUST_ANALYZER") {
        setup.rust_analyzer = Some(PathBuf::from(binary));
    }
    std::fs::write(
        jail.hermes_home.join("config.yaml"),
        toolchain::render_lsp_config(&setup),
    )
    .unwrap();
    let langs = std::env::var("SUBROSA_LSP_LANGS").unwrap_or_else(|_| "ts7,ts,py,rs".into());
    let languages = toolchain::Languages {
        typescript: langs.contains("ts"),
        python: langs.contains("py"),
        rust: langs.contains("rs"),
        go: false,
    };
    let path = jail.path();
    let steps = toolchain::preinstall_plan(
        languages,
        &jail.hermes_home,
        &path,
        setup.rust_analyzer.as_deref(),
    );
    let mut env = jail.env.clone();
    env.push(("HERMES_HOME", jail.hermes_home.clone().into_os_string()));
    let started = std::time::Instant::now();
    let codes = toolchain::run_steps(
        &jail.hermes_home,
        &steps,
        &env,
        Some((Path::new(super::SANDBOX_EXEC_PATH), &jail.profile)),
        "lsp latency bench",
    );
    eprintln!(
        "preinstall under the jail: {:?} in {:.1} s",
        codes,
        started.elapsed().as_secs_f64()
    );
    assert!(
        codes.iter().all(|code| *code == Some(0)),
        "preinstall failed"
    );

    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/code-eval/lsp_latency.py");
    let typescript7 = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/typescript")
        .canonicalize()
        .unwrap();
    let out = jail.data.path().join("lsp-latency.json");
    let iterations = std::env::var("SUBROSA_LSP_ITERATIONS").unwrap_or_else(|_| "20".into());
    let status = jail
        .command(
            &python,
            &[
                script.to_str().unwrap(),
                "--work",
                jail.work.to_str().unwrap(),
                "--iterations",
                &iterations,
                "--langs",
                &langs,
                "--typescript7",
                typescript7.to_str().unwrap(),
                "--out",
                out.to_str().unwrap(),
            ],
            &jail.work,
        )
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stderr(Stdio::inherit())
        .stdout(Stdio::inherit())
        .status()
        .unwrap();
    assert!(status.success(), "the probe failed");
    let summary = std::fs::read_to_string(&out).unwrap();
    eprintln!("{summary}");
    if let Some(copy) = std::env::var_os("SUBROSA_LSP_OUT") {
        std::fs::write(copy, &summary).unwrap();
    }
    if std::env::var_os("SUBROSA_LSP_KEEP").is_some() {
        let kept = jail.data.keep();
        eprintln!("kept {}", kept.display());
    }
}
