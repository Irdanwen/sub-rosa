//! Every outbound HTTP client the app builds, and the rules they share.
//!
//! Two things were left to reqwest's defaults across a dozen call sites, and
//! defaults are a poor place to keep a policy nobody has read:
//!
//! * **Redirects.** Only the import fetcher declared one. Everywhere else the
//!   default followed up to ten hops. reqwest does strip `Authorization` when a
//!   redirect changes host, so this was not a live key leak — but "the library
//!   probably handles it" is not a security property, and the app's own
//!   security note claimed it did not follow redirects at all. Now a client
//!   that carries a credential refuses to change host, and says so.
//! * **Timeouts.** A client with no deadline turns a slow upstream into a
//!   request that never returns, which on a loopback backend is the app
//!   hanging on itself. Every constructor here takes one.
//!
//! The second reason this module exists is inventory: `tests/egress.rs`
//! asserts that no client is built anywhere else, so the list of hosts this
//! binary can reach stays something a person can read rather than something
//! that has to be discovered.

use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Client, ClientBuilder};

/// Hops allowed before a redirect chain is treated as a loop.
const MAX_REDIRECTS: usize = 2;

/// A client that carries a credential — a `cdm_` key, the local bearer, a
/// GitHub token, a Places key.
///
/// It refuses to follow a redirect that changes scheme, host or port. reqwest
/// would drop the `Authorization` header on such a hop, which turns a redirect
/// into a confusing 401 instead of an error that names the cause; and a
/// same-host redirect is the only kind any of these APIs actually uses.
pub fn credentialed(timeout: Duration) -> ClientBuilder {
    Client::builder()
        .timeout(timeout)
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            let Some(previous) = attempt.previous().last() else {
                return attempt.follow();
            };
            let same_origin = previous.scheme() == attempt.url().scheme()
                && previous.host_str() == attempt.url().host_str()
                && previous.port_or_known_default() == attempt.url().port_or_known_default();
            if same_origin {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
}

/// A client for a request that carries no credential — a map tile, a public
/// catalog. Redirects across hosts are allowed, but bounded.
pub fn anonymous(timeout: Duration) -> ClientBuilder {
    Client::builder()
        .timeout(timeout)
        .redirect(Policy::limited(MAX_REDIRECTS))
}

/// A client for the loopback backend. Same rules as [`credentialed`]; named
/// separately because a redirect off loopback is not a policy question, it is
/// something going badly wrong.
pub fn loopback(timeout: Duration) -> ClientBuilder {
    credentialed(timeout)
}

/// Builds a configured client, naming what it is for if that fails.
///
/// reqwest only fails here when the TLS backend cannot initialize, in which
/// case no request will succeed either way. The old fallback was
/// `reqwest::Client::new()`, which silently dropped the timeout and the
/// redirect policy — and panics on exactly the same condition. This one logs,
/// and degrades to a client that follows no redirect at all: if the app is
/// going to be broken, it should be broken in the safe direction.
pub fn build(builder: ClientBuilder, purpose: &'static str) -> Client {
    match builder.build() {
        Ok(client) => client,
        Err(error) => {
            tracing::error!(%error, purpose, "could not build an HTTP client");
            Client::builder()
                .redirect(Policy::none())
                .build()
                .unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_constructor_produces_a_client() {
        let timeout = Duration::from_secs(5);
        assert!(credentialed(timeout).build().is_ok());
        assert!(anonymous(timeout).build().is_ok());
        assert!(loopback(timeout).build().is_ok());
    }

    #[test]
    fn build_names_its_purpose_and_always_returns_a_client() {
        let client = build(credentialed(Duration::from_secs(5)), "test");
        // Nothing to assert about a Client's internals; the point is that the
        // call site never has to reach for `Client::new()` to recover.
        drop(client);
    }
}
