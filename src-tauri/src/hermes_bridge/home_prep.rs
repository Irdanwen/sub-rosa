//! What the app writes in the runtime's home before each start, from
//! outside the jail (ADR-0140).
//!
//! The sandboxed runtime cannot create or rewrite most of its home any more,
//! so the app lays it out: the folders the runtime expects to find (its
//! agent fails to start when `cron/` cannot be created), the `.env` it reads
//! at start, rewritten from the app's own record so one planted before this
//! rule is gone, and no `active_profile`, which would point the gateway the
//! system service manager restarts at another home.

use std::collections::BTreeMap;
use std::path::Path;

use crate::domain::types::AppError;

use super::admin_settings;
use super::sandbox_profile::{RUNTIME_STATE_DIRS, RUNTIME_STATE_FILES};

/// The folders of the home that are read-only to the jail but must exist
/// for the runtime to start and run: it creates them on first use, which the
/// jail now refuses. Measured on the pinned runtime: without `cron/` a
/// session's agent does not start; the others fail the tool that needs them
/// with a clearer error than a missing folder.
const READ_ONLY_DIRS: &[&str] = &[
    "cron",
    "cron/output",
    "memories",
    "skills",
    "hooks",
    "bin",
    "plugins",
    "pairing",
];

/// The sticky profile file the runtime's command line follows when it is
/// given no `--profile` (`hermes_cli/main.py`, `_apply_profile_override`).
/// The app passes `--profile default` to every command it runs, but the
/// gateway's service definition, which the runtime writes itself, carries
/// none, so the file must not exist.
const ACTIVE_PROFILE_FILE: &str = "active_profile";

/// Creates every folder the runtime expects in its home.
pub(super) fn create_skeleton(hermes_home: &Path) -> std::io::Result<()> {
    for dir in RUNTIME_STATE_DIRS
        .iter()
        .chain(READ_ONLY_DIRS)
        .chain(&["workspace/uploads"])
    {
        let path = hermes_home.join(dir);
        // A link in place of one of these folders (planted before ADR-0140)
        // goes, so the folder is the home's own.
        if path
            .symlink_metadata()
            .is_ok_and(|meta| !meta.is_dir() || meta.file_type().is_symlink())
        {
            std::fs::remove_file(&path)?;
        }
        std::fs::create_dir_all(path)?;
    }
    Ok(())
}

/// Lays the home out before a start: its folders, the `.env` from the app's
/// record (importing the existing one once, filtered), and no sticky
/// profile. Fails the start rather than leave a file it could not rewrite.
pub(super) fn prepare(hermes_home: &Path) -> Result<(), AppError> {
    // First start under ADR-0140: what a jailed process could plant before
    // goes aside first, before the gateway or a runtime starts on it.
    // It is the shared home that held them, whichever home starts first.
    let shared = super::home_split::shared_home(hermes_home);
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    super::quarantine::run_once(&shared, &date).map_err(failed)?;
    create_skeleton(hermes_home).map_err(failed)?;
    sweep_links(hermes_home);
    let mut settings = admin_settings::load(hermes_home);
    if settings.env.is_none() {
        // First start under ADR-0140: keep what a person set before (a
        // skill's key, a messaging token), never what grants rights. The
        // file as it was is set aside, out of the jail's reach, until the
        // runtime has said which keys it declares (an empty schema means the
        // refresh before this start did not answer): nothing is imported
        // against an empty list, and nothing planted survives meanwhile.
        let aside = env_set_aside(hermes_home);
        if aside.symlink_metadata().is_err() {
            // The `.env` a person may have filled is the shared home's (the
            // sandboxed home is new).
            let existing = std::fs::read_to_string(shared.join(".env")).unwrap_or_default();
            write_owned(&aside, &existing).map_err(failed)?;
        }
        if !settings.env_schema.is_empty() {
            let existing = std::fs::read_to_string(&aside).unwrap_or_default();
            let imported: BTreeMap<String, String> = admin_settings::parse_dotenv(&existing)
                .into_iter()
                .filter(|(key, _)| {
                    admin_settings::env_key_allowed(
                        key,
                        admin_settings::KeyUse::Credential,
                        &settings,
                    )
                })
                .collect();
            settings.env = Some(imported);
            admin_settings::save(hermes_home, &settings).map_err(failed)?;
            let _ = std::fs::remove_file(&aside);
        }
    }
    let env = settings.env.clone().unwrap_or_default();
    write_owned(
        &hermes_home.join(".env"),
        &admin_settings::render_dotenv(&env, &settings),
    )
    .map_err(failed)?;
    remove_owned(&hermes_home.join(ACTIVE_PROFILE_FILE)).map_err(failed)
}

/// Where the `.env` found at the first start under ADR-0140 waits for its
/// import: the app's data folder, which the jail cannot write.
fn env_set_aside(hermes_home: &Path) -> std::path::PathBuf {
    hermes_home
        .parent()
        .unwrap_or(hermes_home)
        .join("hermes-env-before-adr-0140")
}

/// Writes a file the app owns in the home. A symlink in its place (one a
/// jailed process could plant before ADR-0140) is removed first, so the
/// write never lands where it points.
pub(super) fn write_owned(path: &Path, contents: &str) -> std::io::Result<()> {
    match path.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(path)?,
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path)?,
        _ => {}
    }
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Removes the sticky profile from the home before the gateway starts; the
/// sandboxed runtime cannot write it back.
pub(super) fn neutralize_active_profile(hermes_home: &Path) {
    if let Err(error) = remove_owned(&hermes_home.join(ACTIVE_PROFILE_FILE)) {
        eprintln!("hermes home: could not remove active_profile: {error}");
    }
}

/// Where the app keeps the logs it writes itself (the runtime's output, the
/// gateway's start, settings changes, the developer terminal launcher): in
/// its data folder, out of the jail's reach, never in the home's `logs/`,
/// which the jail writes (ADR-0140).
pub(super) fn app_log_dir(hermes_home: &Path) -> std::path::PathBuf {
    hermes_home.parent().unwrap_or(hermes_home).join("logs")
}

/// Whether `path` is a link (never followed to answer).
pub(super) fn is_link(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
}

/// The workspace's `uploads` folder, made if missing, refused when it or the
/// workspace is not a real folder: the jail writes both, and a link there
/// would carry the app's writes out of the home (ADR-0140).
pub(super) fn upload_dir(hermes_home: &Path) -> std::io::Result<std::path::PathBuf> {
    let workspace = hermes_home.join("workspace");
    let uploads = workspace.join("uploads");
    for path in [&workspace, &uploads] {
        if is_link(path) {
            return Err(std::io::Error::other(format!(
                "{} is a link, not a folder",
                path.display()
            )));
        }
    }
    std::fs::create_dir_all(&uploads)?;
    if is_link(&workspace) || is_link(&uploads) {
        return Err(std::io::Error::other(
            "the uploads folder changed into a link",
        ));
    }
    Ok(uploads)
}

/// Creates a file the app writes in a folder the jail also writes (the
/// workspace's `uploads`): only a new file, never whatever stands at the
/// name, which `create_new` refuses without following it.
pub(super) fn create_new_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Removes the links a jailed process could plant before ADR-0140 where the
/// jail still writes and processes outside it open files by name (the kernel
/// refuses new ones since): symbolic links, and files with a second name.
/// The workspace is the person's and keeps its links, but for `uploads`.
fn sweep_links(hermes_home: &Path) {
    let mut roots: Vec<std::path::PathBuf> = RUNTIME_STATE_DIRS
        .iter()
        .filter(|dir| **dir != "workspace")
        .map(|dir| hermes_home.join(dir))
        .collect();
    roots.push(hermes_home.join("workspace").join("uploads"));
    for file in RUNTIME_STATE_FILES {
        let path = hermes_home.join(file);
        if let Ok(meta) = path.symlink_metadata() {
            if meta.file_type().is_symlink()
                || (meta.is_file() && hard_linked(&meta))
                || special(&meta)
            {
                if let Err(error) = std::fs::remove_file(&path) {
                    eprintln!("hermes home: could not remove a link: {error}");
                }
            }
        }
    }
    let mut stack = roots;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = path.symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink()
                || (meta.is_file() && hard_linked(&meta))
                || special(&meta)
            {
                if let Err(error) = std::fs::remove_file(&path) {
                    eprintln!("hermes home: could not remove a link: {error}");
                }
            } else if meta.is_dir() {
                stack.push(path);
            }
        }
    }
}

/// A pipe, a socket or a device: something that would hang or answer an
/// open by name instead of holding data.
#[cfg(unix)]
fn special(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::FileTypeExt as _;
    let kind = meta.file_type();
    kind.is_fifo() || kind.is_socket() || kind.is_char_device() || kind.is_block_device()
}

#[cfg(not(unix))]
fn special(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn hard_linked(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    meta.nlink() > 1
}

#[cfg(not(unix))]
fn hard_linked(_meta: &std::fs::Metadata) -> bool {
    false
}

fn remove_owned(path: &Path) -> std::io::Result<()> {
    match path.symlink_metadata() {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn failed(error: std::io::Error) -> AppError {
    AppError::new("hermes_bridge_home_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_planted_env_and_profile_are_gone_after_a_start() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".env"),
            "NOTION_API_KEY=secret\nHERMES_YOLO_MODE=1\nexport TELEGRAM_ALLOWED_USERS=42\nPIP_INDEX_URL=http://example.invalid/simple\nAPI_SERVER_KEY=planted\nAPI_SERVER_ENABLED=true\nTELEGRAM_HOME_CHANNEL=1\n",
        )
        .unwrap();
        std::fs::write(home.join("active_profile"), "planted\n").unwrap();

        // Before the runtime has declared its keys: nothing is imported, and
        // nothing planted is left in the file.
        prepare(&home).unwrap();
        let env = std::fs::read_to_string(home.join(".env")).unwrap();
        assert!(
            !env.contains("HERMES_YOLO_MODE") && !env.contains("NOTION"),
            "{env}"
        );
        assert!(!home.join("active_profile").exists());
        // Once it has: the declared keys come back from the set-aside copy.
        admin_settings::record_schema(
            &home,
            admin_settings::EnvSchemaLists {
                declared: vec![
                    "NOTION_API_KEY".into(),
                    "TELEGRAM_ALLOWED_USERS".into(),
                    "HERMES_YOLO_MODE".into(),
                    "API_SERVER_KEY".into(),
                    "API_SERVER_ENABLED".into(),
                    "TELEGRAM_HOME_CHANNEL".into(),
                ],
                secrets: vec!["NOTION_API_KEY".into(), "API_SERVER_KEY".into()],
            },
        )
        .unwrap();
        prepare(&home).unwrap();

        let env = std::fs::read_to_string(home.join(".env")).unwrap();
        assert!(env.contains("NOTION_API_KEY='secret'"), "{env}");
        assert!(!env.contains("HERMES_YOLO_MODE"), "{env}");
        // An undeclared key (a package index) is not imported either.
        assert!(!env.contains("PIP_INDEX_URL"), "{env}");
        // The gateway's agent API is never switched on by an import, nor a
        // messaging home channel carried over from a file (ADR-0140, E1).
        assert!(!env.contains("API_SERVER"), "{env}");
        assert!(!env.contains("TELEGRAM_HOME_CHANNEL"), "{env}");
        // An authorization a planted file could carry is not imported.
        assert!(!env.contains("ALLOWED_USERS"), "{env}");
        assert!(!home.join("active_profile").exists());
        for dir in ["cron", "skills", "memories", "workspace", "sessions"] {
            assert!(home.join(dir).is_dir(), "{dir} missing");
        }

        // Once imported, the app's record is the source: a line added to the
        // file afterwards (by anything) is gone at the next start.
        std::fs::write(home.join(".env"), "HERMES_YOLO_MODE=1\nOTHER=x\n").unwrap();
        prepare(&home).unwrap();
        let env = std::fs::read_to_string(home.join(".env")).unwrap();
        assert!(env.contains("NOTION_API_KEY='secret'"));
        assert!(!env.contains("HERMES_YOLO_MODE") && !env.contains("OTHER"));
    }

    #[cfg(unix)]
    #[test]
    fn the_app_writes_no_upload_through_a_linked_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        std::fs::create_dir_all(&home).unwrap();
        assert!(upload_dir(&home).unwrap().ends_with("workspace/uploads"));
        std::fs::remove_dir_all(home.join("workspace")).unwrap();
        std::os::unix::fs::symlink(dir.path(), home.join("workspace")).unwrap();
        assert!(upload_dir(&home).is_err());
        assert!(!dir.path().join("uploads").exists());
        // Nor is a linked workspace a root to read or list files from.
        let roots = super::super::filesystem_roots(&home).unwrap();
        assert!(roots.iter().all(|root| root.id != "workspace-unrestricted"));
    }

    #[test]
    fn the_apps_own_logs_live_out_of_the_home() {
        let home = std::path::Path::new("/data/xyz.carpediem.subrosa/hermes");
        let logs = app_log_dir(home);
        assert_eq!(
            logs,
            std::path::Path::new("/data/xyz.carpediem.subrosa/logs")
        );
        assert!(!logs.starts_with(home));
    }

    #[cfg(unix)]
    #[test]
    fn links_left_where_others_open_by_name_are_swept_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("hermes");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("target"), "keep").unwrap();
        create_skeleton(&home).unwrap();
        let link =
            |at: &str| std::os::unix::fs::symlink(outside.join("target"), home.join(at)).unwrap();
        link("logs/gateway.log");
        link("sessions/sessions.json");
        link("workspace/uploads/report.pdf.txt");
        link("workspace/project-link");
        link("state.db");
        assert!(std::process::Command::new("mkfifo")
            .arg(home.join("logs/gateway.err"))
            .status()
            .unwrap()
            .success());
        std::fs::hard_link(outside.join("target"), home.join("cache/hard")).unwrap();
        std::fs::remove_dir_all(home.join("images")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("images")).unwrap();
        prepare(&home).unwrap();
        for gone in [
            "logs/gateway.log",
            "logs/gateway.err",
            "sessions/sessions.json",
            "workspace/uploads/report.pdf.txt",
            "cache/hard",
            "state.db",
        ] {
            assert!(home.join(gone).symlink_metadata().is_err(), "{gone} kept");
        }
        // The person's own links in the workspace stay.
        assert!(home
            .join("workspace/project-link")
            .symlink_metadata()
            .is_ok());
        let images = home.join("images").symlink_metadata().unwrap();
        assert!(images.is_dir() && !images.file_type().is_symlink());
        assert_eq!(
            std::fs::read_to_string(outside.join("target")).unwrap(),
            "keep"
        );
        // A new upload never lands where a link points.
        std::os::unix::fs::symlink(outside.join("target"), home.join("workspace/uploads/a.png"))
            .unwrap();
        assert!(create_new_file(&home.join("workspace/uploads/a.png")).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("target")).unwrap(),
            "keep"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_place_of_an_owned_file_is_replaced_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("elsewhere");
        std::fs::write(&target, "keep").unwrap();
        let link = dir.path().join(".env");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        write_owned(&link, "A='b'\n").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        assert!(!link.symlink_metadata().unwrap().file_type().is_symlink());
    }
}
