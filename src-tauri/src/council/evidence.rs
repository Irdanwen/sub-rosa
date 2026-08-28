//! What the verdict is allowed to look at.
//!
//! A verdict with no evidence is an opinion, and an opinion about work nobody
//! read is worse than silence. So the seats are handed what actually changed
//! in the working folder, gathered here, and every seat is told to quote from
//! it.
//!
//! Two paths, and the difference is stated to the seats rather than hidden:
//!
//! - **A git repository**, which is the reliable one. The diff runs against the
//!   HEAD recorded when the agent took the mandate, so anything the session
//!   committed is visible -- a verdict that only sees the working tree would
//!   read a finished, committed job as "nothing happened". Untracked files are
//!   read separately, because `git diff` cannot see a file git has never heard
//!   of, and a newly created file is very often the whole deliverable.
//! - **A plain folder**, where the best available answer is "files touched
//!   since the sitting opened". Coarser, and inclusive by design: a file
//!   touched during the deliberation shows up. Erring wide costs some context
//!   and errs toward showing the reviewer too much, which is the right
//!   direction for a reviewer.

use std::path::Path;

/// The ceiling on what one verdict reads. A refactor across two hundred files
/// would otherwise blow the context of every seat at once and fail the whole
/// verdict rather than most of it.
const EVIDENCE_MAX_CHARS: usize = 60_000;

/// How much of one untracked or changed file is read. Enough to tell a real
/// implementation from a stub, which is the question the letter seat asks.
const FILE_MAX_CHARS: usize = 6_000;

/// How many new files are read in full. Past this the listing still names them.
const MAX_NEW_FILES: usize = 20;

/// Folders never worth reading into a prompt: they are outputs, not work.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    "vendor",
    "Pods",
];

pub struct Evidence {
    pub text: String,
    /// `git` or `mtime`. Shown to the seats, because how the evidence was
    /// gathered changes how much weight it deserves.
    pub kind: &'static str,
    /// True when the cap bit. Never silent: a reviewer who does not know it
    /// read half the work will report on half the work as though it were all
    /// of it.
    pub truncated: bool,
}

impl Evidence {
    fn empty(kind: &'static str) -> Self {
        Self {
            text: String::new(),
            kind,
            truncated: false,
        }
    }
}

/// Gather what changed in `working_dir`.
pub async fn gather(working_dir: &str, base_commit: Option<&str>, since_rfc3339: &str) -> Evidence {
    let path = Path::new(working_dir);
    if !path.is_dir() {
        return Evidence::empty("missing");
    }
    if is_repo(working_dir).await {
        return from_git(working_dir, base_commit).await;
    }
    from_mtime(path, since_rfc3339).await
}

async fn is_repo(working_dir: &str) -> bool {
    git(working_dir, &["rev-parse", "--is-inside-work-tree"])
        .await
        .map(|out| out.trim() == "true")
        .unwrap_or(false)
}

async fn from_git(working_dir: &str, base_commit: Option<&str>) -> Evidence {
    let mut out = String::new();
    let base = base_commit
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("HEAD");

    if let Some(stat) = git(working_dir, &["diff", "--stat", base]).await {
        if !stat.trim().is_empty() {
            out.push_str("<changed_files>\n");
            out.push_str(stat.trim());
            out.push_str("\n</changed_files>\n\n");
        }
    }
    if let Some(diff) = git(working_dir, &["diff", base]).await {
        if !diff.trim().is_empty() {
            out.push_str("<diff>\n");
            out.push_str(diff.trim());
            out.push_str("\n</diff>\n\n");
        }
    }

    // Files git has never heard of. `git diff` is blind to them, and the new
    // file is often the deliverable itself.
    if let Some(status) = git(working_dir, &["status", "--porcelain"]).await {
        let new_files: Vec<&str> = status
            .lines()
            .filter_map(|line| line.strip_prefix("?? "))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .collect();
        if !new_files.is_empty() {
            out.push_str("<new_files>\n");
            for (index, relative) in new_files.iter().enumerate() {
                if index >= MAX_NEW_FILES {
                    out.push_str(&format!(
                        "... and {} more new paths, not read\n",
                        new_files.len() - MAX_NEW_FILES
                    ));
                    break;
                }
                out.push_str(&render_file(Path::new(working_dir).join(relative), relative).await);
            }
            out.push_str("</new_files>\n\n");
        }
    }

    finish(out, "git")
}

async fn from_mtime(root: &Path, since_rfc3339: &str) -> Evidence {
    let Ok(since) = chrono::DateTime::parse_from_rfc3339(since_rfc3339) else {
        return Evidence::empty("mtime");
    };
    let since: std::time::SystemTime = since.into();

    let mut touched: Vec<(std::path::PathBuf, String)> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    // A walk that gives up partway must say so. A reviewer who does not know
    // the listing is incomplete reads it as complete, and reports on a fraction
    // of the work as though it were the whole of it.
    let mut walk_cut_short = false;
    while let Some(dir) = stack.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            let touched_after = entry
                .metadata()
                .await
                .ok()
                .and_then(|meta| meta.modified().ok())
                .map(|modified| modified > since)
                .unwrap_or(false);
            if !touched_after {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            touched.push((path, relative));
        }
        if touched.len() > MAX_NEW_FILES * 4 {
            walk_cut_short = true;
            break;
        }
    }
    // Deterministic, so a verdict re-driven after a crash reads the same files
    // in the same order.
    touched.sort_by(|left, right| left.1.cmp(&right.1));

    let mut out = String::new();
    if touched.is_empty() {
        return finish(out, "mtime");
    }
    out.push_str("<touched_files>\n");
    for (_, relative) in &touched {
        out.push_str(relative);
        out.push('\n');
    }
    if walk_cut_short {
        out.push_str(
            "... the folder holds more changed files than this listing reached, so this is not all of them\n",
        );
    }
    out.push_str("</touched_files>\n\n");
    for (index, (path, relative)) in touched.iter().enumerate() {
        if index >= MAX_NEW_FILES {
            out.push_str(&format!(
                "... and {} more touched paths, not read\n",
                touched.len() - MAX_NEW_FILES
            ));
            break;
        }
        out.push_str(&render_file(path.clone(), relative).await);
    }
    finish(out, "mtime")
}

async fn render_file(path: std::path::PathBuf, relative: &str) -> String {
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let capped: String = contents.chars().take(FILE_MAX_CHARS).collect();
            let elided = contents.chars().count() > FILE_MAX_CHARS;
            format!(
                "<file path=\"{relative}\">\n{capped}{}\n</file>\n",
                if elided { "\n... (file truncated)" } else { "" }
            )
        }
        // Binary, unreadable, or gone again. Naming it is still evidence: a
        // deliverable that is a binary is a fact the reviewer needs.
        Err(_) => format!("<file path=\"{relative}\">(not readable as text)</file>\n"),
    }
}

fn finish(mut text: String, kind: &'static str) -> Evidence {
    let truncated = text.chars().count() > EVIDENCE_MAX_CHARS;
    if truncated {
        text = text.chars().take(EVIDENCE_MAX_CHARS).collect();
        text.push_str("\n\n... evidence truncated at the reading limit.");
    }
    Evidence {
        text,
        kind,
        truncated,
    }
}

/// Run git in a folder. `None` on any failure, which the callers read as "this
/// path is not available" rather than as an error worth failing a verdict over.
async fn git(working_dir: &str, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(working_dir)
        .args(args)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The working folder's HEAD, recorded when the agent takes a mandate.
pub async fn head_commit(working_dir: &str) -> Option<String> {
    let head = git(working_dir, &["rev-parse", "HEAD"]).await?;
    let head = head.trim().to_string();
    if head.is_empty() {
        return None;
    }
    Some(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cap_is_announced_rather_than_applied_quietly() {
        let long = "x".repeat(EVIDENCE_MAX_CHARS + 100);
        let evidence = finish(long, "git");
        assert!(evidence.truncated);
        assert!(evidence
            .text
            .ends_with("evidence truncated at the reading limit."));
    }

    #[test]
    fn short_evidence_is_left_alone() {
        let evidence = finish("a small diff".to_string(), "git");
        assert!(!evidence.truncated);
        assert_eq!(evidence.text, "a small diff");
    }

    #[tokio::test]
    async fn a_folder_that_is_not_there_yields_nothing_rather_than_an_error() {
        let evidence = gather("/definitely/not/a/folder", None, "2026-08-28T00:00:00Z").await;
        assert_eq!(evidence.kind, "missing");
        assert!(evidence.text.is_empty());
    }

    #[tokio::test]
    async fn a_plain_folder_reports_what_was_touched_after_the_sitting_opened() {
        let dir = std::env::temp_dir().join(format!("council-ev-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(dir.join("node_modules"))
            .await
            .expect("mkdir");
        tokio::fs::write(dir.join("made.txt"), "the deliverable")
            .await
            .expect("write");
        tokio::fs::write(dir.join("node_modules/noise.txt"), "not work")
            .await
            .expect("write");

        let evidence = gather(dir.to_str().expect("path"), None, "2020-01-01T00:00:00Z").await;
        assert_eq!(evidence.kind, "mtime");
        assert!(evidence.text.contains("made.txt"));
        assert!(evidence.text.contains("the deliverable"));
        assert!(
            !evidence.text.contains("noise.txt"),
            "an output directory is not work"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn a_walk_that_gives_up_partway_says_so() {
        let dir = std::env::temp_dir().join(format!("council-ev-many-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.expect("mkdir");
        for index in 0..(MAX_NEW_FILES * 4 + 5) {
            tokio::fs::write(dir.join(format!("f{index}.txt")), "x")
                .await
                .expect("write");
        }

        let evidence = gather(dir.to_str().expect("path"), None, "2020-01-01T00:00:00Z").await;
        assert!(
            evidence.text.contains("so this is not all of them"),
            "a listing that stopped early must not read as complete"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn nothing_touched_since_the_sitting_reads_as_nothing() {
        let dir = std::env::temp_dir().join(format!("council-ev-old-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.expect("mkdir");
        tokio::fs::write(dir.join("old.txt"), "written before")
            .await
            .expect("write");

        // A cutoff far in the future: nothing can have been touched after it.
        let evidence = gather(dir.to_str().expect("path"), None, "2099-01-01T00:00:00Z").await;
        assert!(evidence.text.is_empty());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
