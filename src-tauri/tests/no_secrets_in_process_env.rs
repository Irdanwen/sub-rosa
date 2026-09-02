//! The app does not put a credential in its own environment.
//!
//! `carpe_diem::sidecar` used to publish the session bearer with
//! `std::env::set_var`. The environment is the one piece of process state that
//! is copied into every child, so that handed the token to the Hermes runtime,
//! the Swift dictation and system-audio helpers, and `sandbox-exec` — the
//! sandbox bounds what a helper reads from disk, not what it sends to a
//! loopback port.
//!
//! The session moved into process memory (`carpe_diem::local_session`), and
//! the long-lived children have their environments scrubbed (`child_env`). But
//! the app spawns children from about fifty places, and a wrapper on each of
//! them is a rule nobody can hold. The invariant that actually covers all of
//! them is the one asserted here: **nothing credential-shaped is ever written
//! into this process's environment**, so there is nothing for a child to
//! inherit no matter how it was spawned.
//!
//! This is a source scan, which is a blunt instrument. It is the right one
//! here: the mistake it catches is a single line, added by someone who reached
//! for the obvious tool, and no runtime test would see it unless it happened to
//! exercise that path.

use std::path::Path;

/// Variable-name fragments that mean "this carries a credential or the address
/// of the local backend". Kept in step with `child_env::STRIPPED_PREFIXES` —
/// that one decides what a child may inherit, this one decides what may be
/// written at all.
const SECRET_KEY_FRAGMENTS: &[&str] = &[
    "OS_JUNE_LOCAL_DEV",
    "JUNE_API_URL",
    "JUNE__",
    "SUBROSA_DEV_",
    "CARPE_DIEM_",
    "API_KEY",
    "BEARER",
    "TOKEN",
    "SECRET",
    "PASSWORD",
];

/// Files allowed to call `set_var` with such a name, and why.
fn exempt(path: &str) -> bool {
    // Nothing today. An entry here has to explain why the value it writes
    // cannot reach a child, or why every child may have it.
    let _ = path;
    false
}

fn rust_sources(dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            if let Ok(source) = std::fs::read_to_string(&path) {
                out.push((path.display().to_string(), source));
            }
        }
    }
}

/// Every `set_var(` call in `source`, as (line number, the whole call's first line).
fn set_var_calls(source: &str) -> Vec<(usize, &str)> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let trimmed = line.trim_start();
            !trimmed.starts_with("//") && line.contains("set_var(")
        })
        .map(|(index, line)| (index + 1, line))
        .collect()
}

fn names_a_secret(line: &str) -> bool {
    let upper = line.to_ascii_uppercase();
    SECRET_KEY_FRAGMENTS
        .iter()
        .any(|fragment| upper.contains(fragment))
}

#[test]
fn no_credential_is_written_into_the_process_environment() {
    let mut sources = Vec::new();
    rust_sources(Path::new("src"), &mut sources);
    assert!(
        sources.len() > 40,
        "the scan found only {} Rust files, so it is looking in the wrong place",
        sources.len()
    );

    let mut offenders = Vec::new();
    for (path, source) in &sources {
        if exempt(path) {
            continue;
        }
        for (line_number, line) in set_var_calls(source) {
            if names_a_secret(line) {
                offenders.push(format!("{path}:{line_number}: {}", line.trim()));
            }
        }
    }

    assert_eq!(
        offenders,
        Vec::<String>::new(),
        "every child process inherits this. Publish to carpe_diem::local_session \
         instead, or set the variable on the one child's Command rather than on \
         this process."
    );
}

#[test]
fn the_scanner_would_catch_the_line_that_started_this() {
    // A scan that silently matched nothing would pass forever, which is the one
    // way a test like this fails quietly. This is the exact line that was in
    // sidecar.rs.
    let sample = r#"
        fn start() {
            std::env::set_var("OS_JUNE_LOCAL_DEV_BEARER_TOKEN", &token);
        }
    "#;
    let found = set_var_calls(sample);
    assert_eq!(found.len(), 1);
    assert!(names_a_secret(found[0].1));

    // And that it does not flag an ordinary one.
    let benign = r#"std::env::set_var("RUST_LOG", "info");"#;
    assert!(!names_a_secret(benign));
}
