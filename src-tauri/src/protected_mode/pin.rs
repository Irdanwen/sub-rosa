//! The protected mode PIN: four to six digits, kept only as a salted scrypt
//! hash, compared in constant time, and throttled in process (ADR-0084).
//!
//! A PIN this short cannot resist someone who can read the settings file and
//! try a million candidates offline. The hash keeps it from being read at a
//! glance, not from a determined attack; the ADR says so.

use crate::domain::types::AppError;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq as _;

const SALT_BYTES: usize = 16;
const HASH_BYTES: usize = 32;
/// scrypt N = 2^15, r = 8, p = 1: 32 MiB and roughly a tenth of a second on a
/// phone, the interactive-login setting.
const DEFAULT_LOG_N: u8 = 15;
const DEFAULT_R: u32 = 8;
const DEFAULT_P: u32 = 1;
/// Wrong PINs in a row before the next try has to wait.
const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(30);

/// What the settings file keeps of the PIN.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinHash {
    pub log_n: u8,
    pub r: u32,
    pub p: u32,
    /// Base64, standard alphabet.
    pub salt: String,
    pub hash: String,
}

/// Four to six ASCII digits, nothing else.
pub fn validate(pin: &str) -> Result<(), AppError> {
    let digits = (4..=6).contains(&pin.len()) && pin.bytes().all(|byte| byte.is_ascii_digit());
    if digits {
        Ok(())
    } else {
        Err(AppError::new(
            "protected_mode_pin_format",
            "Use a PIN of 4 to 6 digits.",
        ))
    }
}

pub fn hash(pin: &str) -> Result<PinHash, AppError> {
    hash_with(pin, DEFAULT_LOG_N, DEFAULT_R, DEFAULT_P)
}

pub(super) fn hash_with(pin: &str, log_n: u8, r: u32, p: u32) -> Result<PinHash, AppError> {
    let salt: [u8; SALT_BYTES] = rand::random();
    let derived = derive(pin, &salt, log_n, r, p).ok_or_else(failed)?;
    let engine = base64::engine::general_purpose::STANDARD;
    Ok(PinHash {
        log_n,
        r,
        p,
        salt: engine.encode(salt),
        hash: engine.encode(derived),
    })
}

/// Whether `pin` is the one `stored` was made from. A stored record that does
/// not parse, or asks for parameters outside a sane range (a hand edit that
/// would make every check allocate gigabytes), matches nothing.
pub fn matches(pin: &str, stored: &PinHash) -> bool {
    let engine = base64::engine::general_purpose::STANDARD;
    let sane = (4..=20).contains(&stored.log_n)
        && (1..=16).contains(&stored.r)
        && (1..=4).contains(&stored.p);
    let (Ok(salt), Ok(expected)) = (engine.decode(&stored.salt), engine.decode(&stored.hash))
    else {
        return false;
    };
    if !sane || expected.len() != HASH_BYTES {
        return false;
    }
    derive(pin, &salt, stored.log_n, stored.r, stored.p)
        .is_some_and(|derived| bool::from(derived.ct_eq(expected.as_slice())))
}

fn derive(pin: &str, salt: &[u8], log_n: u8, r: u32, p: u32) -> Option<[u8; HASH_BYTES]> {
    let params = scrypt::Params::new(log_n, r, p, HASH_BYTES).ok()?;
    let mut out = [0u8; HASH_BYTES];
    scrypt::scrypt(pin.as_bytes(), salt, &params, &mut out).ok()?;
    Some(out)
}

fn failed() -> AppError {
    AppError::new(
        "protected_mode_pin_failed",
        "Could not secure the PIN. Try again.",
    )
}

// --- Throttle -----------------------------------------------------------------

/// Wrong guesses in a row, and until when the next one is refused. In process
/// only: a restart clears it, which is acceptable for a guard against casual
/// change (ADR-0084).
#[derive(Debug, Default)]
pub(super) struct Throttle {
    failures: u32,
    locked_until: Option<Instant>,
}

impl Throttle {
    /// Refuses while a lockout is running.
    pub(super) fn check(&mut self, now: Instant) -> Result<(), AppError> {
        match self.locked_until {
            Some(until) if now < until => Err(AppError::new(
                "protected_mode_locked",
                "Too many wrong PINs. Wait 30 seconds, then try again.",
            )),
            Some(_) => {
                self.locked_until = None;
                self.failures = 0;
                Ok(())
            }
            None => Ok(()),
        }
    }

    pub(super) fn record(&mut self, ok: bool, now: Instant) {
        if ok {
            *self = Self::default();
            return;
        }
        self.failures += 1;
        if self.failures >= MAX_FAILURES {
            self.locked_until = Some(now + LOCKOUT);
        }
    }
}

pub(super) static THROTTLE: Mutex<Throttle> = Mutex::new(Throttle {
    failures: 0,
    locked_until: None,
});

#[cfg(test)]
mod tests {
    use super::*;

    /// Cheap parameters, so the tests do not spend a second per hash.
    fn quick(pin: &str) -> PinHash {
        hash_with(pin, 4, 1, 1).unwrap()
    }

    #[test]
    fn only_four_to_six_digits_are_a_pin() {
        for ok in ["0000", "12345", "987654"] {
            assert!(validate(ok).is_ok(), "{ok}");
        }
        for bad in ["", "123", "1234567", "12a4", " 1234", "１２３４", "12 34"] {
            assert_eq!(
                validate(bad).unwrap_err().code,
                "protected_mode_pin_format",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_hash_is_salted_and_matches_only_its_pin() {
        let first = quick("2468");
        let second = quick("2468");
        assert_ne!(first.salt, second.salt);
        assert_ne!(first.hash, second.hash);
        assert!(!first.hash.contains("2468"));
        assert!(matches("2468", &first));
        assert!(matches("2468", &second));
        assert!(!matches("2469", &first));
        assert!(!matches("", &first));
    }

    #[test]
    fn a_damaged_or_extravagant_record_matches_nothing() {
        let good = quick("1357");
        let bad_salt = PinHash {
            salt: "not base64!".to_string(),
            ..good.clone()
        };
        assert!(!matches("1357", &bad_salt));
        let short = PinHash {
            hash: base64::engine::general_purpose::STANDARD.encode([0u8; 8]),
            ..good.clone()
        };
        assert!(!matches("1357", &short));
        let huge = PinHash { log_n: 40, ..good };
        assert!(!matches("1357", &huge));
    }

    #[test]
    fn the_default_parameters_round_trip() {
        let stored = hash("4321").unwrap();
        assert_eq!(stored.log_n, DEFAULT_LOG_N);
        assert!(matches("4321", &stored));
    }

    #[test]
    fn five_wrong_pins_lock_the_next_try_for_a_while() {
        let start = Instant::now();
        let mut throttle = Throttle::default();
        for _ in 0..MAX_FAILURES - 1 {
            throttle.check(start).unwrap();
            throttle.record(false, start);
        }
        throttle.check(start).unwrap();
        throttle.record(false, start);
        assert_eq!(
            throttle.check(start).unwrap_err().code,
            "protected_mode_locked"
        );
        assert!(throttle
            .check(start + LOCKOUT - Duration::from_secs(1))
            .is_err());
        assert!(throttle.check(start + LOCKOUT).is_ok());
        // The lockout spent, the count starts again.
        throttle.record(false, start + LOCKOUT);
        assert!(throttle.check(start + LOCKOUT).is_ok());
        // A right PIN clears everything.
        throttle.record(true, start + LOCKOUT);
        assert_eq!(throttle.failures, 0);
    }
}
