//! One corpus, replayed against every root the app confines a path to.
//!
//! Before this file, the media gallery had confinement tests and the Hermes
//! bridge had none — the difference was invisible because both call sites read
//! correctly. The rule now is structural: a command that takes a path names its
//! root here, and inherits the whole corpus. Adding a caller without adding a
//! row is the thing this is meant to catch.
//!
//! The write cases matter as much as the read cases. `save_hermes_bridge_file`
//! used to accept any absolute destination and create its parent directories,
//! which turned a download button into an arbitrary file write — the contents
//! being whatever the agent last put in its workspace. The dialog moved into
//! Rust so no destination crosses IPC at all; `confine_new` is the second line
//! behind that, and these cases are what hold it.

use std::fs;
use std::path::{Path, PathBuf};

use os_june_lib::path_confinement::{
    confine_existing, confine_new, is_confined, is_sensitive_path,
};

const CODE: &str = "test_denied";
const MESSAGE: &str = "denied";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "subrosa-confinement-{name}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// The escapes every caller must refuse, expressed relative to a root.
fn traversals(root: &Path) -> Vec<PathBuf> {
    vec![
        root.join("..").join("escaped.txt"),
        root.join("a").join("..").join("..").join("escaped.txt"),
        root.join("../../../etc/passwd"),
        PathBuf::from("/etc/passwd"),
        PathBuf::from("relative.txt"),
    ]
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[test]
fn a_file_inside_the_root_reads() {
    let root = scratch("read-inside");
    let nested = root.join("sub");
    fs::create_dir_all(&nested).unwrap();
    let file = nested.join("report.md");
    fs::write(&file, b"hello").unwrap();

    let resolved = confine_existing(std::slice::from_ref(&root), &file, CODE, MESSAGE).unwrap();
    assert_eq!(resolved, file.canonicalize().unwrap());
}

#[test]
fn every_traversal_is_refused_on_read() {
    let root = scratch("read-traversal");
    fs::write(root.parent().unwrap().join("escaped.txt"), b"x").ok();
    for candidate in traversals(&root) {
        assert!(
            confine_existing(std::slice::from_ref(&root), &candidate, CODE, MESSAGE).is_err(),
            "read should refuse {}",
            candidate.display()
        );
    }
}

#[test]
fn a_credential_file_inside_the_root_is_still_refused() {
    let root = scratch("read-secrets");
    for name in [".env", "id_ed25519", "server.pem", "auth.lock"] {
        let file = root.join(name);
        fs::write(&file, b"x").unwrap();
        assert!(
            confine_existing(std::slice::from_ref(&root), &file, CODE, MESSAGE).is_err(),
            "{name} sits in the root but must not be readable"
        );
        assert!(is_sensitive_path(&file));
    }
    let ssh = root.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    let key = ssh.join("config");
    fs::write(&key, b"x").unwrap();
    assert!(confine_existing(std::slice::from_ref(&root), &key, CODE, MESSAGE).is_err());
}

#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_root_is_refused_on_read() {
    let root = scratch("read-symlink");
    let outside = scratch("read-symlink-outside");
    let secret = outside.join("secret.txt");
    fs::write(&secret, b"x").unwrap();
    let link = root.join("innocent.txt");
    std::os::unix::fs::symlink(&secret, &link).unwrap();

    assert!(
        confine_existing(std::slice::from_ref(&root), &link, CODE, MESSAGE).is_err(),
        "canonicalization must follow the link out and then refuse it"
    );
}

#[test]
fn a_second_root_widens_without_weakening() {
    let a = scratch("read-root-a");
    let b = scratch("read-root-b");
    let outside = scratch("read-root-outside");
    let in_b = b.join("f.txt");
    fs::write(&in_b, b"x").unwrap();
    let in_outside = outside.join("f.txt");
    fs::write(&in_outside, b"x").unwrap();

    let roots = vec![a, b];
    assert!(confine_existing(&roots, &in_b, CODE, MESSAGE).is_ok());
    assert!(confine_existing(&roots, &in_outside, CODE, MESSAGE).is_err());
}

#[test]
fn a_root_that_does_not_exist_is_skipped_not_fatal() {
    let root = scratch("read-missing-root");
    let file = root.join("f.txt");
    fs::write(&file, b"x").unwrap();
    let roots = vec![PathBuf::from("/nonexistent-root-xyz"), root];
    assert!(confine_existing(&roots, &file, CODE, MESSAGE).is_ok());
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

#[test]
fn a_new_file_under_the_root_is_allowed() {
    let root = scratch("write-inside");
    let target = root.join("nested").join("deeper").join("out.txt");
    let resolved = confine_new(std::slice::from_ref(&root), &target, CODE, MESSAGE).unwrap();
    assert!(resolved.starts_with(&root));
    assert!(!resolved.exists(), "confine_new must not create anything");
}

#[test]
fn every_traversal_is_refused_on_write() {
    let root = scratch("write-traversal");
    for candidate in traversals(&root) {
        assert!(
            confine_new(std::slice::from_ref(&root), &candidate, CODE, MESSAGE).is_err(),
            "write should refuse {}",
            candidate.display()
        );
    }
}

/// The finding this file exists for: a workspace file, whose contents the agent
/// controls, copied into a place the OS runs on login.
#[test]
fn an_auto_run_location_is_refused_on_write() {
    let home = scratch("write-home");
    let documents = home.join("Documents");
    fs::create_dir_all(&documents).unwrap();
    // These are the roots a save dialog result is held to.
    let roots = vec![documents.clone()];

    for hostile in [
        home.join("Library/LaunchAgents/xyz.plist"),
        home.join(".zshrc"),
        home.join(".config/autostart/x.desktop"),
        home.join("Library/Application Support/Sub Rosa/carpe-diem.json"),
    ] {
        assert!(
            confine_new(&roots, &hostile, CODE, MESSAGE).is_err(),
            "write should refuse {}",
            hostile.display()
        );
    }

    let benign = documents.join("report.pdf");
    assert!(confine_new(&roots, &benign, CODE, MESSAGE).is_ok());
}

#[cfg(unix)]
#[test]
fn a_symlinked_parent_cannot_redirect_a_write() {
    let root = scratch("write-symlink");
    let outside = scratch("write-symlink-outside");
    let link = root.join("looks-inside");
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    assert!(
        confine_new(
            std::slice::from_ref(&root),
            &link.join("payload.txt"),
            CODE,
            MESSAGE
        )
        .is_err(),
        "the deepest existing ancestor is canonicalized, so the link resolves out"
    );
}

#[test]
fn a_credential_name_is_refused_on_write() {
    let root = scratch("write-secrets");
    for name in [".env", "id_rsa", "wildcard.pfx", ".git-credentials"] {
        assert!(
            confine_new(std::slice::from_ref(&root), &root.join(name), CODE, MESSAGE).is_err(),
            "write should refuse to create {name}"
        );
    }
}

// ---------------------------------------------------------------------------
// The cheap check the gallery uses directly
// ---------------------------------------------------------------------------

#[test]
fn is_confined_matches_the_corpus_without_touching_the_disk() {
    let root = Path::new("/gallery");
    assert!(is_confined(root, Path::new("/gallery/a/b.png")));
    assert!(!is_confined(root, Path::new("/gallery/../etc/passwd")));
    assert!(!is_confined(root, Path::new("/gallery-other/a.png")));
    assert!(!is_confined(root, Path::new("/elsewhere/a.png")));
}
