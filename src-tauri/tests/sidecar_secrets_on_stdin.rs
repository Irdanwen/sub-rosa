//! The backend child receives its credentials on a pipe, not in its
//! environment.
//!
//! `docs/threat-model.md` listed "another local process reading the sidecar's
//! environment" as out of scope, because the upstream key travelled as
//! `JUNE__UPSTREAMS__VENICE__API_KEY` and a same-user process can read another
//! process's environment with `ps eww`. The one reason not to fix it was that
//! the fix touches `june-api/`, which every upstream merge would re-merge;
//! ADR 0040 ended the merges. The key and the session bearer now go down the
//! child's stdin (`JUNE_SECRETS_ON_STDIN`), and this scan makes sure neither
//! returns to `.env(...)`.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::fs;

const SIDECAR: &str = "src/carpe_diem/sidecar.rs";

/// The two values that must never be an environment variable of the child.
const FORBIDDEN_ENV_KEYS: &[&str] = &[
    "JUNE__UPSTREAMS__VENICE__API_KEY",
    "JUNE__LOCAL_DEV__BEARER_TOKEN",
];

#[test]
fn the_sidecar_never_puts_a_credential_in_its_childs_environment() {
    let source = fs::read_to_string(SIDECAR).expect("sidecar source");
    for (number, line) in source.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") {
            continue;
        }
        for key in FORBIDDEN_ENV_KEYS {
            assert!(
                !(line.contains(".env(") && line.contains(key)),
                "{SIDECAR}:{}: `{key}` is passed through the environment again; write it to the child's stdin instead (see JUNE_SECRETS_ON_STDIN)",
                number + 1
            );
        }
    }
    assert!(
        source.contains("JUNE_SECRETS_ON_STDIN"),
        "{SIDECAR} no longer asks the backend to read its secrets from stdin"
    );
}
