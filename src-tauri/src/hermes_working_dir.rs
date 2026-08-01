//! Per-session working folder for the desktop agent (fork addition).
//!
//! A working folder is a user-picked directory the runtime is started in
//! (its cwd) and — on macOS — the one user directory the Seatbelt write-jail
//! explicitly re-grants. Because that grant widens the jail with a
//! user-influenced path, every candidate goes through `validate_working_dir`
//! before it is ever handed to a spawn or written into a profile; the sandbox
//! code must never receive an unvalidated path. See
//! docs/adr/0014-per-session-working-folder.md for the decision record.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::domain::types::AppError;

/// Credential-store directories relative to the user's home. Shared between
/// the working-folder validator (which refuses any folder containing or
/// contained by one of these) and the Seatbelt profile (which denies reads
/// AND writes on them, so even a granted working folder can't reach them).
pub(crate) const SECRET_STORE_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".config/gh",
    "Library/Keychains",
];

/// Credential FILES at the top of the user's home, same dual use as
/// `SECRET_STORE_DIRS`.
pub(crate) const SECRET_STORE_FILES: &[&str] =
    &[".netrc", ".git-credentials", ".npmrc", ".pypirc", ".pgpass"];

/// System locations refused as working folders, prefix-matched: the folder
/// itself and anything under it. An agent writing here is never "a project".
fn guarded_system_prefixes() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            "/System",
            "/Library",
            "/Applications",
            "/usr",
            "/bin",
            "/sbin",
            "/etc",
            "/private/etc",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }
    #[cfg(windows)]
    {
        let mut prefixes = Vec::new();
        for var in [
            "SystemRoot",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramData",
        ] {
            if let Some(value) = std::env::var_os(var) {
                if !value.is_empty() {
                    prefixes.push(PathBuf::from(value));
                }
            }
        }
        prefixes
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        ["/usr", "/bin", "/sbin", "/etc", "/lib", "/boot"]
            .iter()
            .map(PathBuf::from)
            .collect()
    }
}

/// Locations refused only when picked EXACTLY (their subfolders are fine):
/// container directories whose children are legitimate projects but whose
/// whole tree is not — e.g. `/Volumes/USB/project` is a working folder,
/// `/Volumes` is every mounted disk at once.
fn guarded_exact_paths() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        ["/private", "/private/var", "/Volumes", "/Users"]
            .iter()
            .map(PathBuf::from)
            .collect()
    }
    #[cfg(windows)]
    {
        std::env::var_os("SystemDrive")
            .map(|drive| {
                let mut users = PathBuf::from(&drive);
                users.push("\\Users");
                vec![users]
            })
            .unwrap_or_default()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        ["/home", "/var", "/mnt", "/media"]
            .iter()
            .map(PathBuf::from)
            .collect()
    }
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn invalid(message: &str) -> AppError {
    AppError::new("working_dir_invalid", message)
}

/// A validated working folder: the canonical path the spawn and the sandbox
/// grant must both use, plus whether the pick is broad enough to deserve an
/// extra confirmation in the UI (never a refusal).
#[derive(Debug)]
pub(crate) struct ValidatedWorkingDir {
    pub path: PathBuf,
    pub broad: bool,
}

/// Validates a user-picked working folder against this machine's layout.
/// This is the single gate between "a string the user influenced" and "a
/// path the Seatbelt jail re-grants": both the pick-time command and the
/// spawn path call it, so a folder that turned invalid between the two
/// (deleted, unmounted, replaced by a symlink) is refused at spawn too.
pub(crate) fn validate_working_dir(
    app: &AppHandle,
    raw: &str,
) -> Result<ValidatedWorkingDir, AppError> {
    let app_data_dir = crate::app_paths::app_data_dir(app).ok();
    validate_working_dir_with(
        raw,
        home_dir().as_deref(),
        app_data_dir.as_deref(),
        &guarded_system_prefixes(),
        &guarded_exact_paths(),
    )
}

/// Canonicalizes a comparison anchor best-effort: symlinked anchors (macOS
/// `/etc` -> `/private/etc`, tempdir homes under `/var/folders`) must compare
/// in the same canonical space as the candidate; anchors that don't exist on
/// this machine keep their literal form.
fn canon(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// The pure(ish) core of `validate_working_dir` — everything machine-specific
/// arrives as a parameter so tests can exercise each refusal deterministically.
/// Only the filesystem itself is touched (existence + canonicalization, which
/// also resolves symlinks so the checks run against the real target).
fn validate_working_dir_with(
    raw: &str,
    home: Option<&Path>,
    app_data_dir: Option<&Path>,
    guarded_prefixes: &[PathBuf],
    guarded_exact: &[PathBuf],
) -> Result<ValidatedWorkingDir, AppError> {
    let home = home.map(canon);
    let app_data_dir = app_data_dir.map(canon);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("The working folder path is empty."));
    }
    let requested = PathBuf::from(trimmed);
    if !requested.is_absolute() {
        return Err(invalid("The working folder must be an absolute path."));
    }
    let canonical = requested.canonicalize().map_err(|error| {
        AppError::new(
            "working_dir_unavailable",
            format!("The working folder can't be opened right now. {error}"),
        )
    })?;
    if !canonical.is_dir() {
        return Err(invalid("The working folder must be a folder, not a file."));
    }
    if canonical.parent().is_none() {
        return Err(invalid(
            "A whole disk can't be a working folder. Pick a specific folder.",
        ));
    }
    for exact in guarded_exact {
        if canonical == canon(exact) {
            return Err(invalid(
                "This folder holds other people's or other apps' data. Pick a folder inside it instead.",
            ));
        }
    }
    for prefix in guarded_prefixes {
        if canonical.starts_with(canon(prefix)) {
            return Err(invalid("System folders can't be a working folder."));
        }
    }
    if let Some(app_data_dir) = app_data_dir.as_deref() {
        // Both directions: the app's data dir contains the sandbox profile,
        // the settings, and the agent's own home — a working folder that is
        // it, contains it, or lives inside it would let the jailed agent
        // rewrite the policy (or the app state) that governs it.
        if canonical.starts_with(app_data_dir) || app_data_dir.starts_with(&canonical) {
            return Err(invalid(
                "This app's own data folder can't be a working folder.",
            ));
        }
    }
    let mut broad = false;
    if let Some(home) = home.as_deref() {
        // Refuse any folder that contains, or is contained by, a credential
        // store. `home` itself is an ancestor of every store, so the home
        // directory (and its parents) fall out of this rule for free.
        for relative in SECRET_STORE_DIRS.iter().chain(SECRET_STORE_FILES) {
            let secret = home.join(relative);
            if canonical.starts_with(&secret) || secret.starts_with(&canonical) {
                return Err(invalid(
                    "This folder would include credential stores (like .ssh or keychains). Pick a narrower folder.",
                ));
            }
        }
        // Broad-but-legitimate picks get a confirmation, not a refusal.
        broad = ["Documents", "Desktop", "Downloads"]
            .iter()
            .any(|name| canonical == home.join(name));
    }
    Ok(ValidatedWorkingDir {
        path: canonical,
        broad,
    })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDirPathRequest {
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDirValidation {
    /// Canonical path — what the frontend must store and compare, so the
    /// mismatch check against the runtime's recorded folder is a plain
    /// string equality.
    pub path: String,
    /// The folder's own name, for the composer chip.
    pub display_name: String,
    /// True for broad picks (Documents, Desktop, Downloads): the UI asks an
    /// extra confirmation before adopting the folder.
    pub broad: bool,
}

#[tauri::command]
pub async fn validate_agent_working_dir(
    app: AppHandle,
    request: WorkingDirPathRequest,
) -> Result<WorkingDirValidation, AppError> {
    let validated = validate_working_dir(&app, &request.path)?;
    let display_name = validated
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| validated.path.to_string_lossy().into_owned());
    Ok(WorkingDirValidation {
        path: validated.path.to_string_lossy().into_owned(),
        display_name,
        broad: validated.broad,
    })
}

/// Opens the folder in the OS file manager (Finder / Explorer). Accepts only
/// a folder that passes working-dir validation, or the app's own default
/// workspace (which validation deliberately refuses as a *working* folder
/// but is a legitimate thing to reveal from the session header).
#[tauri::command]
pub async fn reveal_agent_working_dir(
    app: AppHandle,
    request: WorkingDirPathRequest,
) -> Result<(), AppError> {
    let default_workspace = crate::app_paths::app_data_dir(&app)
        .ok()
        .map(|dir| dir.join("hermes").join("workspace"));
    let requested = PathBuf::from(request.path.trim());
    let canonical = requested.canonicalize().map_err(|error| {
        AppError::new(
            "working_dir_unavailable",
            format!("The folder can't be opened right now. {error}"),
        )
    })?;
    let is_default_workspace = default_workspace
        .and_then(|dir| dir.canonicalize().ok())
        .is_some_and(|dir| dir == canonical);
    if !is_default_workspace {
        validate_working_dir(&app, &request.path)?;
    }
    open_in_file_manager(&canonical)
}

/// A file or folder the composer's `@` palette can mention.
#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// Absolute path — what the agent is given, so it opens the real file in
    /// place rather than a copy.
    pub path: String,
    /// Path relative to the session root, which is what the user recognizes
    /// and what the palette displays and matches on.
    pub relative_path: String,
    pub name: String,
    /// `"file"` or `"folder"`. A mentioned folder is a legitimate target: the
    /// agent lists or searches it.
    pub kind: &'static str,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntriesResponse {
    /// The root that was actually searched, canonical.
    pub root: String,
    /// Its display name, for the palette's empty and header states.
    pub root_label: String,
    pub entries: Vec<FolderEntry>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntriesRequest {
    /// The session's working folder. Omitted (or empty) means the session has
    /// none, and the default workspace is searched instead.
    pub path: Option<String>,
    /// What the user typed after `@`. Empty lists the most recently touched
    /// entries, which is the useful default right after typing the trigger.
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// How deep the walk goes. Deep trees are normal (a repo, a Documents
/// subtree); what matters is that the walk always ends.
const MENTION_MAX_DEPTH: usize = 6;
/// Ceiling on entries *visited*, not returned: a runaway tree must not hang
/// the palette. Hitting it truncates silently — the query narrows the walk,
/// so a user looking for a specific file still finds it.
const MENTION_MAX_VISITED: usize = 20_000;
const MENTION_DEFAULT_LIMIT: usize = 30;
const MENTION_MAX_LIMIT: usize = 100;

/// Directories never worth mentioning: build output, dependency trees, and
/// VCS internals. Skipped wholesale (the walk does not descend into them),
/// which is also what keeps the walk fast in a real project.
const MENTION_SKIPPED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".gradle",
    "Pods",
    "DerivedData",
    ".terraform",
];

/// Lists the files and folders under a session's root so the composer can
/// offer them for `@` mentions.
///
/// The root is the session's working folder, or the default workspace when it
/// has none — which is exactly the area the Seatbelt jail re-grants for
/// writes. Offering anything outside it would advertise a file the agent can
/// read but never modify, so the palette stops where the sandbox stops.
///
/// A working folder goes through the same [`validate_working_dir`] as every
/// other use of a user-influenced path (credential stores, system folders and
/// the app's own data dir are refused), and the walk never follows symlinks,
/// so no entry can point outside the validated root.
#[tauri::command]
pub async fn list_agent_folder_entries(
    app: AppHandle,
    request: FolderEntriesRequest,
) -> Result<FolderEntriesResponse, AppError> {
    let default_workspace = crate::app_paths::app_data_dir(&app)
        .ok()
        .map(|dir| dir.join("hermes").join("workspace"));
    let requested = request.path.as_deref().map(str::trim).unwrap_or("");
    let root = if requested.is_empty() {
        default_workspace.ok_or_else(|| {
            AppError::new(
                "working_dir_unavailable",
                "The workspace folder isn't available yet.",
            )
        })?
    } else {
        validate_working_dir(&app, requested)?.path
    };
    // A workspace that Hermes has not created yet is not an error: the
    // palette shows "nothing to mention" and the user carries on.
    let root = match root.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            return Ok(FolderEntriesResponse {
                root_label: folder_display_name(&root),
                root: root.to_string_lossy().into_owned(),
                entries: Vec::new(),
            })
        }
    };
    let limit = request
        .limit
        .unwrap_or(MENTION_DEFAULT_LIMIT)
        .clamp(1, MENTION_MAX_LIMIT);
    let entries = collect_folder_entries(&root, request.query.trim(), limit);
    Ok(FolderEntriesResponse {
        root_label: folder_display_name(&root),
        root: root.to_string_lossy().into_owned(),
        entries,
    })
}

fn folder_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Walks `root` breadth-first and returns the best `limit` matches for
/// `query`. Breadth-first on purpose: with a truncated walk, the entries
/// nearest the root are the ones a user is most likely to mean.
fn collect_folder_entries(root: &Path, query: &str, limit: usize) -> Vec<FolderEntry> {
    let needle = query.to_lowercase();
    let mut scored: Vec<(i32, std::time::SystemTime, FolderEntry)> = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0usize;

    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            if visited >= MENTION_MAX_VISITED {
                break;
            }
            visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            // Dotfiles are noise in a mention palette, and skipping them also
            // keeps local credential files (.env, .npmrc) out of the list.
            if name.starts_with('.') {
                continue;
            }
            // `file_type` does not follow symlinks: a link is neither walked
            // into nor listed, so the walk cannot leave the validated root.
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative_path = relative.to_string_lossy().replace('\\', "/");
            let is_dir = file_type.is_dir();
            if is_dir && MENTION_SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if is_dir && depth + 1 < MENTION_MAX_DEPTH {
                queue.push_back((path.clone(), depth + 1));
            }
            let Some(score) = mention_score(&name, &relative_path, &needle) else {
                continue;
            };
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            scored.push((
                score,
                modified,
                FolderEntry {
                    path: path.to_string_lossy().into_owned(),
                    relative_path,
                    name,
                    kind: if is_dir { "folder" } else { "file" },
                },
            ));
        }
        if visited >= MENTION_MAX_VISITED {
            break;
        }
    }

    // With no query, most recently touched first: the palette opens on what
    // was just worked on. With a query, best match first and — at equal score
    // — the shortest path, so `report.md` beats `report-archive/` instead of
    // whichever happened to be saved last.
    if needle.is_empty() {
        scored.sort_by(|a, b| b.1.cmp(&a.1));
    } else {
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.2.relative_path.len().cmp(&b.2.relative_path.len()))
                .then_with(|| b.1.cmp(&a.1))
        });
    }
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, entry)| entry)
        .collect()
}

/// Ranks an entry against the typed query, or `None` when it does not match.
/// Deliberately simple and predictable: a name that starts with what you typed
/// beats one that merely contains it, which beats a match elsewhere in the
/// path. An empty query matches everything, so the palette opens on the
/// recently-touched list.
fn mention_score(name: &str, relative_path: &str, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let name_lower = name.to_lowercase();
    if name_lower == needle {
        return Some(100);
    }
    if name_lower.starts_with(needle) {
        return Some(80);
    }
    if name_lower.contains(needle) {
        return Some(60);
    }
    if relative_path.to_lowercase().contains(needle) {
        return Some(40);
    }
    None
}

fn open_in_file_manager(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg(path);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(path);
        crate::win_console::hide_console(&mut command);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::new("working_dir_reveal_failed", error.to_string()))
}

#[cfg(test)]
mod mention_tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, contents).expect("write file");
    }

    fn names(entries: &[FolderEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.name.as_str()).collect()
    }

    #[test]
    fn lists_files_and_folders_under_the_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical root");
        write(&root.join("report.md"), "hello");
        write(&root.join("notes/draft.md"), "hello");

        let entries = collect_folder_entries(&root, "", 30);
        let listed = names(&entries);
        assert!(listed.contains(&"report.md"));
        assert!(listed.contains(&"draft.md"));
        // A folder is mentionable too: the agent lists or searches it.
        assert!(listed.contains(&"notes"));
        let nested = entries
            .iter()
            .find(|entry| entry.name == "draft.md")
            .expect("nested entry");
        // The palette shows the path the user recognizes; the agent gets the
        // absolute one, so it opens the real file in place.
        assert_eq!(nested.relative_path, "notes/draft.md");
        assert_eq!(nested.path, root.join("notes/draft.md").to_string_lossy());
        assert_eq!(nested.kind, "file");
    }

    #[test]
    fn ranks_a_name_match_above_a_path_match() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical root");
        write(&root.join("report.md"), "");
        write(&root.join("report-archive/old.md"), "");
        write(&root.join("unrelated.md"), "");

        let entries = collect_folder_entries(&root, "report", 30);
        let listed = names(&entries);
        assert_eq!(listed.first(), Some(&"report.md"));
        // Matched on its path, so it is offered — just lower.
        assert!(listed.contains(&"old.md"));
        assert!(!listed.contains(&"unrelated.md"));
    }

    #[test]
    fn skips_dependency_trees_dotfiles_and_symlinks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical root");
        write(&root.join("keep.md"), "");
        write(&root.join("node_modules/left-pad/index.js"), "");
        write(&root.join(".git/config"), "");
        // A local credential file is a dotfile, and dotfiles never surface.
        write(&root.join(".env"), "SECRET=1");

        let entries = collect_folder_entries(&root, "", 100);
        let listed = names(&entries);
        assert_eq!(listed, vec!["keep.md"]);

        // A symlink is neither listed nor walked into, so no entry can point
        // outside the validated root. The target lives in its own tempdir —
        // planting it inside `root` would make it a legitimate entry and the
        // test would prove nothing.
        #[cfg(unix)]
        {
            let elsewhere = tempfile::tempdir().expect("tempdir");
            let outside = elsewhere.path().join("outside");
            std::fs::create_dir_all(&outside).expect("create outside");
            write(&outside.join("secret.txt"), "");
            std::os::unix::fs::symlink(&outside, root.join("escape")).expect("symlink");
            let entries = collect_folder_entries(&root, "", 100);
            let listed = names(&entries);
            assert!(!listed.contains(&"escape"));
            assert!(!listed.contains(&"secret.txt"));
        }
    }

    #[test]
    fn stops_at_the_depth_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical root");
        let deep = (0..MENTION_MAX_DEPTH + 3).fold(root.clone(), |path, index| {
            path.join(format!("level{index}"))
        });
        write(&deep.join("buried.md"), "");
        write(&root.join("surface.md"), "");

        let entries = collect_folder_entries(&root, "", 100);
        let listed = names(&entries);
        assert!(listed.contains(&"surface.md"));
        assert!(!listed.contains(&"buried.md"));
    }

    #[test]
    fn an_empty_query_matches_everything_and_honors_the_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonical root");
        for index in 0..10 {
            write(&root.join(format!("file{index}.md")), "");
        }
        assert_eq!(collect_folder_entries(&root, "", 4).len(), 4);
        assert_eq!(collect_folder_entries(&root, "", 100).len(), 10);
        assert!(collect_folder_entries(&root, "nothing-matches-this", 100).is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(
        raw: &str,
        home: Option<&Path>,
        app_data_dir: Option<&Path>,
    ) -> Result<ValidatedWorkingDir, AppError> {
        validate_working_dir_with(raw, home, app_data_dir, &[], &[])
    }

    #[test]
    fn accepts_a_plain_project_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Spaces and non-ASCII in the path must survive validation untouched
        // (this repo itself lives in a folder with a space).
        let project = dir.path().join("Un projet — démo");
        std::fs::create_dir_all(&project).expect("create project");
        let validated = ok(project.to_str().unwrap(), None, None).expect("valid");
        assert_eq!(validated.path, project.canonicalize().unwrap());
        assert!(!validated.broad);
    }

    #[test]
    fn refuses_empty_relative_missing_and_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "x").expect("write file");

        assert_eq!(
            ok("  ", None, None).unwrap_err().code,
            "working_dir_invalid"
        );
        assert_eq!(
            ok("relative/path", None, None).unwrap_err().code,
            "working_dir_invalid"
        );
        let missing = dir.path().join("missing");
        assert_eq!(
            ok(missing.to_str().unwrap(), None, None).unwrap_err().code,
            "working_dir_unavailable"
        );
        assert_eq!(
            ok(file.to_str().unwrap(), None, None).unwrap_err().code,
            "working_dir_invalid"
        );
    }

    #[test]
    fn refuses_the_filesystem_root() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert_eq!(
            ok(root, None, None).unwrap_err().code,
            "working_dir_invalid"
        );
    }

    #[test]
    fn refuses_home_and_secret_store_ancestors() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".ssh")).expect("create .ssh");

        // Home itself is an ancestor of every secret store.
        assert_eq!(
            ok(home.to_str().unwrap(), Some(&home), None)
                .unwrap_err()
                .code,
            "working_dir_invalid"
        );
        // A secret store itself, and anything inside it.
        assert_eq!(
            ok(home.join(".ssh").to_str().unwrap(), Some(&home), None)
                .unwrap_err()
                .code,
            "working_dir_invalid"
        );
        // A parent of home is an ancestor of the stores too.
        assert_eq!(
            ok(dir.path().to_str().unwrap(), Some(&home), None)
                .unwrap_err()
                .code,
            "working_dir_invalid"
        );
        // A sibling project under home stays fine.
        let project = home.join("projects").join("demo");
        std::fs::create_dir_all(&project).expect("create project");
        assert!(ok(project.to_str().unwrap(), Some(&home), None).is_ok());
    }

    #[test]
    fn refuses_the_app_data_dir_in_both_directions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data = dir.path().join("Application Support").join("subrosa");
        let inside = app_data.join("hermes").join("workspace");
        std::fs::create_dir_all(&inside).expect("create app data");

        for candidate in [&app_data, &inside, &dir.path().to_path_buf()] {
            assert_eq!(
                ok(candidate.to_str().unwrap(), None, Some(&app_data))
                    .unwrap_err()
                    .code,
                "working_dir_invalid",
                "should refuse {candidate:?}"
            );
        }
    }

    #[test]
    fn refuses_guarded_prefixes_and_exact_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let system = dir.path().join("System");
        let nested = system.join("Library");
        std::fs::create_dir_all(&nested).expect("create system");
        let volumes = dir.path().join("Volumes");
        let usb = volumes.join("USB");
        std::fs::create_dir_all(&usb).expect("create volumes");

        let prefixes = vec![system.canonicalize().unwrap()];
        let exact = vec![volumes.canonicalize().unwrap()];
        let check = |raw: &Path| {
            validate_working_dir_with(raw.to_str().unwrap(), None, None, &prefixes, &exact)
        };

        // Prefix guard refuses the folder and everything under it.
        assert_eq!(check(&system).unwrap_err().code, "working_dir_invalid");
        assert_eq!(check(&nested).unwrap_err().code, "working_dir_invalid");
        // Exact guard refuses only the container, not its children.
        assert_eq!(check(&volumes).unwrap_err().code, "working_dir_invalid");
        assert!(check(&usb).is_ok());
    }

    #[test]
    fn resolves_symlinks_before_checking() {
        #[cfg(unix)]
        {
            let dir = tempfile::tempdir().expect("tempdir");
            let home = dir.path().join("home");
            std::fs::create_dir_all(home.join(".ssh")).expect("create .ssh");
            let link = dir.path().join("innocent-looking");
            std::os::unix::fs::symlink(home.join(".ssh"), &link).expect("symlink");
            // The symlink's own path looks harmless; the canonical target must
            // be what gets checked.
            assert_eq!(
                ok(link.to_str().unwrap(), Some(&home), None)
                    .unwrap_err()
                    .code,
                "working_dir_invalid"
            );
        }
    }

    #[test]
    fn flags_broad_folders_without_refusing_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        let documents = home.join("Documents");
        let project = documents.join("demo");
        std::fs::create_dir_all(&project).expect("create documents");

        let validated = ok(documents.to_str().unwrap(), Some(&home), None).expect("valid");
        assert!(validated.broad, "Documents root should be flagged broad");
        let validated = ok(project.to_str().unwrap(), Some(&home), None).expect("valid");
        assert!(!validated.broad, "a project inside Documents is not broad");
    }
}
