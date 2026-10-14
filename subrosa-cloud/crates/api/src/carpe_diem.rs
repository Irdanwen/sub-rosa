//! The one route through which a device asks this service to vouch for it to
//! Carpe Diem (ADR 0069). What comes back is a short assertion the app carries
//! to Carpe Diem itself, bound to a key the app generated and kept; the Carpe
//! Diem key that results is delivered to the app and never passes here.
use super::{Result, ok, session};
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use std::sync::Arc;
use subrosa_domain::Error;
use subrosa_services::Service;

pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new().route("/api/v1/carpe-diem/assertion", post(assertion))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssertionRequest {
    /// RFC 7638 thumbprint of the app's ephemeral P-256 key.
    jkt: String,
}
async fn assertion(State(s): State<Arc<Service>>, h: HeaderMap, body: Bytes) -> Result<Response> {
    // Answered before anything is read, the body included, so an app can tell
    // "this deployment does not issue keys" apart from "sign in again" or
    // "that request was malformed" (docs/carpe-diem-partner-contract.md).
    if !s.carpe_diem_enabled() {
        return Err(Error::NotFound.into());
    }
    // Parsed from bytes kept whole: a browser device's proof is bound to
    // exactly these bytes.
    let b: AssertionRequest = super::browser_devices::json_body(&h, &body)?;
    let a = session(&s, &h, true).await?;
    // Only a browser device sends a proof; an app's bearer session is enough.
    let proof = super::browser_devices::proof(&h, &body);
    Ok(ok(s.carpe_diem_assertion(&a, &b.jkt, proof).await?).into_response())
}
