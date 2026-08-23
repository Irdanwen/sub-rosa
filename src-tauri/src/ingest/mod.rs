//! Turning a link into a note (ADR-0028).
//!
//! Three rails, in decreasing order of cleanliness: a file the user already
//! has, a URL somebody published, and a platform page — which is reachable
//! only through an extractor the user installed themselves, because the app
//! bundles no downloader and reimplements none.
//!
//! This module owns the two rails that need no extra software. It resolves the
//! link ([`link`]), reads the feed if there is one ([`feed`]), fetches the
//! bytes within bounds ([`fetch`]), and then hands the file to exactly the same
//! import path a dropped file takes — so a podcast episode and a Voice Memo
//! become notes through one implementation, not two.
//!
//! Everything before transcription is a durable row, so a download interrupted
//! by a lock screen is something the sweep re-drives rather than a lost task
//! (ADR-0018). Once the note exists, the note pipeline owns the rest.

pub mod extractor;
pub mod feed;
pub mod fetch;
pub mod link;
pub mod vtt;

use crate::domain::types::{AppError, IngestDto};
use link::LinkKind;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

/// Emitted whenever an ingest row changes, so the UI follows a download
/// without polling it.
pub const INGEST_EVENT: &str = "june://ingest";

/// Ceiling on a fetched file. Four hours of 1080p video is a few gigabytes,
/// and past that the user is importing something this app is not for.
const MAX_FETCH_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Fetches live in this process right now. A row parked in `fetching` means a
/// live download or a dead process, and the row alone cannot tell them apart.
static ACTIVE: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn active() -> MutexGuard<'static, HashSet<String>> {
    ACTIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

struct FetchClaim(String);

impl FetchClaim {
    fn take(id: &str) -> Option<Self> {
        let mut active = active();
        if !active.insert(id.to_string()) {
            return None;
        }
        Some(Self(id.to_string()))
    }
}

impl Drop for FetchClaim {
    fn drop(&mut self) {
        active().remove(&self.0);
    }
}

pub fn is_fetching(id: &str) -> bool {
    active().contains(id)
}

fn emit(app: &AppHandle, ingest: &IngestDto) {
    let _ = app.emit(INGEST_EVENT, ingest);
}

/// What a link is, answered without fetching anything.
///
/// The UI calls this as the user types, so it can say "this is a podcast feed"
/// or "this needs an extractor you do not have" before any request is made.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub kind: LinkKind,
    pub host: String,
    /// Whether this app can fetch it as things stand.
    pub fetchable: bool,
    /// Why not, when it cannot.
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn preview_ingest_link(app: AppHandle, url: String) -> Result<LinkPreview, AppError> {
    let resolved = link::resolve_link(&url)?;
    let (fetchable, reason) = match resolved.kind {
        LinkKind::DirectMedia | LinkKind::Feed => (true, None),
        LinkKind::PlatformPage if extractor_usable(&app) => (true, None),
        LinkKind::PlatformPage => (false, Some(platform_refusal(&resolved.host))),
    };
    Ok(LinkPreview {
        url: resolved.url,
        kind: resolved.kind,
        host: resolved.host,
        fetchable,
        reason,
    })
}

/// Whether the extractor rail can carry a platform page right now.
///
/// Always false on the phone, and not by omission: iOS cannot run a binary the
/// user installed elsewhere (ADR-0028).
fn extractor_usable(app: &AppHandle) -> bool {
    #[cfg(desktop)]
    {
        extractor::is_usable(app)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        false
    }
}

fn platform_refusal(host: &str) -> String {
    format!(
        "{host} does not publish a file this app can fetch. Download the audio yourself and drop the file here, or paste a podcast feed or a direct media link."
    )
}

/// Start fetching a link. Returns as soon as the row exists; the work runs on
/// a task and reports through [`INGEST_EVENT`].
#[tauri::command]
pub async fn start_link_ingest(
    app: AppHandle,
    url: String,
    folder_id: Option<String>,
) -> Result<IngestDto, AppError> {
    let resolved = link::resolve_link(&url)?;
    if resolved.kind == LinkKind::PlatformPage && !extractor_usable(&app) {
        return Err(AppError::new(
            "ingest_needs_extractor",
            platform_refusal(&resolved.host),
        ));
    }
    let repos = crate::commands::repositories(&app).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let ingest = repos
        .create_ingest(
            &id,
            &resolved.url,
            resolved.kind.as_db(),
            folder_id.as_deref(),
        )
        .await?;
    emit(&app, &ingest);
    spawn_fetch(app.clone(), id);
    Ok(ingest)
}

#[tauri::command]
pub async fn list_active_ingests(app: AppHandle) -> Result<Vec<IngestDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.active_ingests().await?)
}

/// Drop an ingest. Also the cancel: a fetch in flight notices the row is gone.
#[tauri::command]
pub async fn discard_ingest(app: AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    repos.delete_ingest(&id).await?;
    Ok(())
}

fn spawn_fetch(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(claim) = FetchClaim::take(&id) else {
            return;
        };
        let background = crate::ios_background::BackgroundTask::begin("link-ingest");
        let result = run(&app, &id).await;
        drop(background);
        drop(claim);
        if let Err(error) = result {
            tracing::warn!(ingest = %id, code = %error.code, "link ingest failed");
            if let Ok(repos) = crate::commands::repositories(&app).await {
                if let Ok(Some(ingest)) = repos.set_ingest_failed(&id, &error.message).await {
                    emit(&app, &ingest);
                }
            }
        }
    });
}

async fn run(app: &AppHandle, id: &str) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let Some(ingest) = repos.ingest(id).await? else {
        // Discarded before we got here: that is the cancel.
        return Ok(());
    };
    if ingest.status == "done" {
        return Ok(());
    }

    // A platform page has no file to fetch: the extractor produces one, plus
    // the captions that make transcription free (ADR-0028).
    #[cfg(desktop)]
    if LinkKind::from_db(&ingest.kind) == LinkKind::PlatformPage {
        return run_extraction(app, &repos, &ingest).await;
    }

    // Resolve a feed to its episode. A direct link is already its own answer.
    let (media_url, title) = match LinkKind::from_db(&ingest.kind) {
        LinkKind::Feed => {
            let body = fetch::fetch_text(&ingest.url, feed::MAX_FEED_BYTES).await?;
            let episode = feed::first_episode(&body)?;
            let title = match (&episode.show, &episode.title) {
                (Some(show), Some(title)) => Some(format!("{show}: {title}")),
                (None, Some(title)) => Some(title.clone()),
                (Some(show), None) => Some(show.clone()),
                (None, None) => None,
            };
            (episode.media_url, title)
        }
        _ => (ingest.url.clone(), ingest.title.clone()),
    };
    link::resolve_link(&media_url)?;
    let ingest = repos
        .set_ingest_resolved(id, &media_url, title.as_deref())
        .await?
        .unwrap_or(ingest);
    emit(app, &ingest);

    let file_name = link::file_name_for(&media_url, "mp3");
    let dest = std::env::temp_dir().join(format!("subrosa-ingest-{id}-{file_name}"));
    let fetched = {
        // The progress callback is sync, so the row write is queued rather than
        // awaited: a download must not stall on a database write.
        let app = app.clone();
        let repos = repos.clone();
        let id = id.to_string();
        fetch::fetch_to_file(&media_url, &dest, MAX_FETCH_BYTES, move |done, total| {
            let app = app.clone();
            let repos = repos.clone();
            let id = id.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(Some(ingest)) = repos
                    .set_ingest_progress(&id, done as i64, total.map(|value| value as i64))
                    .await
                {
                    emit(&app, &ingest);
                }
            });
        })
        .await
    };
    let fetched = match fetched {
        Ok(fetched) => fetched,
        Err(error) => {
            let _ = std::fs::remove_file(&dest);
            return Err(error);
        }
    };

    // Discarded mid-download: drop the bytes rather than making a note nobody
    // asked for any more.
    if repos.ingest(id).await?.is_none() {
        let _ = std::fs::remove_file(&fetched.path);
        return Ok(());
    }

    // From here it is an ordinary import, through the same code a dropped file
    // takes. `consume_source` is true: these bytes are the app's, not the
    // user's, and nothing else will ever clean them up.
    let note_name = title
        .as_deref()
        .map(|title| named_file(title, &file_name))
        .unwrap_or(file_name);
    let note = crate::commands::import_media_from_path(
        app,
        &fetched.path,
        &note_name,
        ingest.folder_id.clone(),
        true,
    )
    .await?;
    if let Some(ingest) = repos.set_ingest_done(id, &note.id).await? {
        emit(app, &ingest);
    }
    Ok(())
}

/// The extractor rail, end to end.
#[cfg(desktop)]
async fn run_extraction(
    app: &AppHandle,
    repos: &crate::db::repositories::Repositories,
    ingest: &IngestDto,
) -> Result<(), AppError> {
    let id = ingest.id.as_str();
    if let Some(updated) = repos.set_ingest_resolved(id, &ingest.url, None).await? {
        emit(app, &updated);
    }
    let work_dir = std::env::temp_dir().join(format!("subrosa-extract-{id}"));
    let _ = std::fs::remove_dir_all(&work_dir);
    let extracted = match extractor::extract(app, &ingest.url, &work_dir).await {
        Ok(extracted) => extracted,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&work_dir);
            return Err(error);
        }
    };

    // Discarded while the extractor was running: drop everything it made.
    if repos.ingest(id).await?.is_none() {
        let _ = std::fs::remove_dir_all(&work_dir);
        return Ok(());
    }

    let file_name = extracted
        .title
        .as_deref()
        .map(|title| named_file(title, "media.m4a"))
        .unwrap_or_else(|| {
            extracted
                .audio_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "media.m4a".to_string())
        });
    if !extracted.cues.is_empty() {
        tracing::info!(
            ingest = %id,
            cues = extracted.cues.len(),
            "using published captions instead of transcribing"
        );
    }
    let cues = (!extracted.cues.is_empty()).then_some(extracted.cues);
    let note = crate::commands::import_media_from_path_with_captions(
        app,
        &extracted.audio_path,
        &file_name,
        ingest.folder_id.clone(),
        // The audio is copied into the note, and the work directory goes with
        // the captions beside it.
        false,
        cues,
    )
    .await;
    let _ = std::fs::remove_dir_all(&work_dir);
    let note = note?;
    if let Some(updated) = repos.set_ingest_done(id, &note.id).await? {
        emit(app, &updated);
    }
    Ok(())
}

/// A file name that carries the episode's title, so the note is named after
/// the episode rather than after a CDN's idea of a file name.
fn named_file(title: &str, fallback_file_name: &str) -> String {
    let extension = link::path_extension(fallback_file_name).unwrap_or_else(|| "mp3".to_string());
    let cleaned: String = title
        .chars()
        .map(|character| {
            if character.is_control() || "/\\:*?\"<>|".contains(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.chars().take(120).collect();
    // A leading dot would make the file hidden, and a leading ".." reads as a
    // path even after the separators are gone. Strip dots and spaces together,
    // or "../../etc/passwd" merely becomes ".. etc passwd".
    let cleaned = cleaned.trim().trim_start_matches(['.', ' ']).to_string();
    if cleaned.trim().is_empty() {
        return fallback_file_name.to_string();
    }
    format!("{}.{extension}", cleaned.trim())
}

/// Re-drive downloads that were asked for and never finished. Called by
/// [`crate::background::sweep`].
pub async fn resume_unfinished(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(ingests) = repos.unfinished_ingests().await else {
        return;
    };
    for ingest in ingests {
        if is_fetching(&ingest.id) {
            continue;
        }
        // A link that has failed several times is a link that does not work.
        // Retrying it forever burns bandwidth and hides the real problem.
        if ingest.attempts >= 3 {
            if let Ok(Some(ingest)) = repos
                .set_ingest_failed(
                    &ingest.id,
                    "That link could not be fetched after several attempts.",
                )
                .await
            {
                emit(app, &ingest);
            }
            continue;
        }
        tracing::info!(ingest = %ingest.id, "resuming an unfinished link ingest");
        spawn_fetch(app.clone(), ingest.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_is_named_after_the_episode_not_the_cdn() {
        // The colon goes: legal here, illegal on Windows, and the note is
        // named from this on every platform.
        assert_eq!(
            named_file("Episode 42: pricing", "af8e2b1c.mp3"),
            "Episode 42 pricing.mp3"
        );
    }

    #[test]
    fn a_title_cannot_smuggle_a_path_into_the_file_name() {
        // Feed titles are attacker-controlled text that becomes a file name.
        for title in ["../../etc/passwd", "..\\..\\windows", "a/b/c", ".hidden"] {
            let named = named_file(title, "x.mp3");
            assert!(!named.contains('/'), "{title} -> {named}");
            assert!(!named.contains('\\'), "{title} -> {named}");
            assert!(!named.starts_with('.'), "{title} -> {named}");
        }
    }

    #[test]
    fn an_unusable_title_falls_back_to_the_url_file_name() {
        assert_eq!(named_file("   ", "episode.mp3"), "episode.mp3");
        assert_eq!(named_file("///", "episode.mp3"), "episode.mp3");
    }

    #[test]
    fn a_very_long_title_is_trimmed_rather_than_refused() {
        let named = named_file(&"a".repeat(400), "x.m4a");

        assert!(named.len() <= 130, "{} chars", named.len());
        assert!(named.ends_with(".m4a"));
    }
}
