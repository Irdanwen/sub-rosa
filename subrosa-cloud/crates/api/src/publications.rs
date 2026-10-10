//! Publishing routes (ADR 0097). The owner's routes take the ordinary session
//! (cookie with CSRF and origin, or an app's bearer). The catalog and the
//! report route answer anybody: everything they return is already public.
use super::{ApiError, ClientAddress, Result, ok, session};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use subrosa_domain::Error;
use subrosa_domain::publication::{ListingReference, PageKind, ReportReason, ReportTarget};
use subrosa_services::Service;
use subrosa_services::publication::{
    ListingInput, PageInput, ProfileInput, ReportSubject, SiteInput,
};
use uuid::Uuid;

pub(super) fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/api/v1/publications", get(overview))
        .route(
            "/api/v1/publications/pages/{id}",
            put(publish_page).delete(unpublish_page),
        )
        .route(
            "/api/v1/publications/sites/{id}",
            put(save_site).delete(delete_site),
        )
        .route(
            "/api/v1/publications/profile",
            put(save_profile).delete(delete_profile),
        )
        .route(
            "/api/v1/publications/profile/avatar",
            put(set_avatar)
                .delete(clear_avatar)
                .layer(DefaultBodyLimit::max(300 * 1024)),
        )
        .route(
            "/api/v1/publications/assistants/{id}",
            put(publish_listing).delete(unpublish_listing),
        )
        .route("/api/v1/catalog/assistants", get(catalog))
        .route("/api/v1/catalog/assistants/{id}", get(listing))
        .route("/api/v1/catalog/assistants/{id}/import", post(import))
        .route("/api/v1/reports", post(report))
}

async fn overview(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    Ok(ok(s.publications(&a).await?).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageBody {
    slug: String,
    title: String,
    kind: PageKind,
    source_id: String,
    markdown: String,
}
async fn publish_page(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<PageBody>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Ok(ok(s
        .publish_page(
            &a,
            PageInput {
                id,
                slug: b.slug,
                title: b.title,
                kind: b.kind,
                source_id: b.source_id,
                markdown: b.markdown,
            },
        )
        .await?)
    .into_response())
}
/// Taking something down is never a step-up action: it only removes.
async fn unpublish_page(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.unpublish_page(&a, id).await?;
    Ok(ok(json!({"unpublished":true})).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SiteBody {
    title: String,
    #[serde(default)]
    home_page_id: Option<Uuid>,
    page_ids: Vec<Uuid>,
}
async fn save_site(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<SiteBody>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Ok(ok(s
        .save_site(
            &a,
            SiteInput {
                id,
                title: b.title,
                home_page_id: b.home_page_id,
                page_ids: b.page_ids,
            },
        )
        .await?)
    .into_response())
}
async fn delete_site(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.delete_site(&a, id).await?;
    Ok(ok(json!({"deleted":true})).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileBody {
    handle: String,
    display_name: String,
    #[serde(default)]
    bio: String,
}
async fn save_profile(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<ProfileBody>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Ok(ok(s
        .save_profile(
            &a,
            ProfileInput {
                handle: b.handle,
                display_name: b.display_name,
                bio: b.bio,
            },
        )
        .await?)
    .into_response())
}
async fn delete_profile(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.delete_profile(&a).await?;
    Ok(ok(json!({"deleted":true})).into_response())
}
async fn set_avatar(State(s): State<Arc<Service>>, h: HeaderMap, body: Bytes) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    if h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) != Some("application/octet-stream")
    {
        return Err(Error::Invalid.into());
    }
    s.set_avatar(&a, Some(&body)).await?;
    Ok(ok(json!({"avatar":true})).into_response())
}
async fn clear_avatar(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.set_avatar(&a, None).await?;
    Ok(ok(json!({"avatar":false})).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListingBody {
    source_id: String,
    name: String,
    description: String,
    category: String,
    instructions: String,
    #[serde(default)]
    starter: String,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    references: Vec<ListingReference>,
}
async fn publish_listing(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<ListingBody>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Ok(ok(s
        .publish_listing(
            &a,
            ListingInput {
                id,
                source_id: b.source_id,
                name: b.name,
                description: b.description,
                category: b.category,
                instructions: b.instructions,
                starter: b.starter,
                permissions: b.permissions,
                references: b.references,
            },
        )
        .await?)
    .into_response())
}
async fn unpublish_listing(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.unpublish_listing(&a, id).await?;
    Ok(ok(json!({"unpublished":true})).into_response())
}

#[derive(Deserialize)]
struct CatalogQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    page: i64,
}
async fn catalog(State(s): State<Arc<Service>>, Query(q): Query<CatalogQuery>) -> Result<Response> {
    Ok(ok(s
        .catalog(
            q.q.as_deref(),
            q.category.as_deref().filter(|c| !c.is_empty()),
            q.page,
        )
        .await?)
    .into_response())
}
async fn listing(State(s): State<Arc<Service>>, Path(id): Path<Uuid>) -> Result<Response> {
    Ok(ok(s.listing(id, false).await?).into_response())
}
/// The definition, for "Add to Sub Rosa", and one more on its import count,
/// within a per-address budget.
async fn import(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<ClientAddress>,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    Ok(ok(s.import_listing(id, &client.0).await?).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportBody {
    target_kind: ReportTarget,
    /// A page's slug or a profile's handle.
    #[serde(default)]
    target: Option<String>,
    /// A catalog listing's id.
    #[serde(default)]
    target_id: Option<Uuid>,
    reason: ReportReason,
    #[serde(default)]
    detail: String,
}
async fn report(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<ClientAddress>,
    Json(b): Json<ReportBody>,
) -> Result<Response> {
    let subject = match (b.target_kind, b.target.as_deref(), b.target_id) {
        (ReportTarget::Page, Some(slug), None) => ReportSubject::PageSlug(slug),
        (ReportTarget::Profile, Some(handle), None) => ReportSubject::Handle(handle),
        (ReportTarget::Assistant, None, Some(id)) => ReportSubject::Assistant(id),
        _ => return Err(ApiError(Error::Invalid)),
    };
    s.report(subject, b.reason, &b.detail, &client.0).await?;
    Ok(ok(json!({"reported":true})).into_response())
}
