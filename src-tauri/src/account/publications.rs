//! Publishing a note, a canvas or an assistant in the clear (ADR 0097).
//!
//! Nothing here is a share. A share (ADR 0053) is sealed under a key the
//! service never sees and ends on a date. A publication is the opposite on
//! purpose: the text leaves this device readable, the service renders it for
//! anybody, and it stays until the person unpublishes it. So nothing is ever
//! published without an explicit tap, and nothing published is read back from
//! the encrypted library: the bytes sent are the note as it is on this device
//! at that moment.
//!
//! The service is the authority on what is published. This module keeps no
//! table of its own: it asks the service, and recognises a note's page by the
//! note's id, which is all another device of the same account needs to update
//! the page rather than make a second one.
use super::*;
use crate::assistants::{self, AssistantDefinition};

/// The permissions a catalog listing may carry, in the app's words. The
/// service refuses anything else, a connector included: a connector is the
/// publisher's own account and means nothing on another device.
const LISTING_TOOLS: &[&str] = &["web", "image", "video", "music", "speech", "documents"];
/// What the app sends at most for a page. The service caps it too.
const MAX_PAGE_BYTES: usize = 256 * 1024;
/// What one listing may carry as references, all together.
const MAX_REFERENCE_BYTES: usize = 200 * 1024;

pub(crate) fn error(code: &str) -> AppError {
    match code {
        "publish_slug_taken" => AppError::new(
            "publish_slug_taken",
            "This address is already taken. Choose another one.",
        ),
        "publish_too_large" => AppError::new(
            "publish_too_large",
            "This is too long to publish. Shorten it and try again.",
        ),
        "publish_empty" => AppError::new(
            "publish_empty",
            "There is nothing to publish yet. Write something first.",
        ),
        "publish_credential" => AppError::new(
            "publish_credential",
            "This looks like it contains a key or a password. Remove it before publishing.",
        ),
        "publish_links" => AppError::new(
            "publish_links",
            "This has more links than the publishing rules allow.",
        ),
        "publish_blocked" => AppError::new(
            "publish_blocked",
            "This contains words the service does not publish.",
        ),
        "publish_shape" => AppError::new(
            "publish_shape",
            "Use 3 to 32 lowercase letters, digits or hyphens.",
        ),
        "publish_too_many" => AppError::new(
            "publish_too_many",
            "You have reached the most this account can publish. Unpublish something first.",
        ),
        "publish_taken_down" => AppError::new(
            "publish_taken_down",
            "This was taken down by the service and cannot be published again.",
        ),
        "publish_suspended" => AppError::new(
            "publish_suspended",
            "Publishing is suspended for this account after repeated takedowns.",
        ),
        "publish_unavailable" => AppError::new(
            "publish_unavailable",
            "Your account service does not publish pages.",
        ),
        "catalog_not_found" => AppError::new(
            "catalog_not_found",
            "This assistant is no longer in the catalog.",
        ),
        _ => AppError::new(
            "publish_failed",
            "This could not be published. Check your connection and try again.",
        ),
    }
}

/// The body of one request: JSON, raw bytes, or nothing.
enum Body {
    None,
    Json(Value),
    Bytes(Vec<u8>),
}

/// One request to the account service. Unlike the account's own helper, it
/// keeps the service's refusal precise, because "this address is taken" and
/// "remove the key you pasted" are different things to fix.
async fn send(
    base: &str,
    token: Option<&Redacted<String>>,
    method: reqwest::Method,
    path: &str,
    body: Body,
    not_found: &str,
) -> Result<Value, AppError> {
    let client = crate::http_client::credentialed(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| super::error("account_network"))?;
    let started = Instant::now();
    let method_name = method.as_str().to_string();
    let mut request = client.request(method, format!("{base}{path}"));
    if let Some(token) = token {
        request = request.bearer_auth(token.expose_str());
    }
    let request_bytes = match body {
        Body::None => 0,
        Body::Json(value) => {
            let bytes = serde_json::to_vec(&value).map_err(|_| error("publish_failed"))?;
            let len = bytes.len();
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes);
            len
        }
        Body::Bytes(bytes) => {
            let len = bytes.len();
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(bytes);
            len
        }
    };
    let response = request
        .send()
        .await
        .map_err(|_| super::error("account_network"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| super::error("account_network"))?;
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default(),
        purpose: "public pages and catalog".into(),
        method: method_name,
        request_bytes: request_bytes as u64,
        response_bytes: bytes.len() as u64,
        status: Some(status.as_u16()),
        duration_ms: started.elapsed().as_millis() as u64,
        model: None,
        note_id: None,
    });
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_success() {
        return value
            .get("data")
            .cloned()
            .ok_or_else(|| error("publish_failed"));
    }
    Err(refusal(status.as_u16(), &value, not_found))
}

/// The service's refusal, as the app names it.
fn refusal(status: u16, body: &Value, not_found: &str) -> AppError {
    let code = body
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let rule = body
        .pointer("/error/rule")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (code, rule) {
        ("slug_taken", _) => error("publish_slug_taken"),
        ("content_policy", "too_large") | ("quota_exceeded", _) => error("publish_too_large"),
        ("content_policy", "empty") => error("publish_empty"),
        ("content_policy", "credential") => error("publish_credential"),
        ("content_policy", "too_many_links") => error("publish_links"),
        ("content_policy", "blocked_term") => error("publish_blocked"),
        ("content_policy", "too_many") => error("publish_too_many"),
        ("content_policy", _) => error("publish_shape"),
        ("taken_down", _) => error("publish_taken_down"),
        ("publishing_suspended", _) => error("publish_suspended"),
        ("recent_auth_required", _) => super::error("recent_auth_required"),
        _ if status == 401 => super::error("account_not_connected"),
        _ if status == 404 => error(not_found),
        _ => error("publish_failed"),
    }
}

async fn owner_call(
    s: &Session,
    method: reqwest::Method,
    path: &str,
    body: Body,
) -> Result<Value, AppError> {
    send(
        &s.base,
        Some(&s.token),
        method,
        path,
        body,
        "publish_unavailable",
    )
    .await
}

/// SHA-256 of what a publish sends: the title, a zero byte, the body. The
/// service stores the same digest, so "is there anything left to publish?"
/// needs neither the network text nor a local table.
pub(crate) fn page_digest(title: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0u8]);
    hasher.update(body.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A readable address from a title: lowercase ASCII, accents folded, other
/// characters to single hyphens, with a short random tail so two notes called
/// "Notes" never fight over one address.
pub(crate) fn slug_for(title: &str, tail: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        let folded = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'ç' => 'c',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ñ' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ý' | 'ÿ' => 'y',
            'ß' => 's',
            other => other,
        };
        if folded.is_ascii_alphanumeric() {
            slug.push(folded);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "page" } else { slug };
    format!("{slug}-{tail}")
}
fn random_tail() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
}

/// What the person sees about one note: its page, if any, and whether the
/// note changed since it was last published.
#[derive(Serialize)]
pub struct NotePublication {
    pub publication_url: String,
    pub page: Option<Value>,
    pub url: Option<String>,
    pub changed: bool,
}

async fn note_text(pool: &SqlitePool, note_id: &str) -> Result<(String, String), AppError> {
    let row = query("SELECT title, COALESCE(NULLIF(edited_content,''), generated_content, '') AS body FROM notes WHERE id = ?")
        .bind(note_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| error("publish_failed"))?;
    let title: String = row.get("title");
    let title = title.trim();
    Ok((
        if title.is_empty() {
            "Untitled".to_string()
        } else {
            title.chars().take(200).collect()
        },
        row.get("body"),
    ))
}
fn find<'a>(overview: &'a Value, list: &str, source_id: &str) -> Option<&'a Value> {
    overview
        .get(list)
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| entry.get("source_id").and_then(Value::as_str) == Some(source_id))
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub async fn overview(app: &AppHandle) -> Result<Value, AppError> {
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    owner_call(&s, reqwest::Method::GET, "/api/v1/publications", Body::None).await
}

pub async fn note_status(app: &AppHandle, note_id: &str) -> Result<NotePublication, AppError> {
    let pool = pool(app).await?;
    let (title, body) = note_text(&pool, note_id).await?;
    let s = session(&pool).await?;
    let overview = owner_call(&s, reqwest::Method::GET, "/api/v1/publications", Body::None).await?;
    let base = text(&overview, "publication_url").to_string();
    let page = find(&overview, "pages", note_id).cloned();
    Ok(NotePublication {
        url: page
            .as_ref()
            .map(|page| format!("{base}/p/{}", text(page, "slug"))),
        changed: page
            .as_ref()
            .is_some_and(|page| text(page, "source_digest") != page_digest(&title, &body)),
        publication_url: base,
        page,
    })
}

/// Publishes a note (or a canvas, which is a note), or pushes its changes to
/// the page it already has.
pub async fn publish_note(
    app: &AppHandle,
    note_id: &str,
    kind: &str,
) -> Result<NotePublication, AppError> {
    let kind = if kind == "canvas" { "canvas" } else { "note" };
    let pool = pool(app).await?;
    let (title, body) = note_text(&pool, note_id).await?;
    if body.trim().is_empty() {
        return Err(error("publish_empty"));
    }
    if body.len() > MAX_PAGE_BYTES {
        return Err(error("publish_too_large"));
    }
    let s = session(&pool).await?;
    let overview = owner_call(&s, reqwest::Method::GET, "/api/v1/publications", Body::None).await?;
    let existing = find(&overview, "pages", note_id);
    let id = existing
        .map(|page| text(page, "id").to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut slug = existing
        .map(|page| text(page, "slug").to_string())
        .unwrap_or_else(|| slug_for(&title, &random_tail()));
    let mut retried = false;
    let page = loop {
        let result = owner_call(
            &s,
            reqwest::Method::PUT,
            &format!("/api/v1/publications/pages/{id}"),
            Body::Json(json!({
                "slug": slug,
                "title": title,
                "kind": kind,
                "source_id": note_id,
                "markdown": body,
            })),
        )
        .await;
        match result {
            // A fresh address that somebody holds is a collision of the random
            // tail, so one new tail settles it. An address the page already
            // had is never changed behind the person's back.
            Err(e) if e.code == "publish_slug_taken" && existing.is_none() && !retried => {
                retried = true;
                slug = slug_for(&title, &random_tail());
            }
            other => break other?,
        }
    };
    let base = text(&overview, "publication_url").to_string();
    Ok(NotePublication {
        url: Some(format!("{base}/p/{}", text(&page, "slug"))),
        changed: false,
        publication_url: base,
        page: Some(page),
    })
}

fn checked_id(id: &str) -> Result<String, AppError> {
    uuid::Uuid::parse_str(id)
        .map(|id| id.to_string())
        .map_err(|_| error("publish_failed"))
}

pub async fn unpublish_page(app: &AppHandle, page_id: &str) -> Result<(), AppError> {
    let id = checked_id(page_id)?;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    owner_call(
        &s,
        reqwest::Method::DELETE,
        &format!("/api/v1/publications/pages/{id}"),
        Body::None,
    )
    .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub home_page_id: Option<String>,
    pub page_ids: Vec<String>,
}
pub async fn save_site(app: &AppHandle, site: SiteRequest) -> Result<Value, AppError> {
    let id = match site.id.as_deref() {
        Some(id) => checked_id(id)?,
        None => uuid::Uuid::new_v4().to_string(),
    };
    let page_ids = site
        .page_ids
        .iter()
        .map(|id| checked_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    let home = site.home_page_id.as_deref().map(checked_id).transpose()?;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    owner_call(
        &s,
        reqwest::Method::PUT,
        &format!("/api/v1/publications/sites/{id}"),
        Body::Json(json!({"title": site.title, "home_page_id": home, "page_ids": page_ids})),
    )
    .await
}
pub async fn delete_site(app: &AppHandle, site_id: &str) -> Result<(), AppError> {
    let id = checked_id(site_id)?;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    owner_call(
        &s,
        reqwest::Method::DELETE,
        &format!("/api/v1/publications/sites/{id}"),
        Body::None,
    )
    .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRequest {
    pub handle: String,
    pub display_name: String,
    #[serde(default)]
    pub bio: String,
}
pub async fn save_profile(app: &AppHandle, profile: ProfileRequest) -> Result<Value, AppError> {
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    owner_call(
        &s,
        reqwest::Method::PUT,
        "/api/v1/publications/profile",
        Body::Json(json!({
            "handle": profile.handle.trim().to_lowercase(),
            "display_name": profile.display_name,
            "bio": profile.bio,
        })),
    )
    .await
}
pub async fn delete_profile(app: &AppHandle) -> Result<(), AppError> {
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    owner_call(
        &s,
        reqwest::Method::DELETE,
        "/api/v1/publications/profile",
        Body::None,
    )
    .await?;
    Ok(())
}
/// Sets the profile picture from base64 bytes, or clears it. The service
/// decides the type from the bytes.
pub async fn set_avatar(app: &AppHandle, data: Option<String>) -> Result<(), AppError> {
    use base64::Engine;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    match data {
        Some(data) => {
            let encoded = data.split_once(',').map_or(data.as_str(), |(_, rest)| rest);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|_| error("publish_shape"))?;
            if bytes.len() > 256 * 1024 {
                return Err(error("publish_too_large"));
            }
            owner_call(
                &s,
                reqwest::Method::PUT,
                "/api/v1/publications/profile/avatar",
                Body::Bytes(bytes),
            )
            .await?;
        }
        None => {
            owner_call(
                &s,
                reqwest::Method::DELETE,
                "/api/v1/publications/profile/avatar",
                Body::None,
            )
            .await?;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingRequest {
    pub assistant_id: String,
    pub description: String,
    pub category: String,
    /// The references the person ticked. Nothing else leaves the device.
    #[serde(default)]
    pub reference_ids: Vec<String>,
}

/// The permissions a definition asks for, in the catalog's words.
pub(crate) fn listing_permissions(definition: &AssistantDefinition) -> Vec<String> {
    let mut permissions: Vec<String> = definition
        .tools
        .iter()
        .filter(|key| LISTING_TOOLS.contains(&key.as_str()))
        .cloned()
        .collect();
    if definition.allow_notes {
        permissions.push("notes".into());
    }
    if definition.allow_memory {
        permissions.push("memory".into());
    }
    permissions.sort();
    permissions.dedup();
    permissions
}

pub async fn publish_assistant(
    app: &AppHandle,
    request: ListingRequest,
) -> Result<Value, AppError> {
    let pool = pool(app).await?;
    let definition = assistants::snapshot(&pool, &request.assistant_id).await?;
    let mut references = Vec::new();
    let mut bytes = 0;
    for reference in assistants::list_references(&pool, &definition.id).await? {
        if !request.reference_ids.contains(&reference.id) {
            continue;
        }
        // Only text travels: an image or a file's bytes are not published.
        if reference.status != "ready" || reference.text.trim().is_empty() {
            continue;
        }
        bytes += reference.name.len() + reference.text.len();
        if bytes > MAX_REFERENCE_BYTES {
            return Err(error("publish_too_large"));
        }
        references.push(json!({"name": reference.name, "text": reference.text}));
    }
    let description = if request.description.trim().is_empty() {
        definition.description.trim().to_string()
    } else {
        request.description.trim().to_string()
    };
    let s = session(&pool).await?;
    let overview = owner_call(&s, reqwest::Method::GET, "/api/v1/publications", Body::None).await?;
    let id = find(&overview, "assistants", &definition.id)
        .map(|listing| text(listing, "id").to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    owner_call(
        &s,
        reqwest::Method::PUT,
        &format!("/api/v1/publications/assistants/{id}"),
        Body::Json(json!({
            "source_id": definition.id,
            "name": definition.name,
            "description": description,
            "category": request.category,
            "instructions": definition.instructions,
            "starter": definition.opening_message,
            "permissions": listing_permissions(&definition),
            "references": references,
        })),
    )
    .await
}
pub async fn unpublish_assistant(app: &AppHandle, listing_id: &str) -> Result<(), AppError> {
    let id = checked_id(listing_id)?;
    let pool = pool(app).await?;
    let s = session(&pool).await?;
    owner_call(
        &s,
        reqwest::Method::DELETE,
        &format!("/api/v1/publications/assistants/{id}"),
        Body::None,
    )
    .await?;
    Ok(())
}

/// A catalog listing, read before anything is added. No account is needed:
/// the catalog is public, and it is read from this app's own account site,
/// never from an address the link carried.
pub async fn catalog_listing(app: &AppHandle, listing_id: &str) -> Result<Value, AppError> {
    let id = checked_id(listing_id)?;
    let base = super::site_origin(app).await;
    send(
        &base,
        None,
        reqwest::Method::GET,
        &format!("/api/v1/catalog/assistants/{id}"),
        Body::None,
        "catalog_not_found",
    )
    .await
}

/// What the person granted on import, out of what the listing asks for.
pub(crate) fn imported_definition(listing: &Value, granted: &[String]) -> AssistantDefinition {
    let asked: Vec<&str> = listing
        .get("permissions")
        .and_then(Value::as_array)
        .map(|keys| keys.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let allowed = |key: &str| asked.contains(&key) && granted.iter().any(|g| g == key);
    AssistantDefinition {
        name: text(listing, "name").chars().take(200).collect(),
        description: text(listing, "description").chars().take(4000).collect(),
        instructions: text(listing, "instructions").to_string(),
        opening_message: text(listing, "starter").to_string(),
        tools: LISTING_TOOLS
            .iter()
            .filter(|key| allowed(key))
            .map(|key| key.to_string())
            .collect(),
        allow_notes: allowed("notes"),
        allow_memory: allowed("memory"),
        ..Default::default()
    }
}

/// Adds a catalog assistant to this device: a new, ordinary assistant, with
/// only the permissions the person ticked and the listing's references as
/// text. It counts one import on the service.
pub async fn import_listing(
    app: &AppHandle,
    listing_id: &str,
    granted: Vec<String>,
) -> Result<AssistantDefinition, AppError> {
    let id = checked_id(listing_id)?;
    let base = super::site_origin(app).await;
    let listing = send(
        &base,
        None,
        reqwest::Method::POST,
        &format!("/api/v1/catalog/assistants/{id}/import"),
        Body::None,
        "catalog_not_found",
    )
    .await?;
    let pool = pool(app).await?;
    let definition = assistants::save(&pool, imported_definition(&listing, &granted)).await?;
    let now = chrono::Utc::now().to_rfc3339();
    for reference in listing
        .get("references")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(10)
    {
        let text = text(reference, "text");
        if text.trim().is_empty() || text.len() > assistants::MAX_TEXT {
            continue;
        }
        let name: String = reference
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Reference")
            .chars()
            .take(200)
            .collect();
        query("INSERT INTO assistant_references(id,assistant_id,name,format,text,status,created_at,updated_at) VALUES(?,?,?,'md',?,'ready',?,?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&definition.id)
            .bind(name)
            .bind(text)
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await?;
    }
    Ok(definition)
}

// The command surface. Every one is shared: both shells publish, and both
// open an "Add to Sub Rosa" link.
#[tauri::command]
pub async fn account_publications(app: AppHandle) -> Result<Value, AppError> {
    overview(&app).await
}
#[tauri::command]
pub async fn account_note_publication(
    app: AppHandle,
    note_id: String,
) -> Result<NotePublication, AppError> {
    note_status(&app, &note_id).await
}
#[tauri::command]
pub async fn account_publish_note(
    app: AppHandle,
    note_id: String,
    kind: Option<String>,
) -> Result<NotePublication, AppError> {
    publish_note(&app, &note_id, kind.as_deref().unwrap_or("note")).await
}
#[tauri::command]
pub async fn account_unpublish_page(app: AppHandle, page_id: String) -> Result<(), AppError> {
    unpublish_page(&app, &page_id).await
}
#[tauri::command]
pub async fn account_save_site(app: AppHandle, site: SiteRequest) -> Result<Value, AppError> {
    save_site(&app, site).await
}
#[tauri::command]
pub async fn account_delete_site(app: AppHandle, site_id: String) -> Result<(), AppError> {
    delete_site(&app, &site_id).await
}
#[tauri::command]
pub async fn account_save_public_profile(
    app: AppHandle,
    profile: ProfileRequest,
) -> Result<Value, AppError> {
    save_profile(&app, profile).await
}
#[tauri::command]
pub async fn account_delete_public_profile(app: AppHandle) -> Result<(), AppError> {
    delete_profile(&app).await
}
#[tauri::command]
pub async fn account_set_public_avatar(
    app: AppHandle,
    data: Option<String>,
) -> Result<(), AppError> {
    set_avatar(&app, data).await
}
#[tauri::command]
pub async fn account_publish_assistant(
    app: AppHandle,
    request: ListingRequest,
) -> Result<Value, AppError> {
    publish_assistant(&app, request).await
}
#[tauri::command]
pub async fn account_unpublish_assistant(
    app: AppHandle,
    listing_id: String,
) -> Result<(), AppError> {
    unpublish_assistant(&app, &listing_id).await
}
#[tauri::command]
pub async fn catalog_assistant_listing(
    app: AppHandle,
    listing_id: String,
) -> Result<Value, AppError> {
    catalog_listing(&app, &listing_id).await
}
#[tauri::command]
pub async fn catalog_assistant_import(
    app: AppHandle,
    listing_id: String,
    granted: Vec<String>,
) -> Result<AssistantDefinition, AppError> {
    import_listing(&app, &listing_id, granted).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The service hashes the same bytes (subrosa-cloud, `page_digest`); this
    /// vector is asserted on both sides.
    #[test]
    fn the_page_digest_matches_the_service() {
        assert_eq!(
            page_digest("Title", "Body"),
            "00f2f2dac8eaaabb92ee3fb6da5c27d99eddd4e9cc6761a924b7f63790e9a619"
        );
    }

    #[test]
    fn a_slug_is_readable_and_always_valid() {
        assert_eq!(
            slug_for("Réunion d'équipe : bilan", "a1b2c3"),
            "reunion-d-equipe-bilan-a1b2c3"
        );
        assert_eq!(slug_for("   ", "a1b2c3"), "page-a1b2c3");
        assert_eq!(slug_for("東京", "a1b2c3"), "page-a1b2c3");
        assert_eq!(slug_for("--Hello--World--", "a1b2c3"), "hello-world-a1b2c3");
        let long = slug_for(&"word ".repeat(40), "a1b2c3");
        assert!(long.len() <= 64, "{long}");
        for slug in [long, slug_for("ÀÉÎÕÜ ß", "abcdef")] {
            assert!(slug
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
            assert!(!slug.contains("--") && !slug.starts_with('-') && !slug.ends_with('-'));
        }
    }

    /// A listing asks for tool keys only, and an import grants only what the
    /// listing asked for and the person ticked.
    #[test]
    fn permissions_travel_as_asked_and_land_as_granted() {
        let definition = AssistantDefinition {
            tools: vec!["web".into(), "connector:mail-x1".into(), "image".into()],
            allow_notes: true,
            ..Default::default()
        };
        assert_eq!(
            listing_permissions(&definition),
            vec!["image", "notes", "web"]
        );
        let listing = json!({
            "name": "Editor", "description": "Edits", "instructions": "Be brief.",
            "starter": "Paste a paragraph.", "permissions": ["web", "notes", "memory"],
        });
        let imported = imported_definition(
            &listing,
            &[
                "web".into(),
                "image".into(),
                "memory".into(),
                "connector:mail-x1".into(),
            ],
        );
        assert_eq!(imported.tools, vec!["web"]);
        assert!(!imported.allow_notes, "asked for but not ticked");
        assert!(imported.allow_memory);
        assert_eq!(imported.opening_message, "Paste a paragraph.");
        assert!(
            imported.id.is_empty(),
            "a new assistant, never an overwrite"
        );
    }

    #[test]
    fn a_refusal_names_what_to_fix() {
        let rule = |rule: &str| json!({"error": {"code": "content_policy", "rule": rule}});
        assert_eq!(
            refusal(422, &rule("credential"), "x").code,
            "publish_credential"
        );
        assert_eq!(
            refusal(422, &rule("blocked_term"), "x").code,
            "publish_blocked"
        );
        assert_eq!(refusal(422, &rule("shape"), "x").code, "publish_shape");
        assert_eq!(
            refusal(409, &json!({"error": {"code": "slug_taken"}}), "x").code,
            "publish_slug_taken"
        );
        assert_eq!(
            refusal(403, &json!({"error": {"code": "taken_down"}}), "x").code,
            "publish_taken_down"
        );
        assert_eq!(
            refusal(404, &Value::Null, "catalog_not_found").code,
            "catalog_not_found"
        );
        assert_eq!(
            refusal(401, &Value::Null, "x").code,
            "account_not_connected"
        );
        assert_eq!(refusal(500, &Value::Null, "x").code, "publish_failed");
    }
}
