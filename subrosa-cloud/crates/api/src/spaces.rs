//! Shared projects (ADR 0098). Every route takes the ordinary session (a
//! cookie with CSRF and origin, or an app's bearer). The service stores
//! public keys, signed heads, sealed keys and ciphertext, authorizes by
//! membership, and opens nothing.
use super::{ApiError, Result, ok, session};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use subrosa_domain::Error;
use subrosa_domain::space::{
    MAX_INVITATION_DAYS, NewSpaceObject, WrappedKey, acceptance_keys, bundle_keys, head_info,
};
use subrosa_services::Service;
use subrosa_services::space::{EpochWrite, InvitationWrite};
use uuid::Uuid;

pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/api/v1/identity", get(identity).put(save_identity))
        .route("/api/v1/spaces", get(spaces).post(create_space))
        .route("/api/v1/spaces/{id}", get(detail).delete(delete_space))
        .route("/api/v1/spaces/{id}/epochs", post(advance_epoch))
        .route("/api/v1/spaces/{id}/invitations", post(invite))
        .route(
            "/api/v1/spaces/{id}/invitations/{invitation}",
            delete(revoke_invitation),
        )
        .route("/api/v1/spaces/{id}/leave", post(leave))
        .route(
            "/api/v1/spaces/{id}/objects",
            get(objects)
                .post(append)
                .layer(DefaultBodyLimit::max(5 * 1024 * 1024)),
        )
        .route("/api/v1/space-invitations/{id}/open", post(open_invitation))
        .route(
            "/api/v1/space-invitations/{id}/accept",
            post(accept_invitation),
        )
}

async fn identity(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    Ok(ok(s.repository.identity(a.account.id).await?).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityWrite {
    expected_version: i64,
    public: Value,
    sealed_private: String,
}
async fn save_identity(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<IdentityWrite>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let keys = bundle_keys(&b.public)?;
    let version = s
        .repository
        .save_identity(
            a.account.id,
            b.expected_version,
            &b.public,
            &keys,
            &b.sealed_private,
        )
        .await?;
    Ok(ok(json!({"version": version})).into_response())
}

async fn spaces(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    Ok(ok(s.repository.spaces(a.account.id).await?).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewSpace {
    head: Value,
    wrapped_key: String,
}
async fn create_space(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<NewSpace>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let info = head_info(&b.head)?;
    s.repository
        .create_space(
            a.account.id,
            &b.head,
            &info,
            &WrappedKey {
                account_id: a.account.id,
                epoch: 1,
                sealed: b.wrapped_key,
            },
        )
        .await?;
    Ok(ok(json!({"id": info.space_id, "epoch": 1})).into_response())
}
async fn detail(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    Ok(ok(s.repository.space_detail(a.account.id, id).await?).into_response())
}
async fn delete_space(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.repository.delete_space(a.account.id, id).await?;
    Ok(ok(json!({"deleted": true})).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewEpoch {
    head: Value,
    wrapped_keys: Vec<WrappedKey>,
    #[serde(default)]
    admit: Vec<Uuid>,
}
async fn advance_epoch(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<NewEpoch>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    if b.wrapped_keys.len() > 50 * 64 || b.admit.len() > 50 {
        return Err(Error::Invalid.into());
    }
    let info = head_info(&b.head)?;
    s.repository
        .advance_epoch(EpochWrite {
            account: a.account.id,
            space: id,
            head: &b.head,
            info: &info,
            wrapped: &b.wrapped_keys,
            admit: &b.admit,
        })
        .await?;
    Ok(ok(json!({"epoch": info.epoch})).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewInvitation {
    id: Uuid,
    token_hash: String,
    payload: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}
async fn invite(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<NewInvitation>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let now = chrono::Utc::now();
    if b.expires_at <= now + chrono::Duration::minutes(1)
        || b.expires_at > now + chrono::Duration::days(MAX_INVITATION_DAYS)
    {
        return Err(Error::Invalid.into());
    }
    s.repository
        .create_invitation(InvitationWrite {
            account: a.account.id,
            space: id,
            id: b.id,
            token_hash: &b.token_hash,
            payload: &b.payload,
            expires_at: b.expires_at,
        })
        .await?;
    Ok(ok(json!({"id": b.id, "expires_at": b.expires_at})).into_response())
}
async fn revoke_invitation(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path((id, invitation)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.repository
        .revoke_invitation(a.account.id, id, invitation)
        .await?;
    Ok(ok(json!({"revoked": true})).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    token_hash: String,
}
/// Any signed-in account holding the link can read the sealed payload. The
/// session is required so an invitation is never readable anonymously.
async fn open_invitation(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Token>,
) -> Result<Response> {
    session(&s, &h, true).await?;
    let (space_id, payload, expires_at) = s.repository.open_invitation(id, &b.token_hash).await?;
    Ok(
        ok(json!({"space_id": space_id, "payload": payload, "expires_at": expires_at}))
            .into_response(),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Acceptance {
    token_hash: String,
    acceptance: Value,
}
async fn accept_invitation(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Acceptance>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let keys = acceptance_keys(&b.acceptance)?;
    let space = s
        .repository
        .accept_invitation(a.account.id, id, &b.token_hash, &b.acceptance, &keys)
        .await?;
    Ok(ok(json!({"space_id": space})).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Leave {
    epoch: i64,
    statement: String,
}
async fn leave(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Leave>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.repository
        .leave_space(a.account.id, id, b.epoch, &b.statement)
        .await?;
    Ok(ok(json!({"left": true})).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Push {
    objects: Vec<NewSpaceObject>,
}
async fn append(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Push>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Ok(ok(
        json!({"results": s.repository.append_space_objects(a.account.id, id, &b.objects).await?}),
    )
    .into_response())
}
#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    after: i64,
    #[serde(default = "page_size")]
    limit: i64,
}
fn page_size() -> i64 {
    200
}
async fn objects(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<Page>,
) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    if q.after < 0 || !(1..=500).contains(&q.limit) {
        return Err(ApiError(Error::Invalid));
    }
    Ok(ok(s
        .repository
        .space_objects(a.account.id, id, q.after, q.limit)
        .await?)
    .into_response())
}
