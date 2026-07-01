//! Carpe Diem distribution flavor for the Sub Rosa fork.
//!
//! Everything specific to the fork lives here to concentrate the diff against
//! upstream June: brand identifiers ([`branding`]), the Carpe Diem settings
//! store + IPC ([`settings`]), and the `june-api` sidecar manager
//! ([`sidecar`]) that turns runtime settings into a locally spawned backend.

pub mod branding;
pub mod settings;
pub mod sidecar;
