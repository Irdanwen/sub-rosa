//! A secret that cannot be printed by accident.
//!
//! Nothing in this app logs a credential today. That is a fact about the code
//! as written, held up by review, and review is the wrong thing to be holding
//! it up: `tracing::debug!("{config:?}")` is one line, it is the line anybody
//! reaches for while chasing a bug, and it prints every field of the struct it
//! is handed. The failure has no symptom — the app works, the log looks fine,
//! and the key is in a file the user may later attach to a bug report.
//!
//! [`Redacted`] moves that from a habit to a type. Its `Debug` prints a mask,
//! and it deliberately implements **no** `Display`: `reqwest`'s `bearer_auth`
//! takes `impl Display`, so a `Display` that printed the mask would compile and
//! then send the string `[redacted]` as the credential — a bug far worse than
//! the one this prevents. Reading the value is `expose()`, which is a word a
//! reviewer notices.

use std::fmt;

/// A value that must not reach a log, a panic message, or a serialized DTO.
#[derive(Clone, PartialEq, Eq)]
pub struct Redacted<T>(T);

impl<T> Redacted<T> {
    /// Wraps a secret.
    pub fn new(value: T) -> Self {
        Self(value)
    }

    /// The value itself. Named to be conspicuous at the call site: every use is
    /// a place where a secret leaves this type's protection.
    pub fn expose(&self) -> &T {
        &self.0
    }

    /// The value, consuming the wrapper.
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl Redacted<String> {
    /// The secret as a string slice, for the one thing every caller does with
    /// it: hand it to an HTTP client.
    pub fn expose_str(&self) -> &str {
        self.0.as_str()
    }

    /// Whether there is anything here at all. Safe to log.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<T> fmt::Debug for Redacted<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[redacted]")
    }
}

impl<T> From<T> for Redacted<T> {
    fn from(value: T) -> Self {
        Self(value)
    }
}

/// Compile-time proof that `Redacted` does not implement `Display`.
///
/// This matters more than it looks. `reqwest`'s `bearer_auth` takes an
/// `impl Display`, so a `Display` that printed the mask would compile at every
/// call site and then send the literal string `[redacted]` as the credential:
/// every request 401s, and nothing in the code reads as the cause. Reading the
/// value has to stay an explicit `expose_str()`.
///
/// The mechanism is inherent-impl precedence. `Probe<T>` gets `IS_DISPLAY` from
/// the blanket trait below unless `T: Display`, in which case the inherent
/// `impl` shadows it — so the constant is `true` exactly when the impl exists,
/// and [`assert_not_display`] refuses to compile if it ever does.
mod display_probe {
    use std::fmt::Display;
    use std::marker::PhantomData;

    pub struct Probe<T>(PhantomData<T>);

    pub trait NotDisplay {
        const IS_DISPLAY: bool = false;
    }
    impl<T> NotDisplay for Probe<T> {}

    impl<T: Display> Probe<T> {
        #[allow(
            dead_code,
            reason = "read at concrete types; the inherent const is selected only when T: Display, so a build where nothing is Display never reads it"
        )]
        pub const IS_DISPLAY: bool = true;
    }

    // The probe must be read at a CONCRETE type. Inside a generic `const fn`
    // the compiler cannot see whether the bound holds, so it falls back to the
    // trait constant and the probe answers `false` for everything — which is
    // exactly the silent-pass a guard like this must not have.
}

// Evaluated at compile time: if `Redacted<String>` ever gains a `Display`, the
// build stops here rather than at a 401 nobody can explain.
const _: () = {
    // In scope so the trait constant is the fallback when the inherent impl
    // does not apply. Inherent impls are still resolved first.
    use display_probe::NotDisplay as _;
    assert!(
        !display_probe::Probe::<Redacted<String>>::IS_DISPLAY,
        "Redacted must not implement Display: bearer_auth takes an impl Display, \
         so a mask would be sent as the credential. Use expose_str() instead."
    );
};

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape that actually leaks: a config struct printed whole.
    #[derive(Debug)]
    #[allow(dead_code, reason = "the fields exist to be printed by Debug")]
    struct Config {
        base_url: String,
        api_key: Redacted<String>,
    }

    /// A probe that answered `false` for everything would make the compile-time
    /// assertion above pass forever, which is the one way a guard like it fails
    /// quietly. These are the checks that it can say `true` — and they are
    /// `const` rather than `#[test]` on purpose: they are facts about types, so
    /// a wrong answer should stop the build, not one test run.
    mod probe_is_honest {
        use super::super::display_probe::{NotDisplay as _, Probe};
        use super::super::Redacted;

        const _: () = assert!(
            Probe::<String>::IS_DISPLAY,
            "String implements Display; a probe that misses it proves nothing"
        );
        const _: () = assert!(Probe::<u32>::IS_DISPLAY);
        const _: () = assert!(!Probe::<Redacted<String>>::IS_DISPLAY);
        const _: () = assert!(!Probe::<Vec<u8>>::IS_DISPLAY);
    }

    #[test]
    fn debug_never_shows_the_secret() {
        let secret = Redacted::new("cdm_SENTINEL_MUST_NOT_APPEAR".to_string());
        assert_eq!(format!("{secret:?}"), "[redacted]");
        assert!(!format!("{secret:?}").contains("SENTINEL"));
    }

    #[test]
    fn a_struct_printed_whole_keeps_its_secret() {
        let config = Config {
            base_url: "https://carpe-diem.xyz/api/operator/v1".to_string(),
            api_key: Redacted::new("cdm_SENTINEL_MUST_NOT_APPEAR".to_string()),
        };
        let printed = format!("{config:?}");
        assert!(!printed.contains("SENTINEL"), "leaked: {printed}");
        // The rest of the struct is still useful to read, which is why this is
        // better than deriving nothing.
        assert!(printed.contains("carpe-diem.xyz"));
    }

    #[test]
    fn the_value_is_still_reachable_deliberately() {
        let secret = Redacted::new("cdm_key".to_string());
        assert_eq!(secret.expose_str(), "cdm_key");
        assert_eq!(secret.clone().into_inner(), "cdm_key");
        assert!(!secret.is_empty());
    }
}
