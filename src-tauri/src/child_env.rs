//! What a child process is allowed to inherit.
//!
//! The app spawns a lot of children: the Hermes runtime, MCP servers it
//! launches on the runtime's behalf, Swift helpers for dictation and system
//! audio, and small system utilities. Every one of them inherits the app's
//! environment, which is why the sidecar's bearer token no longer lives there
//! (see `carpe_diem::local_session`).
//!
//! That removed the leak at its source. This is the second line, for the
//! children that matter most — the ones that run code the app did not write,
//! for as long as a session lasts. It strips the variables a backend
//! credential could ever travel in, so a helper compromised through some other
//! path finds nothing useful in its own environment.
//!
//! Deliberately a denylist of prefixes rather than an allowlist of names: an
//! allowlist would have to enumerate PATH, HOME, LANG, TMPDIR, the Homebrew
//! and Python variables Hermes needs, and every one a future runtime adds —
//! and the first time one was missing, the symptom would be a runtime that
//! fails to start for reasons nobody connects to this file. The denylist is
//! the part we actually know something about.

use std::process::Command;

/// Variable prefixes that may carry a credential or the address of the local
/// backend. Matched case-sensitively: environment variables are.
const STRIPPED_PREFIXES: &[&str] = &[
    // The local backend's address and bearer, published in process memory now
    // but stripped anyway so a reintroduction cannot reach a child.
    "OS_JUNE_LOCAL_DEV",
    "JUNE_API_URL",
    // june-api's own Figment configuration, which carries the upstream key.
    "JUNE__",
    // The debug-only keychain bypass, and anything else keyed to the operator.
    "SUBROSA_DEV_",
    "CARPE_DIEM_",
];

/// Whether `key` names something a child has no business inheriting.
pub fn is_stripped(key: &str) -> bool {
    STRIPPED_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

/// Removes every credential-shaped variable from `command`'s environment.
///
/// Call this on any child that outlives a single syscall, before `spawn`.
/// Children that need one of these variables — only the sidecar does — set it
/// explicitly afterwards, so the order matters and the intent is visible.
pub fn scrub(command: &mut Command) {
    // Two sources, and both matter. The process environment is what the child
    // would inherit; the command's own overrides are what a caller set on it
    // before reaching here. Scrubbing only the first would leave a variable
    // that an earlier line explicitly added, which is the harder mistake to
    // see and the easier one to make.
    let mut doomed: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_os_string()))
        .filter(|key| key.to_str().is_some_and(is_stripped))
        .collect();
    doomed.sort();
    doomed.dedup();
    for key in doomed {
        command.env_remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_shaped_names_are_recognized() {
        for key in [
            "OS_JUNE_LOCAL_DEV",
            "OS_JUNE_LOCAL_DEV_BEARER_TOKEN",
            "OS_JUNE_LOCAL_DEV_USER_ID",
            "JUNE_API_URL",
            "JUNE__UPSTREAMS__VENICE__API_KEY",
            "JUNE__LOCAL_DEV__BEARER_TOKEN",
            "SUBROSA_DEV_API_KEY",
            "CARPE_DIEM_PLACES_KEY",
        ] {
            assert!(is_stripped(key), "{key} should not reach a child");
        }
    }

    #[test]
    fn ordinary_names_are_left_alone() {
        // Stripping one of these would break the Hermes runtime in a way that
        // looks like anything except an environment problem.
        for key in [
            "PATH",
            "HOME",
            "LANG",
            "TMPDIR",
            "SHELL",
            "USER",
            "PYTHONPATH",
            "VIRTUAL_ENV",
            "HOMEBREW_PREFIX",
            "SSL_CERT_FILE",
            "JUNE_HERMES_SOURCE_TARBALL_SHA256",
        ] {
            assert!(!is_stripped(key), "{key} must still be inherited");
        }
    }

    #[test]
    fn scrub_removes_the_variable_from_the_child_environment() {
        // Set on the command rather than on this process: a test that mutates
        // the process environment races every other test in the binary.
        let mut command = Command::new("/usr/bin/env");
        command.env("OS_JUNE_LOCAL_DEV_BEARER_TOKEN", "must-not-survive");
        command.env("PATH", "/usr/bin");
        scrub(&mut command);
        // `scrub` removes by name, so the explicit `env` above is undone too —
        // which is the point: a variable a caller set is still a variable the
        // child would see.
        let inherited: Vec<String> = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|_| key.to_string_lossy().into_owned()))
            .collect();
        assert!(
            !inherited
                .iter()
                .any(|key| key == "OS_JUNE_LOCAL_DEV_BEARER_TOKEN"),
            "the token must not survive a scrub"
        );
        assert!(inherited.iter().any(|key| key == "PATH"));
    }
}
