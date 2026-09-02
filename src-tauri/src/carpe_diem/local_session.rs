//! Where this run's backend lives, and the token that opens it.
//!
//! This used to be four `std::env::set_var` calls. The environment is the one
//! piece of process state that is **copied into every child**, so writing the
//! sidecar's bearer token there handed it to the Hermes runtime, the Swift
//! dictation and system-audio helpers, and `sandbox-exec` itself. The macOS
//! sandbox profile bounds what a helper can read from disk; it does not bound
//! what it can send to a loopback port. Any one of those processes could talk
//! to the inference backend as the user, and the app had no way to tell.
//!
//! So the session lives here instead: in process memory, readable by the code
//! that needs it and inherited by nothing. `carpe_diem::sidecar` is the only
//! writer, exactly as before — what changed is the channel, not the shape.
//!
//! The environment is still *read* as a fallback, and that is not the same
//! risk: `pnpm tauri:dev` against a hand-started `june-api` sets
//! `OS_JUNE_LOCAL_DEV*` in a `.env`, and a value the developer put there is
//! one they already have. Reading does not copy a secret outward; writing
//! does.

use std::sync::RwLock;

use crate::redacted::Redacted;

/// What the sidecar published for this run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalSession {
    /// Loopback base URL of the running backend.
    pub api_url: String,
    /// Bearer accepted by that backend, for this run only. Wrapped so a
    /// `{session:?}` added while debugging prints the URL and masks the token.
    pub bearer_token: Redacted<String>,
    /// The local user id the backend attributes work to.
    pub user_id: String,
}

static SESSION: RwLock<Option<LocalSession>> = RwLock::new(None);

/// A fresh bearer for one run of the backend: 256 bits of CSPRNG, hex-encoded.
///
/// Nothing reads structure out of this, so it is bytes rather than a UUID.
pub fn new_bearer_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Records the backend this run talks to. Called once the child is up, never
/// before: a URL published early would point requests at a dead port.
pub fn publish(session: LocalSession) {
    if let Ok(mut guard) = SESSION.write() {
        *guard = Some(session);
    }
}

/// Forgets the session. The sidecar calls this when its child dies, so a
/// request made in the gap fails closed instead of aiming at a stale port.
pub fn clear() {
    if let Ok(mut guard) = SESSION.write() {
        *guard = None;
    }
}

/// The current session, if the sidecar has published one.
pub fn current() -> Option<LocalSession> {
    SESSION.read().ok().and_then(|guard| guard.clone())
}

/// Base URL of the running backend.
pub fn api_url() -> Option<String> {
    current().map(|session| session.api_url)
}

/// Bearer for this run.
pub fn bearer_token() -> Option<String> {
    current().map(|session| session.bearer_token.into_inner())
}

/// Whether there is a backend to talk to at all.
pub fn is_active() -> bool {
    current().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The session is one global, so the tests that mutate it take turns.
    /// Without this they race each other, which reads as a flaky assertion
    /// rather than as what it is.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn sample(token: &str) -> LocalSession {
        LocalSession {
            api_url: "http://127.0.0.1:4321".to_string(),
            bearer_token: Redacted::new(token.to_string()),
            user_id: "local".to_string(),
        }
    }

    #[test]
    fn a_bearer_token_is_256_bits_of_hex() {
        let token = new_bearer_token();
        assert_eq!(token.len(), 64, "32 bytes, two hex characters each");
        assert!(token
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_ne!(token, new_bearer_token(), "two runs must not share a token");
    }

    #[test]
    fn a_published_session_is_readable_and_clearable() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        clear();
        assert!(!is_active());
        assert!(api_url().is_none());

        publish(sample("token-a"));
        assert!(is_active());
        assert_eq!(api_url().as_deref(), Some("http://127.0.0.1:4321"));
        assert_eq!(bearer_token().as_deref(), Some("token-a"));

        // A restart replaces rather than accumulates.
        publish(sample("token-b"));
        assert_eq!(bearer_token().as_deref(), Some("token-b"));

        clear();
        assert!(!is_active());
        assert!(bearer_token().is_none());
    }

    #[test]
    fn a_printed_session_masks_its_token() {
        let session = sample("cdm-sentinel-token");
        let printed = format!("{session:?}");
        assert!(!printed.contains("sentinel"), "leaked: {printed}");
        assert!(
            printed.contains("127.0.0.1"),
            "the address is still readable"
        );
    }

    #[test]
    fn publishing_never_writes_the_token_into_the_environment() {
        let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        clear();
        publish(sample("must-not-leak"));
        for key in [
            "OS_JUNE_LOCAL_DEV_BEARER_TOKEN",
            "JUNE__LOCAL_DEV__BEARER_TOKEN",
        ] {
            assert_ne!(
                std::env::var(key).unwrap_or_default(),
                "must-not-leak",
                "{key} must not carry the session token: every child process inherits it"
            );
        }
        clear();
    }
}
