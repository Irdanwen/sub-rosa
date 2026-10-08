//! The commands both shells call for shared projects. Every one of them is a
//! shared command and sits in both `generate_handler!` lists.
use super::client::{self, Acceptance};
use super::protocol::{self, HeadMember, IdentityBundle, ROLE_MEMBER};
use super::store;
use crate::domain::types::AppError;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx_sqlite::SqlitePool;
use std::collections::HashMap;
use tauri::AppHandle;

const MAX_NAME_CHARS: usize = 80;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacesStatus {
    pub enabled: bool,
    pub display_name: String,
    pub spaces: Vec<SpaceSummaryDto>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSummaryDto {
    pub id: String,
    pub name: String,
    pub role: String,
    pub state: String,
    pub source_folder_id: Option<String>,
    pub unread: i64,
    pub last_error: Option<String>,
    pub updated_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDto {
    pub account_id: String,
    pub name: Option<String>,
    pub role: String,
    pub is_me: bool,
    pub verified: bool,
    /// Twelve groups of five digits, the same on both devices.
    pub safety_number: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDto {
    pub id: String,
    pub title: String,
    pub body: String,
    pub format: Option<String>,
    pub author_name: Option<String>,
    pub pending: bool,
    pub created_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDto {
    pub id: String,
    pub title: String,
    pub messages: usize,
    pub last_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDto {
    pub id: String,
    pub conversation_id: String,
    pub failed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDto {
    pub summary: SpaceSummaryDto,
    pub instructions: String,
    pub is_owner: bool,
    pub members: Vec<MemberDto>,
    pub notes: Vec<ContentDto>,
    pub files: Vec<ContentDto>,
    pub conversations: Vec<ConversationDto>,
    pub turns: Vec<TurnDto>,
    pub pending_writes: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub role: String,
    pub text: String,
    pub author_id: String,
    pub author_name: Option<String>,
    pub is_mine: bool,
    pub model: Option<String>,
    pub paid_by_name: Option<String>,
    pub pending: bool,
    pub created_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationDto {
    pub id: String,
    pub link: String,
    pub code: String,
    pub expires_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInvitationDto {
    pub id: String,
    pub expires_at: String,
    /// `waiting` for someone to open the link, `ready` to admit (the proof
    /// held), `unverifiable` (made on another device, or the proof failed).
    pub state: String,
    pub safety_number: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationPreviewDto {
    pub invitation_id: String,
    pub space_id: String,
    pub space_name: String,
    pub expires_at: String,
    pub safety_number: Vec<String>,
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    crate::account::pool(app).await
}
async fn enabled_pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    let pool = pool(app).await?;
    if !store::settings(&pool).await?.enabled {
        return Err(super::disabled());
    }
    Ok(pool)
}
fn summary(row: &store::SpaceRow) -> SpaceSummaryDto {
    SpaceSummaryDto {
        id: row.id.clone(),
        name: row.name.clone(),
        role: row.role.clone(),
        state: row.state.clone(),
        source_folder_id: row.source_folder_id.clone(),
        unread: row.unread,
        last_error: row.last_error.clone(),
        updated_at: row.updated_at.clone(),
    }
}
fn my_bundle(settings: &store::Settings) -> Option<IdentityBundle> {
    settings
        .identity_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
}
/// The object a member's display name lives in: one per member per space,
/// so renaming is an edit, not a second profile.
pub fn profile_id(space_id: &str, account_id: &str) -> String {
    let namespace = uuid::Uuid::parse_str(space_id).unwrap_or_default();
    uuid::Uuid::new_v5(&namespace, account_id.as_bytes()).to_string()
}
/// Display names, from the members' own profile objects.
pub async fn names(pool: &SqlitePool, space_id: &str) -> Result<HashMap<String, String>, AppError> {
    let mut names = HashMap::new();
    for member in store::members(pool, space_id).await? {
        let id = profile_id(space_id, &member.account_id);
        if let Some(profile) = store::objects(pool, space_id, "profile")
            .await?
            .into_iter()
            .find(|p| p.object_id == id)
        {
            if let Some(name) = profile.data["name"]
                .as_str()
                .filter(|n| !n.trim().is_empty())
            {
                names.insert(member.account_id.clone(), name.to_string());
            }
        }
    }
    Ok(names)
}
fn clean(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}
async fn enqueue(
    pool: &SqlitePool,
    space_id: &str,
    object_id: &str,
    kind: &str,
    data: &Value,
) -> Result<(), AppError> {
    protocol::check_data(kind, data, "")?;
    store::enqueue(
        pool,
        store::Enqueue {
            space_id,
            object_id,
            kind,
            data,
            deleted: false,
        },
    )
    .await
}
async fn writable(pool: &SqlitePool, space_id: &str) -> Result<store::SpaceRow, AppError> {
    let row = store::space(pool, space_id).await?;
    if row.state != "active" {
        return Err(super::no_longer_member());
    }
    Ok(row)
}
/// A fresh verified view of one space, for the actions that change its
/// membership.
async fn verified(
    pool: &SqlitePool,
    ctx: &client::Ctx,
    row: &store::SpaceRow,
) -> Result<Box<client::Verified>, AppError> {
    match client::fetch(pool, ctx, row).await? {
        client::Fetched::Verified(v) => Ok(v),
        client::Fetched::Gone => Err(super::no_longer_member()),
    }
}

#[tauri::command]
pub async fn spaces_status(app: AppHandle) -> Result<SpacesStatus, AppError> {
    let pool = pool(&app).await?;
    let settings = store::settings(&pool).await?;
    let spaces = if settings.enabled {
        store::spaces(&pool).await?.iter().map(summary).collect()
    } else {
        Vec::new()
    };
    Ok(SpacesStatus {
        enabled: settings.enabled,
        display_name: settings.display_name,
        spaces,
    })
}

#[tauri::command]
pub async fn spaces_set_enabled(
    app: AppHandle,
    enabled: bool,
    display_name: String,
) -> Result<SpacesStatus, AppError> {
    let pool = pool(&app).await?;
    store::save_settings(&pool, enabled, &clean(&display_name, MAX_NAME_CHARS)).await?;
    if enabled {
        // Every space hears the new name.
        let name = clean(&display_name, MAX_NAME_CHARS);
        if let Some(me) = my_bundle(&store::settings(&pool).await?) {
            for row in store::spaces(&pool).await? {
                if row.state == "active" && !name.is_empty() {
                    enqueue(
                        &pool,
                        &row.id,
                        &profile_id(&row.id, &me.account_id),
                        "profile",
                        &json!({"name": name}),
                    )
                    .await?;
                }
            }
        }
        super::kick(&app, None);
    }
    spaces_status(app).await
}

/// Shares a project: a new space whose first content is the project's name,
/// instructions, files and notes, copied (the project itself stays as it
/// is).
#[tauri::command]
pub async fn spaces_create(app: AppHandle, folder_id: String) -> Result<SpaceSummaryDto, AppError> {
    let pool = enabled_pool(&app).await?;
    let project = crate::projects::context::for_folder(&pool, &folder_id)
        .await
        .ok_or_else(super::not_found)?;
    let ctx = client::context(&pool).await?;
    let name = clean(&project.name, 200);
    let space_id = client::create(&pool, &ctx, &name, Some(&folder_id)).await?;
    enqueue(
        &pool,
        &space_id,
        &space_id,
        "project",
        &json!({"name": name, "instructions": clean(&project.instructions, 8000)}),
    )
    .await?;
    let display = store::settings(&pool).await?.display_name;
    if !display.is_empty() {
        enqueue(
            &pool,
            &space_id,
            &profile_id(&space_id, ctx.me()),
            "profile",
            &json!({"name": display}),
        )
        .await?;
    }
    for (file_name, format, text) in project_files(&pool, &folder_id).await? {
        enqueue(
            &pool,
            &space_id,
            &uuid::Uuid::new_v4().to_string(),
            "file",
            &json!({"name": clean(&file_name, 300), "format": clean(&format, 40), "text": clean(&text, 400_000)}),
        )
        .await?;
    }
    for (title, body) in project_notes(&pool, &folder_id).await? {
        enqueue(
            &pool,
            &space_id,
            &uuid::Uuid::new_v4().to_string(),
            "note",
            &json!({"title": clean(&title, 300), "body": clean(&body, 200_000)}),
        )
        .await?;
    }
    super::kick(&app, Some(space_id.clone()));
    Ok(summary(&store::space(&pool, &space_id).await?))
}

/// A project's files as text: what was read from them. An image, with no
/// text, is not carried.
async fn project_files(
    pool: &SqlitePool,
    folder_id: &str,
) -> Result<Vec<(String, String, String)>, AppError> {
    use sqlx::{query::query, row::Row};
    Ok(query("SELECT name, format, text FROM project_files WHERE folder_id = ? AND status = 'ready' AND trim(text) <> '' ORDER BY created_at, id")
        .bind(folder_id)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| (row.get("name"), row.get("format"), row.get("text")))
        .collect())
}

async fn project_notes(
    pool: &SqlitePool,
    folder_id: &str,
) -> Result<Vec<(String, String)>, AppError> {
    use sqlx::{query::query, row::Row};
    Ok(query("SELECT n.title, COALESCE(n.edited_content, n.generated_content, '') AS body FROM notes n JOIN note_folders f ON f.note_id = n.id WHERE f.folder_id = ? ORDER BY n.created_at")
        .bind(folder_id)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| (row.get("title"), row.get("body")))
        .collect())
}

#[tauri::command]
pub async fn spaces_get(app: AppHandle, space_id: String) -> Result<SpaceDto, AppError> {
    let pool = enabled_pool(&app).await?;
    let row = store::space(&pool, &space_id).await?;
    let settings = store::settings(&pool).await?;
    let me = my_bundle(&settings);
    let names = names(&pool, &space_id).await?;
    let name_of = |id: &str| names.get(id).cloned();
    let members = store::members(&pool, &space_id)
        .await?
        .into_iter()
        .map(|m| MemberDto {
            name: name_of(&m.account_id),
            is_me: me.as_ref().is_some_and(|b| b.account_id == m.account_id),
            safety_number: me
                .as_ref()
                .map(|b| protocol::grouped(&protocol::safety_number(b, &m.bundle)))
                .unwrap_or_default(),
            account_id: m.account_id,
            role: m.role,
            verified: m.verified,
        })
        .collect();
    let my_id = me
        .as_ref()
        .map(|b| b.account_id.clone())
        .unwrap_or_default();
    let content = |o: store::ObjectRow, title: &str, body: &str| ContentDto {
        title: o.data[title].as_str().unwrap_or_default().to_string(),
        body: o.data[body].as_str().unwrap_or_default().to_string(),
        format: o.data["format"].as_str().map(str::to_string),
        author_name: if o.pending {
            name_of(&my_id)
        } else {
            name_of(&o.author)
        },
        pending: o.pending,
        created_at: o.created_at,
        id: o.object_id,
    };
    let notes = store::objects(&pool, &space_id, "note")
        .await?
        .into_iter()
        .map(|o| content(o, "title", "body"))
        .collect();
    let files = store::objects(&pool, &space_id, "file")
        .await?
        .into_iter()
        .map(|o| content(o, "name", "text"))
        .collect();
    let messages = store::objects(&pool, &space_id, "message").await?;
    let conversations = store::objects(&pool, &space_id, "conversation")
        .await?
        .into_iter()
        .map(|c| {
            let inside: Vec<&store::ObjectRow> = messages
                .iter()
                .filter(|m| m.data["conversation_id"] == c.object_id.as_str())
                .collect();
            ConversationDto {
                title: c.data["title"].as_str().unwrap_or_default().to_string(),
                messages: inside.len(),
                last_at: inside
                    .iter()
                    .map(|m| m.created_at.clone())
                    .max()
                    .unwrap_or_else(|| c.created_at.clone()),
                id: c.object_id,
            }
        })
        .collect();
    let instructions = store::objects(&pool, &space_id, "project")
        .await?
        .first()
        .and_then(|p| p.data["instructions"].as_str().map(str::to_string))
        .unwrap_or_default();
    let turns = store::turns(&pool)
        .await?
        .into_iter()
        .filter(|t| t.space_id == space_id)
        .map(|t| TurnDto {
            failed: t.last_error.is_some(),
            id: t.id,
            conversation_id: t.conversation_id,
        })
        .collect();
    Ok(SpaceDto {
        is_owner: row.owner_account_id == my_id,
        summary: summary(&row),
        instructions,
        members,
        notes,
        files,
        conversations,
        turns,
        pending_writes: store::pending_writes(&pool, &space_id).await?,
    })
}

#[tauri::command]
pub async fn spaces_sync(app: AppHandle, space_id: Option<String>) -> Result<(), AppError> {
    super::run(&app, space_id.as_deref()).await
}

#[tauri::command]
pub async fn spaces_mark_read(app: AppHandle, space_id: String) -> Result<(), AppError> {
    store::mark_read(&pool(&app).await?, &space_id).await
}

#[tauri::command]
pub async fn spaces_invite(app: AppHandle, space_id: String) -> Result<InvitationDto, AppError> {
    let pool = enabled_pool(&app).await?;
    let row = writable(&pool, &space_id).await?;
    let ctx = client::context(&pool).await?;
    if row.owner_account_id != ctx.me() {
        return Err(super::owner_only());
    }
    let invitation = client::invite(&pool, &ctx, &row).await?;
    let site = crate::account::site_origin(&app).await;
    Ok(InvitationDto {
        link: format!("{site}/app#join={}", invitation.code),
        code: invitation.code,
        id: invitation.id,
        expires_at: invitation.expires_at,
    })
}

#[tauri::command]
pub async fn spaces_invitations(
    app: AppHandle,
    space_id: String,
) -> Result<Vec<PendingInvitationDto>, AppError> {
    let pool = enabled_pool(&app).await?;
    let row = writable(&pool, &space_id).await?;
    let ctx = client::context(&pool).await?;
    if row.owner_account_id != ctx.me() {
        return Ok(Vec::new());
    }
    let v = verified(&pool, &ctx, &row).await?;
    let mut out = Vec::new();
    for invitation in &v.detail.invitations {
        let (state, safety_number) =
            match client::check_acceptance(&pool, &space_id, invitation).await? {
                None => ("waiting", Vec::new()),
                Some(Acceptance::Unverifiable) => ("unverifiable", Vec::new()),
                Some(Acceptance::Verified(member)) => (
                    "ready",
                    protocol::grouped(&protocol::safety_number(&ctx.bundle, &member)),
                ),
            };
        out.push(PendingInvitationDto {
            id: invitation.id.clone(),
            expires_at: invitation.expires_at.clone(),
            state: state.to_string(),
            safety_number,
        });
    }
    Ok(out)
}

/// The owner admits someone whose acceptance holds: a new epoch with them
/// in it, and the earlier keys sealed to them.
#[tauri::command]
pub async fn spaces_admit(
    app: AppHandle,
    space_id: String,
    invitation_id: String,
) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    let row = writable(&pool, &space_id).await?;
    let ctx = client::context(&pool).await?;
    if row.owner_account_id != ctx.me() {
        return Err(super::owner_only());
    }
    let _guard = super::SYNC_LOCK.lock().await;
    let v = verified(&pool, &ctx, &row).await?;
    let invitation = v
        .detail
        .invitations
        .iter()
        .find(|i| i.id == invitation_id)
        .cloned()
        .ok_or_else(super::invitation_unavailable)?;
    let Some(Acceptance::Verified(member)) =
        client::check_acceptance(&pool, &space_id, &invitation).await?
    else {
        return Err(super::acceptance_unverifiable());
    };
    let mut members = v.latest.members.clone();
    members.retain(|m| m.account_id != member.account_id);
    members.push(HeadMember::from_bundle(&member, ROLE_MEMBER));
    client::rotate(
        &ctx,
        &space_id,
        &v,
        members,
        Vec::new(),
        Some(client::Admission {
            invitation_id: &invitation_id,
            member: &member,
        }),
    )
    .await?;
    store::forget_invitation(&pool, &invitation_id).await?;
    drop(_guard);
    super::kick(&app, Some(space_id));
    Ok(())
}

#[tauri::command]
pub async fn spaces_revoke_invitation(
    app: AppHandle,
    space_id: String,
    invitation_id: String,
) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    let ctx = client::context(&pool).await?;
    client::revoke_invitation(&ctx, &space_id, &invitation_id).await?;
    store::forget_invitation(&pool, &invitation_id).await
}

#[tauri::command]
pub async fn spaces_open_invitation(
    app: AppHandle,
    code: String,
) -> Result<InvitationPreviewDto, AppError> {
    let pool = enabled_pool(&app).await?;
    let ctx = client::context(&pool).await?;
    let opened = client::open_invitation(&ctx, &code).await?;
    Ok(InvitationPreviewDto {
        invitation_id: opened.invitation_id.clone(),
        space_id: opened.payload.space_id.clone(),
        space_name: opened.payload.space_name.clone(),
        expires_at: opened.payload.expires_at.clone(),
        safety_number: protocol::grouped(&protocol::safety_number(
            &ctx.bundle,
            &opened.payload.inviter,
        )),
    })
}

#[tauri::command]
pub async fn spaces_accept_invitation(
    app: AppHandle,
    code: String,
) -> Result<SpaceSummaryDto, AppError> {
    let pool = enabled_pool(&app).await?;
    let ctx = client::context(&pool).await?;
    let opened = client::open_invitation(&ctx, &code).await?;
    client::accept(&pool, &ctx, &opened).await?;
    let display = store::settings(&pool).await?.display_name;
    if !display.is_empty() {
        // Sent once the owner admits this account; until then it waits.
        enqueue(
            &pool,
            &opened.payload.space_id,
            &profile_id(&opened.payload.space_id, ctx.me()),
            "profile",
            &json!({"name": display}),
        )
        .await?;
    }
    Ok(summary(
        &store::space(&pool, &opened.payload.space_id).await?,
    ))
}

#[tauri::command]
pub async fn spaces_remove_member(
    app: AppHandle,
    space_id: String,
    account_id: String,
) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    let row = writable(&pool, &space_id).await?;
    let ctx = client::context(&pool).await?;
    if row.owner_account_id != ctx.me() || account_id == ctx.me() {
        return Err(super::owner_only());
    }
    let _guard = super::SYNC_LOCK.lock().await;
    let v = verified(&pool, &ctx, &row).await?;
    let members: Vec<HeadMember> = v
        .latest
        .members
        .iter()
        .filter(|m| m.account_id != account_id)
        .cloned()
        .collect();
    if members.len() == v.latest.members.len() {
        return Ok(());
    }
    client::rotate(&ctx, &space_id, &v, members, Vec::new(), None).await?;
    drop(_guard);
    super::kick(&app, Some(space_id));
    Ok(())
}

#[tauri::command]
pub async fn spaces_leave(app: AppHandle, space_id: String) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    let row = store::space(&pool, &space_id).await?;
    let ctx = client::context(&pool).await?;
    if row.owner_account_id == ctx.me() {
        return Err(AppError::new(
            "space_owner_cannot_leave",
            "As the owner, delete the shared project instead of leaving it.",
        ));
    }
    if row.state == "pending" {
        store::forget(&pool, &space_id).await?;
        return Ok(());
    }
    let _guard = super::SYNC_LOCK.lock().await;
    let v = verified(&pool, &ctx, &row).await?;
    client::leave(&ctx, &space_id, &v).await?;
    store::set_state(&pool, &space_id, "left").await
}

#[tauri::command]
pub async fn spaces_delete(app: AppHandle, space_id: String) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    let row = store::space(&pool, &space_id).await?;
    let ctx = client::context(&pool).await?;
    if row.owner_account_id != ctx.me() {
        return Err(super::owner_only());
    }
    client::delete(&ctx, &space_id).await?;
    store::forget(&pool, &space_id).await
}

/// Forgets, on this device only, a space this account is no longer in.
#[tauri::command]
pub async fn spaces_forget(app: AppHandle, space_id: String) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    let row = store::space(&pool, &space_id).await?;
    if matches!(row.state.as_str(), "active" | "pending") {
        return Ok(());
    }
    store::forget(&pool, &space_id).await
}

#[tauri::command]
pub async fn spaces_set_verified(
    app: AppHandle,
    space_id: String,
    account_id: String,
    verified: bool,
) -> Result<(), AppError> {
    store::set_verified(&pool(&app).await?, &space_id, &account_id, verified).await
}

#[tauri::command]
pub async fn spaces_save_project(
    app: AppHandle,
    space_id: String,
    name: String,
    instructions: String,
) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    writable(&pool, &space_id).await?;
    let name = clean(&name, 200);
    enqueue(
        &pool,
        &space_id,
        &space_id,
        "project",
        &json!({"name": name, "instructions": clean(&instructions, 8000)}),
    )
    .await?;
    store::set_name(&pool, &space_id, &name).await?;
    super::kick(&app, Some(space_id));
    Ok(())
}

#[tauri::command]
pub async fn spaces_save_note(
    app: AppHandle,
    space_id: String,
    note_id: Option<String>,
    title: String,
    body: String,
) -> Result<String, AppError> {
    let pool = enabled_pool(&app).await?;
    writable(&pool, &space_id).await?;
    let id = note_id
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    enqueue(
        &pool,
        &space_id,
        &id,
        "note",
        &json!({"title": clean(&title, 300), "body": body.chars().take(200_000).collect::<String>()}),
    )
    .await?;
    super::kick(&app, Some(space_id));
    Ok(id)
}

#[tauri::command]
pub async fn spaces_delete_object(
    app: AppHandle,
    space_id: String,
    object_id: String,
) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    writable(&pool, &space_id).await?;
    let kind = ["note", "file", "conversation"];
    let mut found = None;
    for k in kind {
        if store::objects(&pool, &space_id, k)
            .await?
            .iter()
            .any(|o| o.object_id == object_id)
        {
            found = Some(k);
        }
    }
    let kind = found.ok_or_else(super::not_found)?;
    store::enqueue(
        &pool,
        store::Enqueue {
            space_id: &space_id,
            object_id: &object_id,
            kind,
            data: &json!({}),
            deleted: true,
        },
    )
    .await?;
    super::kick(&app, Some(space_id));
    Ok(())
}

#[tauri::command]
pub async fn spaces_messages(
    app: AppHandle,
    space_id: String,
    conversation_id: String,
) -> Result<Vec<MessageDto>, AppError> {
    let pool = enabled_pool(&app).await?;
    let me = my_bundle(&store::settings(&pool).await?)
        .map(|b| b.account_id)
        .unwrap_or_default();
    let names = names(&pool, &space_id).await?;
    Ok(
        super::turns::conversation(&pool, &space_id, &conversation_id)
            .await?
            .into_iter()
            .map(|m| {
                let author = if m.pending {
                    me.clone()
                } else {
                    m.author.clone()
                };
                MessageDto {
                    role: m.data["role"].as_str().unwrap_or("user").to_string(),
                    text: m.data["text"].as_str().unwrap_or_default().to_string(),
                    author_name: names.get(&author).cloned(),
                    is_mine: author == me,
                    model: m.data["model"].as_str().map(str::to_string),
                    paid_by_name: m.data["paid_by"]
                        .as_str()
                        .and_then(|payer| names.get(payer).cloned()),
                    pending: m.pending,
                    created_at: m.created_at,
                    author_id: author,
                    id: m.object_id,
                }
            })
            .collect(),
    )
}

#[tauri::command]
pub async fn spaces_new_conversation(
    app: AppHandle,
    space_id: String,
    title: String,
) -> Result<String, AppError> {
    let pool = enabled_pool(&app).await?;
    writable(&pool, &space_id).await?;
    let id = uuid::Uuid::new_v4().to_string();
    enqueue(
        &pool,
        &space_id,
        &id,
        "conversation",
        &json!({"title": clean(&title, 300)}),
    )
    .await?;
    super::kick(&app, Some(space_id));
    Ok(id)
}

/// Posts a message to everyone in the space, and when asked, has the
/// assistant answer it on this device, with this account's key.
#[tauri::command]
pub async fn spaces_send_message(
    app: AppHandle,
    space_id: String,
    conversation_id: String,
    text: String,
    ask_assistant: bool,
) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    writable(&pool, &space_id).await?;
    let text: String = text.trim().chars().take(100_000).collect();
    if text.is_empty() {
        return Err(AppError::new(
            "space_empty_message",
            "Write a message first.",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    enqueue(
        &pool,
        &space_id,
        &id,
        "message",
        &json!({"conversation_id": conversation_id, "role": "user", "text": text}),
    )
    .await?;
    if ask_assistant {
        store::add_turn(&pool, &space_id, &conversation_id, &id).await?;
    }
    super::kick(&app, Some(space_id));
    Ok(())
}

#[tauri::command]
pub async fn spaces_retry_turn(app: AppHandle, turn_id: String) -> Result<(), AppError> {
    let pool = enabled_pool(&app).await?;
    store::turn_retry(&pool, &turn_id).await?;
    super::kick(&app, None);
    Ok(())
}
