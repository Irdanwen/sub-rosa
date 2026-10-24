//! `subrosa-code`: a code run without a window (ADR-0123, docs/code-cli.md).
//!
//! The binary (`src/bin/subrosa-code.rs`) only calls [`main`]; everything is
//! here so it is compiled, linted and tested with the app. It starts what the
//! app starts (the `june` backend, the provider proxy, Hermes under its
//! Seatbelt profile), drives one turn through the gateway, and writes every
//! code event as one JSON line on stdout. Diagnostics go to stderr.

pub mod args;
pub mod budget;
pub mod gateway;
mod run;
pub mod state;

use std::io::Write as _;

pub use run::default_data_dir;

/// Runs the command line `args` (without the program name) and returns the
/// process exit code: 0 completed, 1 failed, 2 usage, 3 budget reached,
/// 130 interrupted.
pub fn main_with_args(args: Vec<String>) -> i32 {
    match args::parse(args) {
        Ok(args::Invocation::Help) => {
            let _ = std::io::stdout().lock().write_all(args::USAGE.as_bytes());
            run::EXIT_COMPLETED
        }
        Ok(args::Invocation::Version) => {
            let _ = writeln!(
                std::io::stdout().lock(),
                "subrosa-code {} (event schema {})",
                env!("CARGO_PKG_VERSION"),
                crate::code::event::CODE_EVENT_SCHEMA_VERSION
            );
            run::EXIT_COMPLETED
        }
        Err(message) => {
            eprintln!("{message}");
            run::EXIT_USAGE
        }
        Ok(args::Invocation::Run(run_args)) => {
            // Before the async runtime starts any thread (see `take_env_key`).
            let env_key = run::take_env_key();
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("The async runtime could not start: {error}");
                    return run::EXIT_FAILED;
                }
            };
            runtime.block_on(run::run(run_args, env_key))
        }
    }
}

/// The process entry point.
pub fn main() -> i32 {
    main_with_args(std::env::args().skip(1).collect())
}
