//! Carpe Diem distribution flavor for the Sub Rosa fork.
//!
//! Everything specific to the fork lives here to concentrate the diff against
//! upstream June: brand identifiers ([`branding`]), the Carpe Diem settings
//! store + IPC ([`settings`]), the `june-api` sidecar manager ([`sidecar`])
//! that turns runtime settings into a locally spawned backend, the media
//! proxy ([`media`]) behind the Studio views, and the durable runner
//! ([`jobs`]) that carries asynchronous generations through a suspension.

pub mod branding;
pub mod jobs;
pub mod media;
pub mod settings;
pub mod sidecar;
pub mod workflow_runs;
