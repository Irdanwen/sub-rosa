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
use super::sandbox_profile::RUNTIME_STATE_DIRS;

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
    for dir in RUNTIME_STATE_DIRS.iter().chain(READ_ONLY_DIRS) {
        std::fs::create_dir_all(hermes_home.join(dir))?;
    }
    Ok(())
}

/// Lays the home out before a start: its folders, the `.env` from the app's
/// record (importing the existing one once, filtered), and no sticky
/// profile. Fails the start rather than leave a file it could not rewrite.
pub(super) fn prepare(hermes_home: &Path) -> Result<(), AppError> {
    create_skeleton(hermes_home).map_err(failed)?;
    let mut settings = admin_settings::load(hermes_home);
    if settings.env.is_none() {
        // First start under ADR-0140: keep what a person set before (a
        // skill's key, a messaging token), never what grants rights.
        let existing = std::fs::read_to_string(hermes_home.join(".env")).unwrap_or_default();
        let imported: BTreeMap<String, String> = admin_settings::parse_dotenv(&existing)
            .into_iter()
            .filter(|(key, _)| admin_settings::env_key_allowed(key, true))
            .collect();
        settings.env = Some(imported);
        admin_settings::save(hermes_home, &settings).map_err(failed)?;
    }
    let env = settings.env.unwrap_or_default();
    write_owned(
        &hermes_home.join(".env"),
        &admin_settings::render_dotenv(&env),
    )
    .map_err(failed)?;
    remove_owned(&hermes_home.join(ACTIVE_PROFILE_FILE)).map_err(failed)
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
            "NOTION_API_KEY=secret\nHERMES_YOLO_MODE=1\nexport TELEGRAM_ALLOWED_USERS=42\n",
        )
        .unwrap();
        std::fs::write(home.join("active_profile"), "planted\n").unwrap();

        prepare(&home).unwrap();

        let env = std::fs::read_to_string(home.join(".env")).unwrap();
        assert!(env.contains("NOTION_API_KEY='secret'"), "{env}");
        assert!(!env.contains("HERMES_YOLO_MODE"), "{env}");
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
