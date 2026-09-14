//! Short-lived ciphertext relay. The native transfer code authenticates the key exchange.
use super::{ApiError, Result, ok, session};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use subrosa_domain::Error;
use subrosa_services::Service;
use uuid::Uuid;
pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/api/v1/pairing", post(create))
        .route("/api/v1/pairing/{id}", get(read).delete(remove))
        .route("/api/v1/pairing/{id}/approve", post(approve))
}
#[derive(Deserialize)]
struct Create {
    request_id: Uuid,
}
async fn create(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<Create>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let expires = s.repository.create_pairing(&a, b.request_id).await?;
    Ok(ok(json!({"request_id":b.request_id,"expires_at":expires})).into_response())
}
async fn read(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    Ok(ok(s.repository.read_pairing(&a, id).await?).into_response())
}
#[derive(Deserialize)]
struct Approval {
    envelope: String,
}
async fn approve(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Approval>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    if b.envelope.is_empty() || b.envelope.len() > 16 * 1024 {
        return Err(ApiError(Error::Invalid));
    }
    s.repository.approve_pairing(&a, id, &b.envelope).await?;
    Ok(ok(json!({"approved":true})).into_response())
}
async fn remove(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.repository.delete_pairing(&a, id).await?;
    Ok(ok(json!({"deleted":true})).into_response())
}
