//! The one route through which a device asks this service to vouch for it to
//! Carpe Diem (ADR 0069). What comes back is a short assertion the app carries
//! to Carpe Diem itself, bound to a key the app generated and kept; the Carpe
//! Diem key that results is delivered to the app and never passes here.
use super::{Result, ok, session};
use axum::{
    Json, Router,
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
async fn assertion(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<AssertionRequest>,
) -> Result<Response> {
    // Answered before any session is read, so an app can tell "this deployment
    // does not issue keys" apart from "sign in again".
    if !s.carpe_diem_enabled() {
        return Err(Error::NotFound.into());
    }
    let a = session(&s, &h, true).await?;
    Ok(ok(s.carpe_diem_assertion(&a, &b.jkt).await?).into_response())
}
