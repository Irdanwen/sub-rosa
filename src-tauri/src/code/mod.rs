//! Code runs (fork, ADR-0123).
//!
//! - [`event`]: the neutral contract every engine's run is reported in.
//! - [`hermes_adapter`]: Hermes gateway frames to that contract.
//! - `cli` (desktop): `subrosa-code run`, a run without a window, its events
//!   written as JSON lines (docs/code-cli.md).
//! - `toolchain` (desktop): language servers and build toolchains under the
//!   write jail, for the app's runtime and the CLI's (ADR-0125).
//! - `prompts` (desktop): what the agent is told about a code task, by model
//!   family, for the app's Code mode and the CLI alike.

pub mod event;
pub mod hermes_adapter;

#[cfg(desktop)]
pub mod cli;
#[cfg(desktop)]
pub mod toolchain;
pub mod prompts;
