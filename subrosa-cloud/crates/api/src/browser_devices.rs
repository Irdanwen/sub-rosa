//! A browser becoming a device of its account, and leaving again (ADR 0096).
//! Both routes take the ordinary browser session (cookie, CSRF, origin) plus a
//! proof signed by the browser's non-extractable device key.
use super::{ApiError, Result, ok, session};
use axum::{
    Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use subrosa_domain::Error;
use subrosa_services::{AdmissionRequest, DEVICE_PROOF_HEADER, Service};
use uuid::Uuid;

pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/api/v1/browser-devices", post(admit))
        .route("/api/v1/browser-devices/renounce", post(renounce))
}
pub(super) fn proof(h: &HeaderMap) -> Option<&str> {
    h.get(DEVICE_PROOF_HEADER).and_then(|v| v.to_str().ok())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    #[serde(default)]
    pairing_request_id: Option<Uuid>,
    #[serde(default)]
    recovery_proof: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Admit {
    name: String,
    admission: Admission,
}
async fn admit(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<Admit>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let admission = match (b.admission.pairing_request_id, &b.admission.recovery_proof) {
        (Some(id), None) => AdmissionRequest::Pairing(id),
        (None, Some(value)) => AdmissionRequest::Recovery(value),
        _ => return Err(ApiError(Error::Invalid)),
    };
    // An empty proof fails its own check, after the service has refused an
    // app session for what it is.
    let proof = proof(&h).unwrap_or_default();
    Ok(ok(s
        .admit_browser_device(&a, proof, &b.name, admission)
        .await?)
    .into_response())
}
async fn renounce(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let proof = proof(&h).ok_or(Error::DeviceProof)?;
    s.renounce_browser_device(&a, proof).await?;
    Ok(ok(json!({"revoked":true})).into_response())
}
