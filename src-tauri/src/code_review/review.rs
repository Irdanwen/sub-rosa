//! One chat's code review: what its working folder held when Code mode
//! started, what changed since, and keeping or reverting one file.
//!
//! The record is `review.json` in the session's store folder, and copies of
//! file contents live beside it as `blobs/<sha256>`. In git mode the record
//! only holds what git cannot say (files already changed or untracked when
//! the mode started, and files the person kept since); every other file's
//! starting content is the recorded commit's. In snapshot mode the record
//! holds every file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::tree::{self, Git};
use crate::domain::types::AppError;

/// A copy is kept of files up to this size; a larger file is followed by
/// its hash and can be shown as changed but not reverted.
const MAX_COPY_BYTES: u64 = 2 * 1024 * 1024;
/// All copies of one review together.
const MAX_STORE_BYTES: u64 = 256 * 1024 * 1024;
/// Files listed in one review. Past this the list says it was cut.
const MAX_CHANGES: usize = 300;
/// A diff longer than this is cut, and says so.
const MAX_DIFF_CHARS: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Base {
    Git { head: String },
    Snapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(super) enum Entry {
    Absent,
    File {
        sha: String,
        size: u64,
        copied: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Review {
    pub version: u32,
    pub folder: PathBuf,
    pub started_at: String,
    pub base: Base,
    pub entries: BTreeMap<String, Entry>,
    pub copied_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: ChangeStatus,
    /// A unified diff, or `None` for a binary file.
    pub diff: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    /// False when no copy of the starting content was kept.
    pub revertible: bool,
    pub truncated: bool,
}

/// What a file held at the start.
enum Start {
    Absent,
    Content(Vec<u8>),
    /// Followed by its hash only.
    Uncopied(String),
}

impl Start {
    fn sha(&self) -> Option<String> {
        match self {
            Start::Absent => None,
            Start::Content(bytes) => Some(tree::sha(bytes)),
            Start::Uncopied(sha) => Some(sha.clone()),
        }
    }
}

fn record_path(store: &Path) -> PathBuf {
    store.join("review.json")
}

fn blob_path(store: &Path, sha: &str) -> PathBuf {
    store.join("blobs").join(sha)
}

fn failed(error: impl std::fmt::Display) -> AppError {
    AppError::new("code_review_failed", error.to_string())
}

pub(super) fn load(store: &Path) -> Result<Option<Review>, AppError> {
    match std::fs::read(record_path(store)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(failed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failed(error)),
    }
}

fn save(store: &Path, review: &Review) -> Result<(), AppError> {
    std::fs::create_dir_all(store).map_err(failed)?;
    let bytes = serde_json::to_vec(review).map_err(failed)?;
    let temporary = store.join("review.json.tmp");
    std::fs::write(&temporary, bytes).map_err(failed)?;
    std::fs::rename(temporary, record_path(store)).map_err(failed)
}

/// The entry for a file's current state, keeping a copy when it fits.
fn entry_for(store: &Path, review: &mut Review, current: Option<&[u8]>) -> Result<Entry, AppError> {
    let Some(bytes) = current else {
        return Ok(Entry::Absent);
    };
    let sha = tree::sha(bytes);
    let size = bytes.len() as u64;
    let path = blob_path(store, &sha);
    let copied = if path.exists() {
        true
    } else if size <= MAX_COPY_BYTES && review.copied_bytes + size <= MAX_STORE_BYTES {
        std::fs::create_dir_all(store.join("blobs")).map_err(failed)?;
        std::fs::write(&path, bytes).map_err(failed)?;
        review.copied_bytes += size;
        true
    } else {
        false
    };
    Ok(Entry::File { sha, size, copied })
}

/// Starts following `folder` (already validated by the caller). Starting
/// again on the same folder keeps the review as it is.
pub(super) fn start(store: &Path, folder: &Path) -> Result<Review, AppError> {
    if let Some(review) = load(store)? {
        if review.folder == folder {
            return Ok(review);
        }
        stop(store)?;
    }
    let git = Git { folder };
    let (base, names) = match git.head() {
        Some(head) => {
            let names = git.changed_since(&head)?;
            (Base::Git { head }, names)
        }
        None => (
            Base::Snapshot,
            tree::walk(folder, tree::MAX_SNAPSHOT_FILES)?,
        ),
    };
    let mut review = Review {
        version: 1,
        folder: folder.to_path_buf(),
        started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        base,
        entries: BTreeMap::new(),
        copied_bytes: 0,
    };
    for name in names {
        let current = tree::read_current(folder, &name);
        let entry = entry_for(store, &mut review, current.as_deref())?;
        review.entries.insert(name, entry);
    }
    save(store, &review)?;
    Ok(review)
}

/// Stops following: the record and its copies go, the folder is untouched.
pub(super) fn stop(store: &Path) -> Result<(), AppError> {
    match std::fs::remove_dir_all(store) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failed(error)),
    }
}

fn start_state(store: &Path, review: &Review, name: &str) -> Result<Start, AppError> {
    if let Some(entry) = review.entries.get(name) {
        return Ok(match entry {
            Entry::Absent => Start::Absent,
            Entry::File { sha, copied, .. } => {
                match copied
                    .then(|| std::fs::read(blob_path(store, sha)).ok())
                    .flatten()
                {
                    Some(bytes) => Start::Content(bytes),
                    None => Start::Uncopied(sha.clone()),
                }
            }
        });
    }
    match &review.base {
        Base::Snapshot => Ok(Start::Absent),
        Base::Git { head } => Ok(
            match (Git {
                folder: &review.folder,
            })
            .file_at(head, name)?
            {
                Some(bytes) => Start::Content(bytes),
                None => Start::Absent,
            },
        ),
    }
}

/// The files that might have changed: everything recorded, plus what is
/// new (git's answer, or a walk).
fn candidates(review: &Review) -> Result<(BTreeSet<String>, bool), AppError> {
    let mut names: BTreeSet<String> = review.entries.keys().cloned().collect();
    let mut cut = false;
    match &review.base {
        Base::Git { head } => names.extend(
            (Git {
                folder: &review.folder,
            })
            .changed_since(head)?,
        ),
        Base::Snapshot => match tree::walk(&review.folder, tree::MAX_SNAPSHOT_FILES) {
            Ok(found) => names.extend(found),
            Err(error) if error.code == "code_review_too_large" => cut = true,
            Err(error) => return Err(error),
        },
    }
    Ok((names, cut))
}

fn is_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

fn change_of(store: &Path, review: &Review, name: &str) -> Result<Option<FileChange>, AppError> {
    let start = start_state(store, review, name)?;
    let current = tree::read_current(&review.folder, name);
    let current_sha = current.as_deref().map(tree::sha);
    if start.sha() == current_sha {
        return Ok(None);
    }
    let status = match (&start, &current) {
        (Start::Absent, _) => ChangeStatus::Added,
        (_, None) => ChangeStatus::Deleted,
        _ => ChangeStatus::Modified,
    };
    let revertible = !matches!(start, Start::Uncopied(_));
    let old: &[u8] = match &start {
        Start::Content(bytes) => bytes,
        _ => &[],
    };
    let new: &[u8] = current.as_deref().unwrap_or_default();
    let binary = matches!(start, Start::Uncopied(_)) || !is_text(old) || !is_text(new);
    let mut change = FileChange {
        path: name.to_string(),
        status,
        diff: None,
        additions: 0,
        deletions: 0,
        binary,
        revertible,
        truncated: false,
    };
    if !binary {
        let (old, new) = (String::from_utf8_lossy(old), String::from_utf8_lossy(new));
        let mut options = diffy::DiffOptions::new();
        options
            .set_original_filename(if change.status == ChangeStatus::Added {
                "/dev/null".to_string()
            } else {
                format!("a/{name}")
            })
            .set_modified_filename(if change.status == ChangeStatus::Deleted {
                "/dev/null".to_string()
            } else {
                format!("b/{name}")
            });
        let patch = options.create_patch(&old, &new);
        for hunk in patch.hunks() {
            for line in hunk.lines() {
                match line {
                    diffy::Line::Insert(_) => change.additions += 1,
                    diffy::Line::Delete(_) => change.deletions += 1,
                    diffy::Line::Context(_) => {}
                }
            }
        }
        let text = patch.to_string();
        change.truncated = text.chars().count() > MAX_DIFF_CHARS;
        change.diff = Some(if change.truncated {
            text.chars().take(MAX_DIFF_CHARS).collect()
        } else {
            text
        });
    }
    Ok(Some(change))
}

/// What changed since the start, file by file, and whether the list was cut.
pub(super) fn changes(store: &Path, review: &Review) -> Result<(Vec<FileChange>, bool), AppError> {
    let (names, mut cut) = candidates(review)?;
    let mut out = Vec::new();
    for name in names {
        if let Some(change) = change_of(store, review, &name)? {
            if out.len() == MAX_CHANGES {
                cut = true;
                break;
            }
            out.push(change);
        }
    }
    Ok((out, cut))
}

/// The file's place in the folder, proven to stay inside it: a plain
/// relative name, no `.git`, and no link on the way that leads out.
fn place(review: &Review, name: &str) -> Result<PathBuf, AppError> {
    let refused = || {
        AppError::new(
            "code_review_path_refused",
            "This file is not one this chat changed in its working folder.",
        )
    };
    let relative = tree::relative_name(Path::new(name)).ok_or_else(refused)?;
    if relative != name || relative.split('/').any(|part| part == ".git") {
        return Err(refused());
    }
    crate::path_confinement::confine_new(
        std::slice::from_ref(&review.folder),
        &review.folder.join(&relative),
        "code_review_path_refused",
        "This file is not one this chat changed in its working folder.",
    )
}

/// Keeps a change: the file's current state becomes its starting state, so
/// it leaves the list until it changes again.
pub(super) fn keep(store: &Path, review: &mut Review, name: &str) -> Result<(), AppError> {
    place(review, name)?;
    if change_of(store, review, name)?.is_none() {
        return Err(not_changed());
    }
    let current = tree::read_current(&review.folder, name);
    let entry = entry_for(store, review, current.as_deref())?;
    review.entries.insert(name.to_string(), entry);
    save(store, review)
}

fn not_changed() -> AppError {
    AppError::new(
        "code_review_not_changed",
        "This file has not changed since Code mode started.",
    )
}

/// Reverts a change: the file goes back to its starting content, or away if
/// it did not exist. Only a file listed as changed now can be reverted, and
/// only inside the folder.
pub(super) fn revert(store: &Path, review: &Review, name: &str) -> Result<(), AppError> {
    let path = place(review, name)?;
    let Some(change) = change_of(store, review, name)? else {
        return Err(not_changed());
    };
    if !change.revertible {
        return Err(AppError::new(
            "code_review_not_revertible",
            "This file was too large to keep a copy of, so it cannot be reverted here.",
        ));
    }
    match start_state(store, review, name)? {
        Start::Content(bytes) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(failed)?;
            }
            // Replace rather than write through: a link put there since would
            // otherwise carry the write somewhere else.
            if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
                return Err(AppError::new(
                    "code_review_path_refused",
                    "This file is not one this chat changed in its working folder.",
                ));
            }
            let temporary = path.with_file_name(format!(
                ".{}.subrosa-revert",
                path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
            ));
            std::fs::write(&temporary, bytes).map_err(failed)?;
            std::fs::rename(&temporary, &path).map_err(failed)
        }
        Start::Absent => match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => std::fs::remove_file(&path).map_err(failed),
            Ok(_) => Err(AppError::new(
                "code_review_path_refused",
                "This file is not one this chat changed in its working folder.",
            )),
            Err(_) => Ok(()),
        },
        Start::Uncopied(_) => Err(AppError::new(
            "code_review_not_revertible",
            "This file was too large to keep a copy of, so it cannot be reverted here.",
        )),
    }
}
