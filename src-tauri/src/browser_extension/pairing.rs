//! Which browsers may talk to the app (ADR-0100).
//!
//! Registering the native messaging host lets the browser start the relay;
//! it does not let the extension do anything. Pairing does: Settings ›
//! Browser extension shows a six-digit code, the person types it into the
//! extension, and the app answers with a token only that extension keeps.
//! Every later request carries the token, and the app checks it against the
//! origin the relay reported, so a token copied into another extension is
//! worth nothing.
//!
//! The code is a moment, not a record: it lives in memory, for five minutes
//! and five guesses. What is kept (`browser-extension.json`) is the hash of
//! each token, never the token, and the browsers the host was registered
//! for, so a moved or updated app can rewrite the manifests at launch.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::host_manifest::Browser;

pub const CODE_DIGITS: usize = 6;
const CODE_LIFETIME_MINUTES: i64 = 5;
const CODE_ATTEMPTS: u8 = 5;
const MAX_LABEL_CHARS: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedBrowser {
    pub id: String,
    /// What the extension said it runs in ("chrome", "edge", "firefox"...).
    pub browser: String,
    /// `chrome-extension://<id>/` or the Firefox add-on id, as the relay saw it.
    pub origin: String,
    pub token_hash: String,
    pub paired_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCode {
    pub code: String,
    pub expires_at: DateTime<Utc>,
    attempts_left: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairError {
    /// Nobody pressed "Connect a browser" in the app.
    NoCode,
    Expired,
    Wrong,
    /// Five wrong guesses: the code is gone and a new one has to be shown.
    Exhausted,
}

impl PairError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoCode => "pairing_not_started",
            Self::Expired => "pairing_expired",
            Self::Wrong => "pairing_wrong_code",
            Self::Exhausted => "pairing_exhausted",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NoCode => {
                "Open Sub Rosa's settings, choose Browser extension, then Connect a browser."
            }
            Self::Expired => "That code expired. Show a new one in Sub Rosa's settings.",
            Self::Wrong => "That code is not the one Sub Rosa shows.",
            Self::Exhausted => "Too many wrong codes. Show a new one in Sub Rosa's settings.",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingBook {
    #[serde(default)]
    pub browsers: Vec<PairedBrowser>,
    /// Browsers whose host manifest the app wrote.
    #[serde(default)]
    pub registered: Vec<Browser>,
    #[serde(skip)]
    pending: Option<PendingCode>,
}

impl PairingBook {
    /// Shows a new code, replacing any earlier one.
    pub fn begin(&mut self, code: String, now: DateTime<Utc>) -> PendingCode {
        let pending = PendingCode {
            code,
            expires_at: now + Duration::minutes(CODE_LIFETIME_MINUTES),
            attempts_left: CODE_ATTEMPTS,
        };
        self.pending = Some(pending.clone());
        pending
    }

    pub fn cancel(&mut self) {
        self.pending = None;
    }

    /// The code still waiting to be typed, if any.
    pub fn pending(&self, now: DateTime<Utc>) -> Option<&PendingCode> {
        self.pending.as_ref().filter(|code| code.expires_at > now)
    }

    /// Trades the code for a browser entry holding `token`'s hash. The code
    /// is spent on success, so it pairs one browser.
    pub fn redeem(
        &mut self,
        typed: &str,
        origin: &str,
        browser: Option<&str>,
        token: &str,
        now: DateTime<Utc>,
    ) -> Result<PairedBrowser, PairError> {
        let Some(pending) = self.pending.as_mut() else {
            return Err(PairError::NoCode);
        };
        if pending.expires_at <= now {
            self.pending = None;
            return Err(PairError::Expired);
        }
        let typed = normalise_code(typed);
        if !bool::from(typed.as_bytes().ct_eq(pending.code.as_bytes())) {
            pending.attempts_left = pending.attempts_left.saturating_sub(1);
            if pending.attempts_left == 0 {
                self.pending = None;
                return Err(PairError::Exhausted);
            }
            return Err(PairError::Wrong);
        }
        self.pending = None;
        let stamp = now.to_rfc3339();
        let entry = PairedBrowser {
            id: uuid::Uuid::new_v4().to_string(),
            browser: browser_label(browser),
            origin: origin.to_string(),
            token_hash: hash_token(token),
            paired_at: stamp.clone(),
            last_seen_at: stamp,
        };
        // One entry per extension: pairing again replaces the old token.
        self.browsers.retain(|existing| existing.origin != origin);
        self.browsers.push(entry.clone());
        Ok(entry)
    }

    /// The paired browser this token belongs to, when it came from the
    /// extension it was given to.
    pub fn authenticate(
        &mut self,
        token: &str,
        origin: &str,
        now: DateTime<Utc>,
    ) -> Option<String> {
        let hash = hash_token(token);
        let entry = self.browsers.iter_mut().find(|entry| {
            bool::from(entry.token_hash.as_bytes().ct_eq(hash.as_bytes())) && entry.origin == origin
        })?;
        entry.last_seen_at = now.to_rfc3339();
        Some(entry.id.clone())
    }

    pub fn forget(&mut self, id: &str) -> bool {
        let before = self.browsers.len();
        self.browsers.retain(|entry| entry.id != id);
        self.browsers.len() != before
    }
}

/// Digits only: "123 456" and "123-456" are the code the screen shows.
pub fn normalise_code(typed: &str) -> String {
    typed.chars().filter(char::is_ascii_digit).collect()
}

pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn browser_label(browser: Option<&str>) -> String {
    let label: String = browser
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-')
        .take(MAX_LABEL_CHARS)
        .collect();
    if label.is_empty() {
        "browser".to_string()
    } else {
        label.to_ascii_lowercase()
    }
}

/// A fresh six-digit code.
pub fn fresh_code() -> String {
    use rand::Rng as _;
    let mut rng = rand::rng();
    (0..CODE_DIGITS)
        .map(|_| char::from(b'0' + rng.random_range(0..10u8)))
        .collect()
}

/// A fresh token: 32 random bytes, URL-safe base64.
pub fn fresh_token() -> String {
    use base64::Engine as _;
    use rand::RngCore as _;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "chrome-extension://aphalahbhpimjbfdkjkdfgfbohboceig/";

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-08T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn a_code_pairs_one_browser_once() {
        let mut book = PairingBook::default();
        book.begin("123456".into(), now());
        let entry = book
            .redeem("123 456", ORIGIN, Some("Chrome"), "tok", now())
            .unwrap();
        assert_eq!(entry.browser, "chrome");
        assert_ne!(entry.token_hash, "tok", "the token itself is never kept");
        assert_eq!(
            book.redeem("123456", ORIGIN, None, "tok2", now()),
            Err(PairError::NoCode)
        );
        assert!(book.pending(now()).is_none());
    }

    #[test]
    fn a_code_expires_after_five_minutes() {
        let mut book = PairingBook::default();
        book.begin("123456".into(), now());
        let later = now() + Duration::minutes(5);
        assert!(book.pending(later).is_none());
        assert_eq!(
            book.redeem("123456", ORIGIN, None, "tok", later),
            Err(PairError::Expired)
        );
    }

    #[test]
    fn five_wrong_guesses_burn_the_code() {
        let mut book = PairingBook::default();
        book.begin("123456".into(), now());
        for _ in 0..4 {
            assert_eq!(
                book.redeem("000000", ORIGIN, None, "tok", now()),
                Err(PairError::Wrong)
            );
        }
        assert_eq!(
            book.redeem("000000", ORIGIN, None, "tok", now()),
            Err(PairError::Exhausted)
        );
        // Even the right code is useless now.
        assert_eq!(
            book.redeem("123456", ORIGIN, None, "tok", now()),
            Err(PairError::NoCode)
        );
    }

    #[test]
    fn a_token_only_works_from_the_extension_it_was_given_to() {
        let mut book = PairingBook::default();
        book.begin("123456".into(), now());
        let entry = book.redeem("123456", ORIGIN, None, "tok", now()).unwrap();
        let later = now() + Duration::hours(1);
        assert_eq!(
            book.authenticate("tok", ORIGIN, later),
            Some(entry.id.clone())
        );
        assert_eq!(book.browsers[0].last_seen_at, later.to_rfc3339());
        assert_eq!(
            book.authenticate("tok", "chrome-extension://other/", later),
            None
        );
        assert_eq!(book.authenticate("wrong", ORIGIN, later), None);
        assert!(book.forget(&entry.id));
        assert_eq!(book.authenticate("tok", ORIGIN, later), None);
    }

    #[test]
    fn pairing_again_replaces_the_old_token() {
        let mut book = PairingBook::default();
        book.begin("111111".into(), now());
        book.redeem("111111", ORIGIN, None, "old", now()).unwrap();
        book.begin("222222".into(), now());
        book.redeem("222222", ORIGIN, None, "new", now()).unwrap();
        assert_eq!(book.browsers.len(), 1);
        assert_eq!(book.authenticate("old", ORIGIN, now()), None);
        assert!(book.authenticate("new", ORIGIN, now()).is_some());
    }

    #[test]
    fn the_saved_book_has_no_code_and_no_token() {
        let mut book = PairingBook::default();
        book.begin("123456".into(), now());
        book.redeem("123456", ORIGIN, None, "secret-token", now())
            .unwrap();
        book.begin("654321".into(), now());
        let json = serde_json::to_string(&book).unwrap();
        assert!(!json.contains("secret-token"));
        assert!(!json.contains("654321"));
        let back: PairingBook = serde_json::from_str(&json).unwrap();
        assert_eq!(back.browsers, book.browsers);
    }

    #[test]
    fn fresh_codes_and_tokens_have_their_shape() {
        let code = fresh_code();
        assert_eq!(code.len(), CODE_DIGITS);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(fresh_token().len(), 43);
        assert_ne!(fresh_token(), fresh_token());
    }
}
