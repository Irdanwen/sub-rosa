//! The gateway service a Hermes home owns, and leaving the name it once shared.
//!
//! Hermes names its gateway service after `HERMES_HOME`, but the pinned
//! release counted any home outside `~/.hermes` as a default root, so every
//! Sub Rosa build and a standalone Hermes all used the bare names
//! (`ai.hermes.gateway` for launchd, `Hermes_Gateway` for the Windows task)
//! and took the gateway over from one another (docs/qa/parity-1.89.1.md). The
//! runtime the app bundles now names the service after its own home
//! (`scripts/patch-hermes-service-label.sh`), `ai.hermes.gateway-<8 hex>`.
//!
//! An install from before keeps its bare-named service until something
//! removes it, and both would then serve the same home. So before it starts
//! the gateway, an app whose runtime carries the patch removes the bare-named
//! service, and only one whose definition names this very home: a service
//! naming another home belongs to someone else and is left alone.

use std::path::Path;

/// The marker the patch writes into `hermes_cli/gateway.py`.
const PATCH_MARKER: &str = "patch-hermes-service-label";

/// Whether the runtime behind `command` names its gateway service after its
/// home. The executable sits a few levels under the agent's source: the
/// bundle's `bin/hermes` beside `hermes-agent/`, a venv's `bin/hermes` or
/// `Scripts\hermes.exe` inside it. Any other runtime (a standalone Hermes on
/// the PATH) does not carry the patch.
pub(super) fn names_service_per_home(command: &Path) -> bool {
    command.ancestors().skip(1).take(5).any(|dir| {
        [
            dir.join("hermes_cli"),
            dir.join("hermes-agent").join("hermes_cli"),
        ]
        .iter()
        .any(|cli| {
            std::fs::read_to_string(cli.join("gateway.py"))
                .is_ok_and(|source| source.contains(PATCH_MARKER))
        })
    })
}

/// How a service definition writes a path: escaped as XML text.
fn xml_text(path: &str) -> String {
    path.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Whether a launchd plist runs Hermes for `home`: its `HERMES_HOME` is that
/// home.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn plist_serves(plist: &str, home: &Path) -> bool {
    let Some((_, after)) = plist.split_once("<key>HERMES_HOME</key>") else {
        return false;
    };
    let value = format!("<string>{}</string>", xml_text(&home.to_string_lossy()));
    after.trim_start().starts_with(&value)
}

/// Whether a Windows task or Startup launcher runs Hermes for `home`: Hermes
/// keeps its launchers in `<home>\gateway-service\`, and the definitions name
/// them, raw or as XML. Windows paths compare without case.
#[cfg_attr(not(windows), allow(dead_code))]
fn launcher_serves(definition: &str, home: &Path) -> bool {
    let folder = home
        .join("gateway-service")
        .to_string_lossy()
        .to_lowercase();
    let definition = definition.to_lowercase();
    [folder.clone(), xml_text(&folder)]
        .iter()
        .any(|folder| definition.contains(&format!("{folder}{}", std::path::MAIN_SEPARATOR)))
}

/// Removes the bare-named service when it runs Hermes for `home`. Returns
/// what it removed, for the log.
#[cfg(target_os = "macos")]
// Called outside tests only: a test must not change the machine's services.
#[cfg_attr(test, allow(dead_code))]
pub(super) fn retire_shared_service(home: &Path) -> Option<String> {
    let agents = Path::new(&std::env::var_os("HOME")?).join("Library/LaunchAgents");
    // SAFETY: getuid has no preconditions and cannot fail.
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    retire_launchd_job(&agents, "ai.hermes.gateway", home, &domain)
}

#[cfg(target_os = "macos")]
fn retire_launchd_job(agents: &Path, label: &str, home: &Path, domain: &str) -> Option<String> {
    use std::process::{Command, Stdio};
    let plist = agents.join(format!("{label}.plist"));
    if !plist_serves(&std::fs::read_to_string(&plist).ok()?, home) {
        return None;
    }
    // bootout stops the job and unloads it, and fails harmlessly when it is
    // not loaded. The file goes too, or the next login would load it again.
    let _ = Command::new("/bin/launchctl")
        .args(["bootout", &format!("{domain}/{label}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    std::fs::remove_file(&plist).ok()?;
    Some(format!(
        "removed the launchd job {label}, now named after its home"
    ))
}

/// Removes the bare-named task and Startup launchers when they run Hermes for
/// `home`. Only a home that holds the bare-named launcher ever registered
/// them, so any other launch costs one file check.
#[cfg(windows)]
// Called outside tests only: a test must not change the machine's services.
#[cfg_attr(test, allow(dead_code))]
pub(super) fn retire_shared_service(home: &Path) -> Option<String> {
    const NAME: &str = "Hermes_Gateway";
    let scripts = home.join("gateway-service");
    let launchers = ["cmd", "vbs"].map(|extension| scripts.join(format!("{NAME}.{extension}")));
    if !launchers.iter().any(|launcher| launcher.exists()) {
        return None;
    }
    let mut removed = Vec::new();
    if retire_task(NAME, home) {
        removed.push(format!("the scheduled task {NAME}"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let startup = Path::new(&appdata).join(r"Microsoft\Windows\Start Menu\Programs\Startup");
        for extension in ["vbs", "cmd"] {
            let entry = startup.join(format!("{NAME}.{extension}"));
            let serves = std::fs::read(&entry)
                .is_ok_and(|bytes| launcher_serves(&String::from_utf8_lossy(&bytes), home));
            if serves && std::fs::remove_file(&entry).is_ok() {
                removed.push(format!("the Startup entry {NAME}.{extension}"));
            }
        }
    }
    // The running gateway keeps serving this home until logoff: Hermes
    // refuses a second gateway for the same home, so nothing runs twice.
    for launcher in launchers {
        let _ = std::fs::remove_file(launcher);
    }
    Some(if removed.is_empty() {
        format!("removed this home's {NAME} launchers")
    } else {
        format!(
            "removed {}, now named after its home",
            removed.join(" and ")
        )
    })
}

/// Deletes the scheduled task `name` when its definition runs Hermes for
/// `home`. The definition is exported through PowerShell into a UTF-8 file:
/// `schtasks /XML` writes the console's code page, which mangles a home
/// whose path is not ASCII.
#[cfg(windows)]
fn retire_task(name: &str, home: &Path) -> bool {
    use std::process::{Command, Stdio};
    let export = std::env::temp_dir().join(format!("subrosa-task-{}.xml", std::process::id()));
    let mut query = Command::new("powershell.exe");
    query
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        .arg(
            "$ErrorActionPreference = 'Stop'; \
             $xml = Export-ScheduledTask -TaskName $env:SUBROSA_TASK; \
             [IO.File]::WriteAllText($env:SUBROSA_TASK_EXPORT, $xml, (New-Object Text.UTF8Encoding $false))",
        )
        .env("SUBROSA_TASK", name)
        .env("SUBROSA_TASK_EXPORT", &export)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::win_console::hide_console(&mut query);
    let exported = query.status().is_ok_and(|status| status.success());
    let definition = std::fs::read_to_string(&export).ok();
    let _ = std::fs::remove_file(&export);
    if !exported || !definition.is_some_and(|definition| launcher_serves(&definition, home)) {
        return false;
    }
    let mut delete = Command::new("schtasks");
    delete
        .args(["/Delete", "/F", "/TN", name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::win_console::hide_console(&mut delete);
    delete.status().is_ok_and(|status| status.success())
}

#[cfg(not(any(target_os = "macos", windows)))]
// Called outside tests only: a test must not change the machine's services.
#[cfg_attr(test, allow(dead_code))]
pub(super) fn retire_shared_service(_home: &Path) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = "/Users/a/Library/Application Support/xyz.carpediem.subrosa/hermes";
    const DEV: &str = "/Users/a/Library/Application Support/xyz.carpediem.subrosa-dev/hermes";

    fn plist_for(home: &str) -> String {
        format!(
            "<dict>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    \
             <string>/usr/bin</string>\n    <key>HERMES_HOME</key>\n    \
             <string>{home}</string>\n  </dict>\n</dict>"
        )
    }

    #[test]
    fn a_plist_serves_the_home_it_names_and_no_other() {
        assert!(plist_serves(&plist_for(RELEASE), Path::new(RELEASE)));
        assert!(!plist_serves(&plist_for(RELEASE), Path::new(DEV)));
        assert!(!plist_serves(&plist_for(DEV), Path::new(RELEASE)));
        assert!(!plist_serves(
            &plist_for("/Users/a/.hermes"),
            Path::new(RELEASE)
        ));
        assert!(!plist_serves("<dict></dict>", Path::new(RELEASE)));
    }

    #[test]
    fn a_plist_names_its_home_as_xml() {
        let plist = plist_for("/Users/a/R&amp;D/hermes");
        assert!(plist_serves(&plist, Path::new("/Users/a/R&D/hermes")));
    }

    #[test]
    fn a_launcher_serves_the_home_whose_folder_it_names() {
        let sep = std::path::MAIN_SEPARATOR;
        let home = Path::new(RELEASE);
        let launcher = home.join("gateway-service").join("Hermes_Gateway.vbs");
        let task = format!(
            "<Arguments>//B //Nologo \"{}\"</Arguments>",
            xml_text(&launcher.to_string_lossy())
        );
        assert!(launcher_serves(&task, home));
        assert!(launcher_serves(&task.to_uppercase(), home));
        assert!(!launcher_serves(&task, Path::new(DEV)));
        // A home whose name only starts like this one is another home.
        let longer = format!("{RELEASE}2{sep}gateway-service{sep}Hermes_Gateway.vbs");
        assert!(!launcher_serves(&longer, home));
    }

    #[test]
    fn only_a_patched_runtime_names_its_service_after_its_home() {
        let root = std::env::temp_dir().join(format!("subrosa-label-{}", std::process::id()));
        let bundle = root.join("bundle");
        let venv = root.join("managed/hermes-agent/venv/bin");
        let plain = root.join("plain/bin");
        for dir in [
            bundle.join("bin"),
            bundle.join("hermes-agent/hermes_cli"),
            venv.clone(),
            root.join("managed/hermes-agent/hermes_cli"),
            plain.clone(),
            root.join("plain/hermes-agent/hermes_cli"),
        ] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let patched =
            format!("    # Sub Rosa ({PATCH_MARKER}.sh): only the platform home is the default.\n");
        std::fs::write(bundle.join("hermes-agent/hermes_cli/gateway.py"), &patched).unwrap();
        std::fs::write(
            root.join("managed/hermes-agent/hermes_cli/gateway.py"),
            &patched,
        )
        .unwrap();
        std::fs::write(
            root.join("plain/hermes-agent/hermes_cli/gateway.py"),
            "    if home == default:\n",
        )
        .unwrap();

        assert!(names_service_per_home(&bundle.join("bin/hermes")));
        assert!(names_service_per_home(&venv.join("hermes")));
        assert!(!names_service_per_home(&plain.join("hermes")));
        assert!(!names_service_per_home(Path::new("/usr/local/bin/hermes")));
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Against the real launchd: a job serving another home stays, the job
    /// serving this one is stopped and its file removed. Uses a label of its
    /// own, never the person's gateway. `cargo test -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "loads a real LaunchAgent"]
    fn a_real_launchd_job_serving_this_home_is_retired() {
        use std::process::Command;
        let label = format!("xyz.carpediem.subrosa.label-test-{}", std::process::id());
        let agents = Path::new(&std::env::var_os("HOME").unwrap()).join("Library/LaunchAgents");
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let plist = agents.join(format!("{label}.plist"));
        let loaded = || {
            Command::new("/bin/launchctl")
                .args(["print", &format!("{domain}/{label}")])
                .output()
                .unwrap()
                .status
                .success()
        };
        let job = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
             <key>Label</key><string>{label}</string>\
             <key>ProgramArguments</key><array><string>/bin/sleep</string><string>600</string></array>\
             <key>EnvironmentVariables</key><dict><key>HERMES_HOME</key><string>{RELEASE}</string></dict>\
             <key>RunAtLoad</key><true/></dict></plist>\n"
        );
        std::fs::write(&plist, job).unwrap();
        assert!(Command::new("/bin/launchctl")
            .args(["bootstrap", &domain, &plist.to_string_lossy()])
            .status()
            .unwrap()
            .success());
        assert!(loaded());

        assert_eq!(
            retire_launchd_job(&agents, &label, Path::new(DEV), &domain),
            None
        );
        assert!(loaded() && plist.exists(), "another home's job must stay");

        assert!(retire_launchd_job(&agents, &label, Path::new(RELEASE), &domain).is_some());
        assert!(!loaded(), "the job must be unloaded");
        assert!(!plist.exists(), "the job's file must be gone");
    }

    /// Against the real Task Scheduler: a task serving another home stays,
    /// the task serving this one is deleted. Uses a task of its own.
    #[cfg(windows)]
    #[test]
    #[ignore = "registers a real scheduled task"]
    fn a_real_scheduled_task_serving_this_home_is_retired() {
        use std::process::Command;
        let name = format!("SubRosaLabelTest_{}", std::process::id());
        let root = std::env::temp_dir().join(format!("subrosa-label-é-{}", std::process::id()));
        let (mine, other) = (root.join("mine"), root.join("other"));
        let launcher = mine.join("gateway-service").join("Hermes_Gateway.vbs");
        let exists = || {
            Command::new("schtasks")
                .args(["/Query", "/TN", &name])
                .output()
                .unwrap()
                .status
                .success()
        };
        let created = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(
                "$action = New-ScheduledTaskAction -Execute 'wscript.exe' \
                 -Argument ('//B //Nologo \"' + $env:LAUNCHER + '\"'); \
                 Register-ScheduledTask -TaskName $env:TASK -Action $action | Out-Null",
            )
            .env("TASK", &name)
            .env("LAUNCHER", &launcher)
            .status()
            .unwrap();
        assert!(created.success());
        assert!(exists());

        assert!(!retire_task(&name, &other));
        assert!(exists(), "another home's task must stay");

        assert!(retire_task(&name, &mine));
        assert!(!exists(), "the task must be deleted");
    }
}
