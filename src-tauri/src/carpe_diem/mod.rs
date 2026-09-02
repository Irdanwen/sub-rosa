//! Carpe Diem distribution flavor for the Sub Rosa fork.
//!
//! Everything specific to the fork lives here to concentrate the diff against
//! upstream June: brand identifiers ([`branding`]), the Carpe Diem settings
//! store + IPC ([`settings`]), the prompt-cache ledger ([`cache_stats`]),
//! the `june-api` sidecar manager ([`sidecar`])
//! that turns runtime settings into a locally spawned backend, the media
//! proxy ([`media`]) behind the Studio views, the durable runner
//! ([`jobs`]) that carries asynchronous generations through a suspension, and
//! the tracker a user's report reaches ([`issue_reports`]).

pub mod branding;
pub mod cache_stats;
pub mod issue_reports;
pub mod jobs;
pub mod local_session;
pub mod media;
pub mod settings;
pub mod sidecar;
pub mod workflow_runs;
