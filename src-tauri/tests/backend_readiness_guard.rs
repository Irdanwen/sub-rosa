//! One resolver decides whether the local backend is reachable.
//!
//! `carpe_diem::sidecar::ensure_ready_for_request` holds a request back until
//! the backend has published an address, and `june_api::june_api_url` is what
//! the request then resolves. For a while those were two different questions:
//! the guard read `JUNE_API_URL` from the environment while the resolver read
//! the in-process session. When the session moved out of the environment (so a
//! child process could not inherit the bearer token) the guard's answer became
//! "not yet" forever, and every desktop request — every thirty-second chunk of
//! a transcription — slept out the full twenty-second start timeout first. A
//! fifty-six minute recording took forty-seven minutes to process, of which
//! thirty-nine were sleep.
//!
//! Nothing failed, so nothing was noticed. The fix is one resolver; this test
//! is what keeps it one. It is a source scan, which is blunt, and blunt is
//! right: the mistake is a single plausible line, and no runtime test catches
//! it unless it happens to run with a key configured and a session published.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::path::Path;

/// The one module allowed to ask the environment for the backend address: it
/// is the resolver, and the environment is its documented developer fallback
/// (`pnpm tauri:dev` against a backend started by hand).
const RESOLVER: &str = "june_api.rs";

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

fn sources() -> Vec<(String, String)> {
    let mut out = Vec::new();
    rust_sources(Path::new("src"), &mut out);
    assert!(
        out.len() > 20,
        "the scan found almost no sources; it is looking in the wrong place"
    );
    out
}

/// A line that reads the backend address out of the environment, rather than
/// asking the resolver. `option_env!` is compile-time and belongs to the
/// resolver too, so both shapes count.
fn reads_url_from_env(line: &str) -> bool {
    let line = line.trim();
    if line.starts_with("//") || line.starts_with("///") {
        return false;
    }
    (line.contains("env::var(") || line.contains("option_env!(")) && line.contains("JUNE_API_URL")
}

#[test]
fn only_the_resolver_reads_the_backend_url_from_the_environment() {
    let mut offenders = Vec::new();
    for (path, source) in sources() {
        if path.ends_with(RESOLVER) {
            continue;
        }
        for (index, line) in source.lines().enumerate() {
            if reads_url_from_env(line) {
                offenders.push(format!("{path}:{}: {}", index + 1, line.trim()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these ask the environment for the backend address instead of \
         june_api::backend_url_published(), which is how the readiness guard \
         drifted from the resolver and made every request sleep:\n{}",
        offenders.join("\n")
    );
}

#[test]
fn the_readiness_guard_asks_the_resolver() {
    let guard = std::fs::read_to_string("src/carpe_diem/sidecar.rs")
        .expect("the sidecar module must be readable");
    // There are two guards in this file; the mobile twin probes /livez and is
    // not the one that broke. Anchor on the desktop attribute.
    let body = guard
        .split_once("#[cfg(desktop)]\npub async fn ensure_ready_for_request()")
        .map(|(_, rest)| rest)
        .expect("the desktop readiness guard must exist");
    // Both the early return and the poll inside the wait loop have to ask.
    let asks = body.matches("backend_url_published()").count();
    assert!(
        asks >= 2,
        "the readiness guard must decide with june_api::backend_url_published(), \
         both before waiting and on each poll; found {asks} call(s)"
    );
}
