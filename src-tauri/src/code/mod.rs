//! Code runs (fork, ADR-0123).
//!
//! - [`event`]: the neutral contract every engine's run is reported in.
//! - [`hermes_adapter`]: Hermes gateway frames to that contract.
//! - `cli` (desktop): `subrosa-code run`, a run without a window, its events
//!   written as JSON lines (docs/code-cli.md).

pub mod event;
pub mod hermes_adapter;

#[cfg(desktop)]
pub mod cli;
