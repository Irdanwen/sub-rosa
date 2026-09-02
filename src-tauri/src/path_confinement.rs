//! One answer to "may this path be touched", for every command that touches
//! the disk.
//!
//! Three call sites used to carry their own version of this check — the media
//! gallery, the Hermes bridge, and the timeline export. All three were correct,
//! which is exactly why they were dangerous: a fourth would have been written
//! from memory. The rules live here now, and `src-tauri/tests/path_confinement.rs`
//! replays one corpus against every caller.
//!
//! Two distinct questions, deliberately kept apart:
//!
//! * **Reading** — the path must already exist, so it is canonicalized (which
//!   resolves symlinks) and required to sit under a root. This is
//!   [`confine_existing`].
//! * **Writing** — the file does not exist yet, so canonicalization has to
//!   stop at the deepest ancestor that does, and the rest of the path is
//!   checked component by component. This is [`confine_new`].
//!
//! Neither is a substitute for not taking a path from the webview in the first
//! place. `save_hermes_bridge_file` opens its own native dialog rather than
//! trusting a destination it was handed; where a path must cross IPC, it comes
//! through here.

use std::path::{Component, Path, PathBuf};

use crate::domain::types::AppError;

/// Directory and file names that never belong in a path the app was asked to
/// read on the user's behalf, wherever they sit in it.
const SENSITIVE_DIRECTORIES: &[&str] = &[".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker"];

/// Exact file names that are credential material by convention.
const SENSITIVE_FILES: &[&str] = &[
    "auth.lock",
    ".credentials",
    "credentials",
    "credentials.json",
    "application_default_credentials.json",
    "secrets",
    "secrets.json",
    ".netrc",
    ".git-credentials",
    "keychain-db",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
];

/// Suffixes that carry a key or a lock regardless of the stem.
const SENSITIVE_SUFFIXES: &[&str] = &[".lock", ".key", ".pem", ".p12", ".pfx"];

/// Whether `candidate` sits under `root`, without touching the filesystem.
///
/// A `..` anywhere in `candidate` fails outright rather than being normalized:
/// a caller that meant to escape and a caller that built a path sloppily are
/// indistinguishable here, and neither should win.
pub fn is_confined(root: &Path, candidate: &Path) -> bool {
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    candidate.starts_with(root)
}

/// Whether any component of `path` names something the app should not hand
/// back, such as a key directory or a dotenv file.
pub fn is_sensitive_path(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        name.to_str().is_some_and(is_sensitive_component)
    })
}

/// Whether one path component names a credential store. The union of what the
/// Hermes bridge and the media gallery each used to check on their own — when
/// two lists are merged the wider one wins, or factoring loses coverage.
pub fn is_sensitive_component(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    SENSITIVE_DIRECTORIES.contains(&normalized.as_str())
        || SENSITIVE_FILES.contains(&normalized.as_str())
        || normalized == ".env"
        || normalized.starts_with(".env.")
        || SENSITIVE_SUFFIXES
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
}

/// The canonical form of an **existing** path, once it is proven to sit under
/// one of `roots` and to name nothing sensitive.
///
/// `roots` that do not exist are skipped rather than failing the call: the
/// gallery directory and a session working folder both come and go.
pub fn confine_existing(
    roots: &[PathBuf],
    requested: &Path,
    error_code: &'static str,
    denied_message: &'static str,
) -> Result<PathBuf, AppError> {
    let resolved = requested
        .canonicalize()
        .map_err(|error| AppError::new(error_code, error.to_string()))?;
    if is_sensitive_path(&resolved) {
        return Err(AppError::new(error_code, denied_message));
    }
    let allowed = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| is_confined(&root, &resolved));
    if !allowed {
        return Err(AppError::new(error_code, denied_message));
    }
    Ok(resolved)
}

/// The resolved form of a path that does **not** exist yet, proven to land
/// under one of `roots`.
///
/// The deepest existing ancestor is canonicalized (so a symlinked parent
/// cannot point the write out of the root) and the remaining components are
/// required to be plain names. Nothing is created here — the caller decides
/// whether to make the parent directories, and now knows where they will land.
pub fn confine_new(
    roots: &[PathBuf],
    requested: &Path,
    error_code: &'static str,
    denied_message: &'static str,
) -> Result<PathBuf, AppError> {
    let deny = || AppError::new(error_code, denied_message);
    if !requested.is_absolute() {
        return Err(deny());
    }
    // Split at the deepest ancestor that exists. Everything below it must be a
    // plain component: no `..`, no `.`, no second root.
    let mut existing = requested.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(std::ffi::OsString::from) else {
            return Err(deny());
        };
        let Some(parent) = existing.parent().map(Path::to_path_buf) else {
            return Err(deny());
        };
        tail.push(name);
        existing = parent;
    }
    let mut resolved = existing.canonicalize().map_err(|_| deny())?;
    for name in tail.iter().rev() {
        let component = Path::new(name.as_os_str());
        if component.components().count() != 1
            || !matches!(component.components().next(), Some(Component::Normal(_)))
        {
            return Err(deny());
        }
        resolved.push(name);
    }
    if is_sensitive_path(&resolved) {
        return Err(deny());
    }
    let allowed = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| is_confined(&root, &resolved));
    if !allowed {
        return Err(deny());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("subrosa-confine-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn is_confined_rejects_parent_components() {
        let root = Path::new("/tmp/root");
        assert!(is_confined(root, Path::new("/tmp/root/a/b.txt")));
        assert!(!is_confined(root, Path::new("/tmp/root/../etc/passwd")));
        assert!(!is_confined(root, Path::new("/tmp/other/a.txt")));
        assert!(!is_confined(root, Path::new("/tmp/rootless/a.txt")));
    }

    #[test]
    fn sensitive_paths_are_named_wherever_they_sit() {
        for path in [
            "/home/u/.ssh/id_rsa",
            "/home/u/project/.env",
            "/home/u/project/.env.local",
            "/w/.AWS/config",
            "/w/server.pem",
            "/w/credentials.json",
            "/w/id_ed25519",
            "/w/keys/wildcard.pfx",
            "/w/state/auth.lock",
            "/w/application_default_credentials.json",
        ] {
            assert!(is_sensitive_path(Path::new(path)), "should flag {path}");
        }
        assert!(!is_sensitive_path(Path::new("/home/u/notes/report.md")));
        assert!(!is_sensitive_path(Path::new("/home/u/environment.txt")));
    }

    #[test]
    fn confine_existing_resolves_within_a_root() {
        let root = temp_root("existing");
        let file = root.join("note.md");
        fs::write(&file, b"x").unwrap();
        let ok = confine_existing(std::slice::from_ref(&root), &file, "e", "denied").unwrap();
        assert_eq!(ok, file.canonicalize().unwrap());

        let outside = temp_root("existing-outside").join("other.md");
        fs::write(&outside, b"x").unwrap();
        assert!(confine_existing(std::slice::from_ref(&root), &outside, "e", "denied").is_err());

        let secret = root.join(".env");
        fs::write(&secret, b"x").unwrap();
        assert!(confine_existing(std::slice::from_ref(&root), &secret, "e", "denied").is_err());
    }

    #[test]
    fn confine_existing_follows_a_symlink_out_and_refuses() {
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        let target = outside.join("secret.txt");
        fs::write(&target, b"x").unwrap();
        let link = root.join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(not(unix))]
        let _ = fs::copy(&target, &link);
        #[cfg(unix)]
        assert!(
            confine_existing(std::slice::from_ref(&root), &link, "e", "denied").is_err(),
            "a symlink pointing out of the root must not resolve"
        );
    }

    #[test]
    fn confine_new_accepts_a_file_that_does_not_exist_yet() {
        let root = temp_root("new");
        let target = root.join("sub").join("dir").join("out.txt");
        let resolved = confine_new(std::slice::from_ref(&root), &target, "e", "denied").unwrap();
        assert!(resolved.starts_with(&root));
        assert!(resolved.ends_with("sub/dir/out.txt"));
    }

    #[test]
    fn confine_new_refuses_to_leave_the_root() {
        let root = temp_root("new-escape");
        let outside = temp_root("new-escape-outside");
        assert!(confine_new(
            std::slice::from_ref(&root),
            &outside.join("x.txt"),
            "e",
            "denied"
        )
        .is_err());
        assert!(
            confine_new(
                std::slice::from_ref(&root),
                &root.join("../x.txt"),
                "e",
                "denied"
            )
            .is_err(),
            "a parent component must not be normalized away"
        );
        assert!(
            confine_new(
                std::slice::from_ref(&root),
                Path::new("relative.txt"),
                "e",
                "denied"
            )
            .is_err(),
            "a relative path has no root to be judged against"
        );
    }

    #[cfg(unix)]
    #[test]
    fn confine_new_refuses_a_symlinked_parent_that_points_out() {
        let root = temp_root("new-symlink");
        let outside = temp_root("new-symlink-outside");
        let link = root.join("escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(
            confine_new(
                std::slice::from_ref(&root),
                &link.join("payload.txt"),
                "e",
                "denied"
            )
            .is_err(),
            "the deepest existing ancestor is canonicalized, so the link resolves out"
        );
    }
}
