//! A browser becoming a device of its account, and leaving again (ADR 0096).
//! Both routes take the ordinary browser session (cookie, CSRF, origin) plus a
//! proof signed by the browser's non-extractable device key.
//!
//! Every route that reads a device proof takes its body as raw bytes, because
//! the proof is bound to those exact bytes (`ath`): a body parsed first and
//! serialized again would not be what the browser signed.
use super::{ApiError, Result, ok, session};
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::json;
use std::sync::Arc;
use subrosa_domain::Error;
use subrosa_services::{AdmissionRequest, DEVICE_PROOF_HEADER, DeviceProof, Service};
use uuid::Uuid;

pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/api/v1/browser-devices", post(admit))
        .route("/api/v1/browser-devices/renounce", post(renounce))
}
pub(super) fn proof<'a>(h: &'a HeaderMap, body: &'a [u8]) -> Option<DeviceProof<'a>> {
    h.get(DEVICE_PROOF_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|token| DeviceProof { token, body })
}
/// What the `Json` extractor would have done, on bytes kept for the proof: a
/// JSON content type and a body that parses, else `400 invalid_request`.
pub(super) fn json_body<T: DeserializeOwned>(h: &HeaderMap, body: &[u8]) -> Result<T> {
    let json = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if !json {
        return Err(ApiError(Error::Invalid));
    }
    serde_json::from_slice(body).map_err(|_| ApiError(Error::Invalid))
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
async fn admit(State(s): State<Arc<Service>>, h: HeaderMap, body: Bytes) -> Result<Response> {
    let b: Admit = json_body(&h, &body)?;
    let a = session(&s, &h, true).await?;
    let admission = match (b.admission.pairing_request_id, &b.admission.recovery_proof) {
        (Some(id), None) => AdmissionRequest::Pairing(id),
        (None, Some(value)) => AdmissionRequest::Recovery(value),
        _ => return Err(ApiError(Error::Invalid)),
    };
    // An empty proof fails its own check, after the service has refused an
    // app session for what it is.
    let proof = proof(&h, &body).unwrap_or(DeviceProof {
        token: "",
        body: &body,
    });
    Ok(ok(s
        .admit_browser_device(&a, proof, &b.name, admission)
        .await?)
    .into_response())
}
async fn renounce(State(s): State<Arc<Service>>, h: HeaderMap, body: Bytes) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let proof = proof(&h, &body).ok_or(Error::DeviceProof)?;
    s.renounce_browser_device(&a, proof).await?;
    Ok(ok(json!({"revoked":true})).into_response())
}
