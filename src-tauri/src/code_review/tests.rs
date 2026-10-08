use std::path::{Path, PathBuf};
use std::process::Command;

use super::review::{self, ChangeStatus};
use super::store_in;

struct Bench {
    _dir: tempfile::TempDir,
    folder: PathBuf,
    store: PathBuf,
}

fn bench() -> Bench {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let folder = root.join("project");
    std::fs::create_dir_all(&folder).unwrap();
    let store = store_in(&root.join("data"), "session-1");
    Bench {
        _dir: dir,
        folder,
        store,
    }
}

fn write(folder: &Path, name: &str, text: &[u8]) {
    let path = folder.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(folder: &Path, name: &str) -> String {
    std::fs::read_to_string(folder.join(name)).unwrap()
}

fn listed(store: &Path, review: &review::Review) -> Vec<(String, ChangeStatus)> {
    review::changes(store, review)
        .unwrap()
        .0
        .into_iter()
        .map(|change| (change.path, change.status))
        .collect()
}

fn git(folder: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(folder)
        .args([
            "-c",
            "user.email=t@example.org",
            "-c",
            "user.name=T",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .is_ok_and(|output| output.status.success())
}

#[test]
fn a_store_is_named_by_a_hash_never_by_the_id() {
    let store = store_in(Path::new("/data"), "../../etc");
    assert!(store.starts_with("/data/code-review"));
    assert_eq!(store.file_name().unwrap().len(), 32);
    assert_ne!(
        store_in(Path::new("/d"), "a"),
        store_in(Path::new("/d"), "b")
    );
}

#[test]
fn a_plain_folder_is_reviewed_against_a_copy() {
    let bench = bench();
    let folder = &bench.folder;
    write(folder, "a.txt", b"one\ntwo\n");
    write(folder, "b.txt", b"keep me\n");
    write(folder, "src/c.rs", b"fn main() {}\n");
    write(folder, "node_modules/x.js", b"ignored\n");
    let mut review = review::start(&bench.store, folder).unwrap();
    assert_eq!(review.base, review::Base::Snapshot);
    assert!(listed(&bench.store, &review).is_empty());

    write(folder, "a.txt", b"one\nTWO\n");
    std::fs::remove_file(folder.join("b.txt")).unwrap();
    write(folder, "d.txt", b"new\n");
    write(folder, "node_modules/x.js", b"changed but rebuilt\n");
    let (changes, cut) = review::changes(&bench.store, &review).unwrap();
    assert!(!cut);
    let names: Vec<_> = changes
        .iter()
        .map(|c| (c.path.as_str(), c.status.clone()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("a.txt", ChangeStatus::Modified),
            ("b.txt", ChangeStatus::Deleted),
            ("d.txt", ChangeStatus::Added),
        ]
    );
    let diff = changes[0].diff.as_deref().unwrap();
    assert!(diff.starts_with("--- a/a.txt\n+++ b/a.txt\n"), "{diff}");
    assert!(diff.contains("-two\n+TWO\n"));
    assert_eq!((changes[0].additions, changes[0].deletions), (1, 1));
    assert!(changes[2]
        .diff
        .as_deref()
        .unwrap()
        .starts_with("--- /dev/null\n+++ b/d.txt"));

    // Revert puts the start back; an added file goes away.
    review::revert(&bench.store, &review, "a.txt").unwrap();
    assert_eq!(read(folder, "a.txt"), "one\ntwo\n");
    review::revert(&bench.store, &review, "d.txt").unwrap();
    assert!(!folder.join("d.txt").exists());
    review::revert(&bench.store, &review, "b.txt").unwrap();
    assert_eq!(read(folder, "b.txt"), "keep me\n");

    // Keep makes the current state the start.
    write(folder, "src/c.rs", b"fn main() { run(); }\n");
    review::keep(&bench.store, &mut review, "src/c.rs").unwrap();
    assert!(listed(&bench.store, &review).is_empty());
    let reloaded = review::load(&bench.store).unwrap().unwrap();
    assert!(listed(&bench.store, &reloaded).is_empty());

    // Only changed files, by a plain name inside the folder.
    assert_eq!(
        review::revert(&bench.store, &review, "a.txt")
            .unwrap_err()
            .code,
        "code_review_not_changed"
    );
    for refused in [
        "../outside.txt",
        "/etc/hosts",
        "./a.txt",
        ".git/config",
        "src/../a.txt",
    ] {
        assert_eq!(
            review::revert(&bench.store, &review, refused)
                .unwrap_err()
                .code,
            "code_review_path_refused",
            "{refused}"
        );
    }

    review::stop(&bench.store).unwrap();
    assert!(!bench.store.exists());
    assert!(review::load(&bench.store).unwrap().is_none());
    assert_eq!(read(folder, "src/c.rs"), "fn main() { run(); }\n");
}

#[test]
fn starting_again_on_the_same_folder_keeps_the_review() {
    let bench = bench();
    write(&bench.folder, "a.txt", b"start\n");
    let review = review::start(&bench.store, &bench.folder).unwrap();
    write(&bench.folder, "a.txt", b"changed\n");
    let again = review::start(&bench.store, &bench.folder).unwrap();
    assert_eq!(again.started_at, review.started_at);
    assert_eq!(listed(&bench.store, &again).len(), 1);
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_folder_is_never_written_through() {
    let bench = bench();
    let outside = bench.folder.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    write(&outside, "secret.txt", b"untouched\n");
    write(&bench.folder, "a.txt", b"a\n");
    let review = review::start(&bench.store, &bench.folder).unwrap();
    std::os::unix::fs::symlink(&outside, bench.folder.join("out")).unwrap();
    // The walk does not follow the link, and a revert through it is refused.
    assert!(listed(&bench.store, &review).is_empty());
    assert_eq!(
        review::revert(&bench.store, &review, "out/secret.txt")
            .unwrap_err()
            .code,
        "code_review_path_refused"
    );
    assert_eq!(read(&outside, "secret.txt"), "untouched\n");
}

#[test]
fn binary_and_oversized_files_are_listed_but_not_diffed() {
    let bench = bench();
    write(&bench.folder, "image.bin", b"\x00\x01\x02");
    write(&bench.folder, "big.txt", &vec![b'a'; 3 * 1024 * 1024]);
    let review = review::start(&bench.store, &bench.folder).unwrap();
    write(&bench.folder, "image.bin", b"\x00\x01\x03");
    write(&bench.folder, "big.txt", b"small now\n");
    let (changes, _) = review::changes(&bench.store, &review).unwrap();
    let big = changes.iter().find(|c| c.path == "big.txt").unwrap();
    assert!(!big.revertible && big.binary && big.diff.is_none());
    assert_eq!(
        review::revert(&bench.store, &review, "big.txt")
            .unwrap_err()
            .code,
        "code_review_not_revertible"
    );
    let image = changes.iter().find(|c| c.path == "image.bin").unwrap();
    assert!(image.binary && image.revertible && image.diff.is_none());
    review::revert(&bench.store, &review, "image.bin").unwrap();
    assert_eq!(
        std::fs::read(bench.folder.join("image.bin")).unwrap(),
        b"\x00\x01\x02"
    );
}

#[test]
fn a_repository_is_reviewed_against_the_start_not_against_head() {
    let bench = bench();
    let folder = &bench.folder;
    if !git(folder, &["init", "-q"]) {
        // No git on this machine: the plain-folder test covers the rest.
        return;
    }
    write(folder, ".gitignore", b"out/\n");
    write(folder, "lib.rs", b"pub fn a() {}\n");
    write(folder, "wip.rs", b"committed\n");
    assert!(git(folder, &["add", "."]));
    assert!(git(folder, &["commit", "-qm", "start"]));
    // Work in progress before the mode starts is the start, not a change.
    write(folder, "wip.rs", b"in progress\n");
    write(folder, "notes.md", b"untracked\n");
    write(folder, "out/build.o", b"ignored\n");
    let review = review::start(&bench.store, folder).unwrap();
    assert!(matches!(review.base, review::Base::Git { .. }));
    assert!(listed(&bench.store, &review).is_empty());

    // The agent edits, adds, and commits part of it.
    write(folder, "lib.rs", b"pub fn a() {}\npub fn b() {}\n");
    write(folder, "wip.rs", b"in progress, then edited\n");
    write(folder, "new.rs", b"fresh\n");
    write(folder, "out/build.o", b"rebuilt\n");
    assert!(git(folder, &["commit", "-qam", "agent"]));
    let changes = listed(&bench.store, &review);
    assert_eq!(
        changes,
        vec![
            ("lib.rs".to_string(), ChangeStatus::Modified),
            ("new.rs".to_string(), ChangeStatus::Added),
            ("wip.rs".to_string(), ChangeStatus::Modified),
        ]
    );
    // Reverting goes back to what the person had, not to the commit.
    review::revert(&bench.store, &review, "wip.rs").unwrap();
    assert_eq!(read(folder, "wip.rs"), "in progress\n");
    review::revert(&bench.store, &review, "lib.rs").unwrap();
    assert_eq!(read(folder, "lib.rs"), "pub fn a() {}\n");
    review::revert(&bench.store, &review, "new.rs").unwrap();
    assert!(!folder.join("new.rs").exists());
    assert!(listed(&bench.store, &review).is_empty());
    assert_eq!(read(folder, "notes.md"), "untracked\n");
}

#[test]
fn a_subfolder_of_a_repository_is_reviewed_alone() {
    let bench = bench();
    let root = &bench.folder;
    if !git(root, &["init", "-q"]) {
        return;
    }
    write(root, "app/main.rs", b"main\n");
    write(root, "other/x.rs", b"x\n");
    assert!(git(root, &["add", "."]));
    assert!(git(root, &["commit", "-qm", "start"]));
    let app = root.join("app");
    let review = review::start(&bench.store, &app).unwrap();
    write(root, "other/x.rs", b"changed outside\n");
    write(&app, "main.rs", b"main, changed\n");
    assert_eq!(
        listed(&bench.store, &review),
        vec![("main.rs".to_string(), ChangeStatus::Modified)]
    );
    review::revert(&bench.store, &review, "main.rs").unwrap();
    assert_eq!(read(&app, "main.rs"), "main\n");
}
