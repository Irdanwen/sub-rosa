//! The key is never written to a log.
//!
//! This was true by inspection: the providers log `%url %status %error` and
//! body lengths, never headers. Inspection is the wrong thing to be relying
//! on, because the line that breaks it is one somebody adds at 2am while
//! chasing a 502 — `tracing::debug!("{request:?}")` — and nothing about the
//! running app looks different afterwards. The log is a file the user may well
//! attach to a bug report.
//!
//! Two halves, and both are needed:
//!
//! * a **runtime** half that captures everything `tracing` emits while the
//!   error paths run with a sentinel key, and asserts the sentinel is absent;
//! * a **static** half that refuses the shapes which would defeat the runtime
//!   half — logging an exposed value, or removing the compile-time guard that
//!   keeps `Redacted` from growing a `Display` (which `bearer_auth` would
//!   happily send as the credential).
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::path::Path;
use std::sync::{Arc, Mutex};

use os_june_lib::redacted::Redacted;
use tracing::subscriber::with_default;
use tracing_subscriber::fmt::MakeWriter;

/// The value that must never appear. Distinctive enough that a substring match
/// cannot pass by accident.
const SENTINEL: &str = "cdm_SENTINEL_0d4f7a2b_MUST_NOT_APPEAR";

// ---------------------------------------------------------------------------
// Runtime: what actually reaches the log
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct CapturedLog(Arc<Mutex<Vec<u8>>>);

impl CapturedLog {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for CapturedLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for CapturedLog {
    type Writer = CapturedLog;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Runs `body` with everything `tracing` emits captured, at TRACE level so no
/// filter can hide a leak that a debug build would print.
fn logs_from(body: impl FnOnce()) -> String {
    let captured = CapturedLog::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(captured.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .finish();
    with_default(subscriber, body);
    captured.text()
}

#[test]
fn a_redacted_key_survives_every_way_a_log_line_is_written() {
    let key = Redacted::new(SENTINEL.to_string());

    let captured = logs_from(|| {
        // The four shapes a person actually writes.
        tracing::debug!(?key, "structured field");
        tracing::warn!("interpolated: {key:?}");
        tracing::error!(key = ?key, "named field");
        tracing::info!("{:?}", (&key, "https://carpe-diem.xyz/api/operator/v1"));
    });

    assert!(
        !captured.is_empty(),
        "nothing was captured, so nothing was proven"
    );
    assert!(
        !captured.contains("SENTINEL"),
        "the key reached the log:\n{captured}"
    );
    assert!(
        captured.contains("[redacted]"),
        "the mask should be what appears instead:\n{captured}"
    );
    // The line is still worth reading, which is the point of masking rather
    // than omitting.
    assert!(captured.contains("carpe-diem.xyz"));
}

#[test]
fn an_error_carrying_the_key_still_does_not_print_it() {
    // The realistic leak is not `debug!(key)` — it is a struct printed whole
    // while chasing a failure.
    #[derive(Debug)]
    #[allow(dead_code, reason = "the fields exist to be printed by Debug")]
    struct UpstreamContext {
        url: String,
        status: u16,
        api_key: Redacted<String>,
    }

    let captured = logs_from(|| {
        let context = UpstreamContext {
            url: "https://carpe-diem.xyz/api/operator/v1/chat/completions".to_string(),
            status: 502,
            api_key: Redacted::new(SENTINEL.to_string()),
        };
        tracing::error!(?context, "upstream failed");
        tracing::error!("upstream failed: {context:?}");
    });

    assert!(!captured.contains("SENTINEL"), "leaked:\n{captured}");
    assert!(captured.contains("502"), "the useful part is still there");
}

// ---------------------------------------------------------------------------
// Static: the shapes that would defeat the runtime half
// ---------------------------------------------------------------------------

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
                out.push((path.display().to_string().replace('\\', "/"), source));
            }
        }
    }
}

#[test]
fn the_compile_time_display_guard_is_still_there() {
    // `Redacted` not implementing `Display` is enforced by the compiler:
    // `src/redacted.rs` reads an inherent-impl probe at the concrete type in a
    // `const` block, so adding the impl stops the build with a message that
    // names the reason. Verified by adding the impl and watching it fail.
    //
    // What the compiler cannot catch is somebody deleting the guard, so that
    // is what this checks. It is deliberately not a second scan for
    // `impl Display`: two overlapping checks drift, and the weaker one is the
    // one people trust.
    let source = std::fs::read_to_string("src/redacted.rs").expect("src/redacted.rs");
    assert!(
        source.contains("Probe::<Redacted<String>>::IS_DISPLAY"),
        "the compile-time Display guard has been removed from src/redacted.rs"
    );
    assert!(
        source.contains("mod display_probe"),
        "the probe behind the guard has been removed from src/redacted.rs"
    );
}

#[test]
fn no_log_line_prints_a_bare_key_variable() {
    // The pattern that would leak despite `Redacted`: logging the exposed
    // value rather than the wrapper.
    let mut sources = Vec::new();
    rust_sources(Path::new("src"), &mut sources);
    assert!(sources.len() > 40, "the scan is looking in the wrong place");

    let macros = [
        "trace!",
        "debug!",
        "info!",
        "warn!",
        "error!",
        "println!",
        "eprintln!",
    ];
    let mut offenders = Vec::new();
    for (path, source) in &sources {
        for (index, line) in source.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            if !macros.iter().any(|name| line.contains(name)) {
                continue;
            }
            if line.contains("expose_str()") || line.contains("expose()") {
                offenders.push(format!("{path}:{}: {}", index + 1, trimmed));
            }
        }
    }

    assert_eq!(
        offenders,
        Vec::<String>::new(),
        "exposing a secret inside a log macro defeats the whole type. Log the \
         wrapper, or log something else."
    );
}
