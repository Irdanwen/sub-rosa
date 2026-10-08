//! Shared projects ("spaces") and group chats, end-to-end encrypted
//! (ADR-0098, docs/security/spaces-protocol.md). Behind a Preview switch
//! until the protocol has had an independent review.
//!
//! A space is shared by several accounts. Its content is encrypted under a
//! space key the service never holds, wrapped to each member's identity key;
//! every membership change is a new epoch with a new key. The service is a
//! courier: it stores ciphertext, public keys and signed heads, and decides
//! nothing a member's device does not check again here.
mod client;
pub mod commands;
pub mod hpke;
pub mod protocol;
mod store;
#[cfg(test)]
mod store_tests;
mod turns;

use crate::domain::types::AppError;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

pub(crate) fn not_found() -> AppError {
    AppError::new(
        "space_not_found",
        "This shared project is no longer available on this device.",
    )
}
pub(crate) fn invitation_unavailable() -> AppError {
    AppError::new(
        "space_invitation_unavailable",
        "This invitation has expired, was already used, or was withdrawn. Ask for a new link.",
    )
}
pub(crate) fn disabled() -> AppError {
    AppError::new(
        "spaces_disabled",
        "Turn on shared projects in Settings first. They are a preview.",
    )
}
pub(crate) fn owner_only() -> AppError {
    AppError::new(
        "space_owner_only",
        "Only the owner of this shared project can do this.",
    )
}
pub(crate) fn no_longer_member() -> AppError {
    AppError::new(
        "space_left",
        "You are no longer a member of this shared project. What you already received stays on this device.",
    )
}
pub(crate) fn acceptance_unverifiable() -> AppError {
    AppError::new(
        "space_acceptance_unverifiable",
        "This acceptance could not be verified on this device. Withdraw the invitation and send a new link from here.",
    )
}

static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LAST_RUN: Mutex<Option<Instant>> = Mutex::new(None);
/// How often the background loop looks at the service. A person waiting on a
/// reply is not left waiting on this: every write syncs at once.
const INTERVAL: Duration = Duration::from_secs(15);

/// The account loop and the launch sweep call this. It does nothing until
/// the switch is on, the account connected and the vault open.
pub async fn resume(app: &AppHandle) {
    {
        let mut last = LAST_RUN.lock().unwrap_or_else(|p| p.into_inner());
        if last.is_some_and(|at| at.elapsed() < INTERVAL) {
            return;
        }
        *last = Some(Instant::now());
    }
    if let Err(e) = run(app, None).await {
        if !matches!(
            e.code.as_str(),
            "account_not_connected" | "vault_locked" | "spaces_disabled"
        ) {
            tracing::warn!(code = %e.code, "shared projects synchronization deferred");
        }
    }
    turns::resume(app).await;
}

/// One pass over every space this device takes part in, or one of them.
pub(crate) async fn run(app: &AppHandle, only: Option<&str>) -> Result<(), AppError> {
    let _guard = SYNC_LOCK.lock().await;
    let _background = crate::ios_background::BackgroundTask::begin("spaces-sync");
    let pool = crate::account::pool(app).await?;
    if !store::settings(&pool).await?.enabled {
        return Err(disabled());
    }
    let ctx = client::context(&pool).await?;
    let mut changed = Vec::new();
    for row in store::spaces(&pool).await? {
        if !matches!(row.state.as_str(), "active" | "pending")
            || only.is_some_and(|id| id != row.id)
        {
            continue;
        }
        match sync_one(&pool, &ctx, &row).await {
            Ok(new_messages) => {
                if new_messages > 0 {
                    notify(app, &row.name, new_messages);
                }
                changed.push(row.id.clone());
            }
            Err(e) => {
                tracing::warn!(code = %e.code, "a shared project could not be synchronized");
                store::set_error(&pool, &row.id, Some(&e.code)).await?;
                changed.push(row.id.clone());
            }
        }
    }
    let _ = app.emit("subrosa://spaces-updated", changed);
    Ok(())
}

async fn sync_one(
    pool: &sqlx_sqlite::SqlitePool,
    ctx: &client::Ctx,
    row: &store::SpaceRow,
) -> Result<i64, AppError> {
    // A rotation made here is read back before anything is sealed, so the
    // outbox goes out under the epoch it just created.
    for _ in 0..2 {
        let v = match client::fetch(pool, ctx, row).await? {
            client::Fetched::Gone => {
                if row.state == "active" {
                    store::set_state(pool, &row.id, "removed").await?;
                }
                return Ok(0);
            }
            client::Fetched::Verified(v) => v,
        };
        if row.state == "pending" {
            store::set_state(pool, &row.id, "active").await?;
        }
        if client::rotate_if_due(ctx, &row.id, &v).await? {
            continue;
        }
        let row = store::space(pool, &row.id).await?;
        let new_messages = client::pull(pool, ctx, &row, &v).await?;
        client::flush(pool, ctx, &row, &v).await?;
        return Ok(new_messages);
    }
    Ok(0)
}

/// A local notification for messages from other members, in the person's
/// language. The project's name is theirs, so it is not translated.
fn notify(app: &AppHandle, space_name: &str, count: i64) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(crate::tr!("New messages in a shared project"))
        .body(format!("{space_name} ({count})"))
        .show();
}

/// Starts a pass in the background, after a write, so it leaves now rather
/// than at the next tick.
pub(crate) fn kick(app: &AppHandle, only: Option<String>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(&app, only.as_deref()).await {
            tracing::debug!(code = %e.code, "shared projects pass deferred");
        }
        turns::resume(&app).await;
    });
}
