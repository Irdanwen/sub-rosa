//! The two ways of knowing what a working folder held when Code mode started:
//! git, when the folder is in a repository with a commit, and a copy of the
//! folder's files otherwise. Both feed the same review (`review.rs`).

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use sha2::Digest as _;

use crate::domain::types::AppError;

/// Folders a code review never walks: what tools rebuild, not what anyone
/// wrote. Git mode does not need this list, `.gitignore` already says it.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    "Pods",
    ".DS_Store",
];

/// A folder bigger than this is not copied: without git there is no cheap
/// way to follow it, and a copy that takes minutes is not a mode switch.
pub(super) const MAX_SNAPSHOT_FILES: usize = 20_000;
/// A file larger than this is not read at all: it is neither shown nor
/// followed.
pub(super) const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

pub(super) fn sha(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A path as the review names it: relative, `/`-separated, only plain names.
pub(super) fn relative_name(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_str()?.to_string()),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// What a regular file holds now, or `None` when there is no regular file
/// there (missing, a folder, a link, or too large to read). Read without
/// following a link on any part of the path (ADR-0140): a folder on the way
/// the jail replaced by a link is refused, not followed.
pub(super) fn read_current(folder: &Path, name: &str) -> Option<Vec<u8>> {
    crate::confined_read::read_beneath(folder, Path::new(name), MAX_FILE_BYTES).ok()
}

/// Every regular file under `folder`, skipping links and rebuilt folders.
/// Errors when the folder holds more than `limit` files.
pub(super) fn walk(folder: &Path, limit: usize) -> Result<BTreeSet<String>, AppError> {
    let mut files = BTreeSet::new();
    let mut pending: Vec<PathBuf> = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(folder.join(&relative)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(text) = name.to_str() else { continue };
            if SKIP_DIRS.contains(&text) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let child = relative.join(&name);
            if kind.is_dir() {
                pending.push(child);
            } else if kind.is_file() {
                if let Some(name) = relative_name(&child) {
                    files.insert(name);
                }
                if files.len() > limit {
                    return Err(AppError::new(
                        "code_review_too_large",
                        "This folder has too many files to follow without git. Pick a smaller folder or make it a git repository.",
                    ));
                }
            }
        }
    }
    Ok(files)
}

/// Git, run in the working folder so paths are relative to it and limited
/// to it.
pub(super) struct Git<'a> {
    pub folder: &'a Path,
}

impl Git<'_> {
    fn run(&self, args: &[&str]) -> Result<Vec<u8>, AppError> {
        // Neutralized, checked, jailed and bounded in time (ADR-0140): the
        // session writes this folder.
        let output = crate::hermes_bridge::jailed_git::run(self.folder, args)?;
        if !output.status.success() {
            return Err(AppError::new(
                "code_review_git_failed",
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        Ok(output.stdout)
    }

    /// The commit the folder is on, when it is in a repository that has one.
    /// A folder whose git the app refuses (ADR-0140) is an error the person
    /// reads, never a silent fall back to a copy of the folder.
    pub fn head(&self) -> Result<Option<String>, AppError> {
        let refused =
            |error: &AppError| error.code == "git_unsafe_folder" || error.code == "git_timed_out";
        let inside = match self.run(&["rev-parse", "--is-inside-work-tree"]) {
            Ok(inside) => inside,
            Err(error) if refused(&error) => return Err(error),
            Err(_) => return Ok(None),
        };
        if String::from_utf8_lossy(&inside).trim() != "true" {
            return Ok(None);
        }
        let head = match self.run(&["rev-parse", "--verify", "HEAD^{commit}"]) {
            Ok(head) => head,
            Err(error) if refused(&error) => return Err(error),
            Err(_) => return Ok(None),
        };
        let head = String::from_utf8_lossy(&head).trim().to_string();
        Ok((head.len() >= 40 && head.chars().all(|c| c.is_ascii_hexdigit())).then_some(head))
    }

    fn names(&self, args: &[&str]) -> Result<BTreeSet<String>, AppError> {
        let out = self.run(args)?;
        Ok(out
            .split(|byte| *byte == 0)
            .filter(|name| !name.is_empty())
            .filter_map(|name| std::str::from_utf8(name).ok())
            .filter_map(|name| relative_name(Path::new(name)))
            .collect())
    }

    /// Files that differ from `head` in the working tree (tracked ones), and
    /// files git has never heard of that are not ignored.
    pub fn changed_since(&self, head: &str) -> Result<BTreeSet<String>, AppError> {
        let mut names = self.names(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            "--relative",
            head,
            "--",
        ])?;
        names.extend(self.names(&["ls-files", "-z", "--others", "--exclude-standard"])?);
        Ok(names)
    }

    /// The file as `head` has it, or `None` when `head` has no such file.
    pub fn file_at(&self, head: &str, name: &str) -> Result<Option<Vec<u8>>, AppError> {
        let listed = self.run(&["ls-tree", "-z", head, "--", name])?;
        if listed.is_empty() {
            return Ok(None);
        }
        // A folder or a submodule at that path is not a file to restore.
        if !listed
            .split(|byte| *byte == b' ')
            .nth(1)
            .is_some_and(|kind| kind == b"blob")
        {
            return Ok(None);
        }
        // The bytes as committed: never through a filter the folder names.
        let spec = format!("{head}:./{name}");
        self.run(&["cat-file", "blob", &spec]).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_relative_and_plain() {
        assert_eq!(
            relative_name(Path::new("src/a.rs")).as_deref(),
            Some("src/a.rs")
        );
        assert_eq!(relative_name(Path::new("../a")), None);
        assert_eq!(relative_name(Path::new("/etc/passwd")), None);
        assert_eq!(relative_name(Path::new("./a")), None);
        assert_eq!(relative_name(Path::new("")), None);
    }

    #[test]
    fn a_walk_skips_rebuilt_folders_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "a").unwrap();
        std::fs::write(dir.path().join("node_modules/x/b.js"), "b").unwrap();
        std::fs::write(dir.path().join("README"), "r").unwrap();
        let files = walk(dir.path(), 10).unwrap();
        assert_eq!(
            files.into_iter().collect::<Vec<_>>(),
            vec!["README", "src/a.rs"]
        );
        assert_eq!(
            walk(dir.path(), 1).unwrap_err().code,
            "code_review_too_large"
        );
    }
}

/// ADR-0140 (final pass): the code review reads a folder the jail wrote
/// without running what it planted, and reads a past file as committed.
#[cfg(test)]
#[cfg(target_os = "macos")]
mod planted_tests {
    use super::Git;
    use crate::hermes_bridge::jailed_git::planted::{planted_repository, Plant};

    #[test]
    fn the_review_runs_nothing_the_jail_planted() {
        // What the command's own configuration outranks: read, never run.
        let planted = planted_repository(Plant::Neutralized);
        let git = Git {
            folder: &planted.repo,
        };
        let head = git.head().unwrap().expect("a head");
        let changed = git.changed_since(&head).unwrap();
        let before = git.file_at(&head, "a.txt").unwrap();
        planted.assert_untouched(&[before.clone().unwrap_or_default()]);
        assert!(
            changed.contains("a.txt") && changed.contains("new.txt"),
            "{changed:?}"
        );
        assert_eq!(before.as_deref(), Some(&b"one\n"[..]));
        // A defined program: the folder is refused.
        let planted = planted_repository(Plant::Programs);
        let git = Git {
            folder: &planted.repo,
        };
        let refused = git
            .head()
            .expect_err("a folder defining a program was read");
        assert_eq!(refused.code, "git_unsafe_folder");
        assert!(git.file_at("HEAD", "a.txt").is_err());
        planted.assert_untouched(&[]);
    }

    /// ADR-0140 (audit D5): a folder on the way replaced by a link to a
    /// folder outside is not read through.
    #[test]
    fn a_folder_replaced_by_a_link_is_not_read_through() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("work");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("id_ed25519"), "AUDIT-KEY-CONTENT").unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("d")).unwrap();
        assert_eq!(super::read_current(&folder, "d/id_ed25519"), None);
        std::fs::create_dir_all(folder.join("e")).unwrap();
        std::fs::write(folder.join("e/f.txt"), "inside").unwrap();
        assert_eq!(
            super::read_current(&folder, "e/f.txt").as_deref(),
            Some(&b"inside"[..])
        );
    }
}
