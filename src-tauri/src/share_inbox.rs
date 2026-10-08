//! The app's half of "share to Sub Rosa" (ADR-0048).
//!
//! The share extension (`gen/apple/ShareExtension`) is another process with
//! no access to the app's data. It leaves what was shared in the app group
//! container (`share-inbox/<id>.json`, plus the file when there is one) and
//! opens the app on `subrosa://share/<id>`. This module reads that manifest,
//! validates it, and hands it to the machinery every import already uses:
//! a link starts an ingest (ADR-0028), a file becomes a note the way a
//! picked file does, a text becomes a note as written. The inbox entry is
//! deleted once it is consumed, so a manifest is acted on once.
//!
//! Android fills the same inbox from its share target
//! (`android/…/ShareReceiverActivity.kt`, ADR-0095): the manifest is the same,
//! only the folder differs (the app's own data directory, since the receiving
//! activity runs in the app's process). Only the folder lookup is
//! per-platform; the manifest and the id rules are plain Rust, tested on
//! every platform.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::domain::types::AppError;

pub const APP_GROUP: &str = "group.xyz.carpediem.subrosa";
const INBOX_DIR: &str = "share-inbox";
const MAX_TEXT_CHARS: usize = 200_000;
/// An image handed to a chat travels inline; the shell downsizes it before
/// the turn, but the IPC answer has to carry the original first.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// A share the app has not acted on yet is picked up by the sweep for this
/// long; after that it is a leftover, not a request (the same window as the
/// Shortcuts inbox).
const PENDING_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);
const MAX_PENDING: usize = 10;
const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSharedItemRequest {
    pub item_id: String,
}

/// What the extension wrote: one of three shapes.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SharedManifest {
    Link {
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    File {
        file_name: String,
    },
    Text {
        text: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedImport {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ingest_id: Option<String>,
    /// A video page this device cannot read (`kind: "platform"`): the link,
    /// handed back so the shell can offer it to a computer that can.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// A picture or a document (`kind: "attachment"`): what a chat turn
    /// carries of it, for the shell to put in a fresh chat's composer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<SharedAttachment>,
}

/// The shape agent-lite takes for a turn's attachment: an image as a data
/// URL, a document as its text.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedAttachment {
    pub kind: &'static str,
    pub name: String,
    pub data: String,
}

/// What a shared file becomes, decided by its extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SharedFileUse {
    /// A picture: attached to a fresh chat.
    Image,
    /// A PDF, an Office file or a text file: its text attached to a chat.
    Document,
    /// Anything else goes through the audio and video import, which says so
    /// when it cannot read the format.
    Recording,
}

pub fn shared_file_use(file_name: &str) -> SharedFileUse {
    let format = crate::documents::format_of(file_name);
    if IMAGE_EXTENSIONS.contains(&format.as_str()) {
        SharedFileUse::Image
    } else if crate::documents::is_document(&format)
        || matches!(format.as_str(), "txt" | "md" | "csv")
    {
        SharedFileUse::Document
    } else {
        SharedFileUse::Recording
    }
}

fn image_mime(file_name: &str) -> &'static str {
    match crate::documents::format_of(file_name).as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        _ => "image/jpeg",
    }
}

/// An inbox id is a UUID the extension made: hex and dashes, nothing that
/// could name a path.
pub fn valid_item_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A file name the extension wrote (`<id>-<original>`), kept to one path
/// segment so the manifest cannot point outside the inbox.
pub fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != ".."
}

pub fn parse_manifest(bytes: &[u8]) -> Result<SharedManifest, AppError> {
    let manifest: SharedManifest = serde_json::from_slice(bytes)
        .map_err(|_| AppError::new("share_inbox_invalid", "That shared item could not be read."))?;
    match &manifest {
        SharedManifest::Link { url }
            if !url.starts_with("http://") && !url.starts_with("https://") =>
        {
            Err(AppError::new(
                "share_inbox_invalid",
                "Only web links can be shared in.",
            ))
        }
        SharedManifest::File { file_name } if !valid_file_name(file_name) => Err(AppError::new(
            "share_inbox_invalid",
            "That shared file has no usable name.",
        )),
        SharedManifest::Text { text } if text.trim().is_empty() => Err(AppError::new(
            "share_inbox_invalid",
            "That shared text is empty.",
        )),
        SharedManifest::Text { text } if text.chars().count() > MAX_TEXT_CHARS => {
            Err(AppError::new(
                "share_inbox_invalid",
                "That shared text is too long for a note.",
            ))
        }
        _ => Ok(manifest),
    }
}

/// The app group container, where the extension can write and the app can
/// read. iOS only: nowhere else has a share extension.
#[cfg(target_os = "ios")]
pub fn app_group_container() -> Option<PathBuf> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;
    unsafe {
        let manager_class = AnyClass::get(c"NSFileManager")?;
        let manager: *mut AnyObject = msg_send![manager_class, defaultManager];
        if manager.is_null() {
            return None;
        }
        let group = NSString::from_str(APP_GROUP);
        let url: *mut AnyObject =
            msg_send![manager, containerURLForSecurityApplicationGroupIdentifier: &*group];
        if url.is_null() {
            return None;
        }
        let path: *mut NSString = msg_send![url, path];
        if path.is_null() {
            return None;
        }
        Some(PathBuf::from((*path).to_string()))
    }
}

#[cfg(not(target_os = "ios"))]
pub fn app_group_container() -> Option<PathBuf> {
    None
}

/// Where the share inbox lives on this platform: the app group on iOS (the
/// extension is another process), the app's data directory on Android (the
/// share target is an activity of the app itself, and Tauri's data directory
/// there is the `dataDir` the activity writes under).
fn inbox_location(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        app.path()
            .app_data_dir()
            .ok()
            .map(|data| data.join(INBOX_DIR))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        app_group_container().map(|container| container.join(INBOX_DIR))
    }
}

fn inbox_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    inbox_location(app).ok_or_else(|| {
        AppError::new(
            "share_inbox_unavailable",
            "Sharing into Sub Rosa is only available on the phone.",
        )
    })
}

/// Ids of the shares still waiting, oldest first, young enough to still be
/// requests. Pure over a folder, so the rules are tested on every platform.
pub fn pending_in(dir: &Path, now: std::time::SystemTime) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, String)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".json")?.to_string();
            valid_item_id(&id).then_some(())?;
            let modified = entry.metadata().ok()?.modified().ok()?;
            let age = now.duration_since(modified).unwrap_or_default();
            (age <= PENDING_MAX_AGE).then_some((modified, id))
        })
        .collect();
    found.sort();
    found
        .into_iter()
        .take(MAX_PENDING)
        .map(|(_, id)| id)
        .collect()
}

/// The shares whose address never reached the shell. Android delivers only
/// the last address of a batch to a cold start, and either platform can lose
/// one; the manifests are still in the inbox. Taking them is the shell's
/// job, through `import_shared_item`, which deletes what it consumed.
#[tauri::command]
pub fn pending_shared_items(app: AppHandle) -> Vec<String> {
    inbox_location(&app)
        .map(|dir| pending_in(&dir, std::time::SystemTime::now()))
        .unwrap_or_default()
}

fn remove_quietly(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Act on one manifest the share extension left, then forget it.
#[tauri::command]
pub async fn import_shared_item(
    app: AppHandle,
    request: ImportSharedItemRequest,
) -> Result<SharedImport, AppError> {
    if !valid_item_id(&request.item_id) {
        return Err(AppError::new(
            "share_inbox_invalid",
            "That shared item id is not valid.",
        ));
    }
    let inbox = inbox_dir(&app)?;
    let manifest_path = inbox.join(format!("{}.json", request.item_id));
    let bytes = std::fs::read(&manifest_path).map_err(|_| {
        AppError::new(
            "share_inbox_missing",
            "That shared item is no longer in the inbox.",
        )
    })?;
    // A manifest that cannot be read never will be: drop it, so the sweep
    // does not hand the same refusal back at every launch.
    let manifest = parse_manifest(&bytes).inspect_err(|_| remove_quietly(&manifest_path))?;
    if let SharedManifest::File { file_name } = &manifest {
        let use_as = shared_file_use(file_name);
        if use_as != SharedFileUse::Recording {
            let source = inbox.join(file_name);
            let shown = shown_name(&request.item_id, file_name);
            let outcome = attach_shared_file(&source, shown, use_as).await;
            remove_quietly(&source);
            remove_quietly(&manifest_path);
            return outcome;
        }
    }
    let outcome = match manifest {
        SharedManifest::Link { url } => {
            match crate::ingest::start_link_ingest(app.clone(), url.clone(), None).await {
                Ok(ingest) => SharedImport {
                    kind: "link",
                    note_id: None,
                    ingest_id: Some(ingest.id),
                    url: None,
                    attachment: None,
                },
                // A video shared from its app: the phone cannot read it
                // (ADR-0028), a computer can (ADR-0054). Not an error to put
                // in a banner, a link to hand over: the shell opens the import
                // sheet on it, where the errand is offered.
                Err(error) if error.code == "ingest_needs_extractor" => SharedImport {
                    kind: "platform",
                    note_id: None,
                    ingest_id: None,
                    url: Some(url),
                    attachment: None,
                },
                Err(error) => return Err(error),
            }
        }
        SharedManifest::File { file_name } => {
            let source = inbox.join(&file_name);
            // Into the app's own staging place, the way a picked file goes,
            // so the import owns the file and the inbox holds nothing after.
            let extension = Path::new(&file_name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin")
                .to_string();
            let short: String = request.item_id.chars().take(8).collect();
            let staged = std::env::temp_dir().join(format!("subrosa-staging-{short}.{extension}"));
            std::fs::rename(&source, &staged)
                .or_else(|_| std::fs::copy(&source, &staged).map(|_| ()))
                .map_err(|error| AppError::new("share_inbox_copy_failed", error.to_string()))?;
            remove_quietly(&source);
            let shown = shown_name(&request.item_id, &file_name);
            let note = crate::commands::import_audio_note(
                app.clone(),
                crate::commands::ImportAudioNoteRequest {
                    source_path: None,
                    base64: None,
                    staged_path: Some(staged.display().to_string()),
                    file_name: Some(shown),
                    folder_id: None,
                },
            )
            .await?;
            SharedImport {
                kind: "file",
                note_id: Some(note.id),
                ingest_id: None,
                url: None,
                attachment: None,
            }
        }
        SharedManifest::Text { text } => {
            let repos = crate::commands::repositories(&app).await?;
            let note = repos.create_note(None).await?;
            let title = text
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| line.chars().take(80).collect::<String>())
                .unwrap_or_default();
            let note = repos
                .update_note(&note.id, Some(title), Some(text.trim().to_string()), None)
                .await?;
            crate::agent_notes::announce(&app, std::slice::from_ref(&note.id));
            SharedImport {
                kind: "text",
                note_id: Some(note.id),
                ingest_id: None,
                url: None,
                attachment: None,
            }
        }
    };
    remove_quietly(&manifest_path);
    Ok(outcome)
}

/// A picture or a document shared in: what a chat turn carries of it. The
/// shell opens a fresh chat with it in the composer, where the person asks
/// their question; nothing is sent on their behalf.
async fn attach_shared_file(
    source: &Path,
    shown: String,
    use_as: SharedFileUse,
) -> Result<SharedImport, AppError> {
    let size = std::fs::metadata(source)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if use_as == SharedFileUse::Image && size > MAX_IMAGE_BYTES {
        return Err(AppError::new(
            "share_inbox_too_large",
            "That picture is too large to attach. Share a smaller one.",
        ));
    }
    let bytes = std::fs::read(source).map_err(|_| {
        AppError::new(
            "share_inbox_missing",
            "That shared item is no longer in the inbox.",
        )
    })?;
    let attachment = match use_as {
        SharedFileUse::Image => {
            use base64::Engine;
            SharedAttachment {
                kind: "image",
                data: format!(
                    "data:{};base64,{}",
                    image_mime(&shown),
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
                name: shown,
            }
        }
        _ => {
            let name = shown.clone();
            let document = tokio::task::spawn_blocking(move || {
                crate::documents::extract_for_chat(&name, bytes)
            })
            .await
            .map_err(|_| {
                AppError::new("share_inbox_invalid", "That shared item could not be read.")
            })??;
            SharedAttachment {
                kind: "text",
                name: shown,
                data: document.text,
            }
        }
    };
    Ok(SharedImport {
        kind: "attachment",
        note_id: None,
        ingest_id: None,
        url: None,
        attachment: Some(attachment),
    })
}

/// The original name, without the id the sharing side prefixed (`<id>-`).
/// The id is a UUID with dashes of its own, so it is stripped whole.
pub fn shown_name(item_id: &str, file_name: &str) -> String {
    file_name
        .strip_prefix(item_id)
        .and_then(|rest| rest.strip_prefix('-'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(file_name)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        parse_manifest, pending_in, shared_file_use, shown_name, valid_file_name, valid_item_id,
        SharedFileUse, SharedManifest, INBOX_DIR,
    };
    use std::time::{Duration, SystemTime};

    #[test]
    fn ids_are_uuid_shaped_and_names_are_one_segment() {
        assert!(valid_item_id("3f2c1a9e-aa10-4b6e-9d1c-0f1e2d3c4b5a"));
        assert!(!valid_item_id(""));
        assert!(!valid_item_id("../etc"));
        assert!(!valid_item_id("a/b"));
        assert!(valid_file_name("3f2c-recording.m4a"));
        assert!(!valid_file_name("../x"));
        assert!(!valid_file_name("dir/x"));
        assert!(!valid_file_name(".."));
    }

    #[test]
    fn manifests_are_one_of_three_shapes_and_checked() {
        assert_eq!(
            parse_manifest(br#"{"kind":"link","url":"https://example.com/a"}"#).unwrap(),
            SharedManifest::Link {
                url: "https://example.com/a".into()
            }
        );
        assert!(parse_manifest(br#"{"kind":"link","url":"file:///etc/passwd"}"#).is_err());
        assert_eq!(
            parse_manifest(br#"{"kind":"file","fileName":"id-talk.m4a"}"#).unwrap(),
            SharedManifest::File {
                file_name: "id-talk.m4a".into()
            }
        );
        assert!(parse_manifest(br#"{"kind":"file","fileName":"../talk.m4a"}"#).is_err());
        assert!(parse_manifest(br#"{"kind":"text","text":"   "}"#).is_err());
        assert!(parse_manifest(br#"{"kind":"video"}"#).is_err());
    }

    #[test]
    fn a_shared_file_goes_where_its_kind_lives() {
        assert_eq!(shared_file_use("id-photo.JPG"), SharedFileUse::Image);
        assert_eq!(shared_file_use("id-screen.heic"), SharedFileUse::Image);
        assert_eq!(shared_file_use("id-report.pdf"), SharedFileUse::Document);
        assert_eq!(shared_file_use("id-notes.md"), SharedFileUse::Document);
        assert_eq!(shared_file_use("id-memo.m4a"), SharedFileUse::Recording);
        assert_eq!(shared_file_use("id-talk.mp4"), SharedFileUse::Recording);
        assert_eq!(shared_file_use("id-archive"), SharedFileUse::Recording);
    }

    #[test]
    fn the_shown_name_drops_the_whole_id() {
        let id = "3f2c1a9e-aa10-4b6e-9d1c-0f1e2d3c4b5a";
        assert_eq!(shown_name(id, &format!("{id}-talk.m4a")), "talk.m4a");
        assert_eq!(shown_name(id, &format!("{id}-my-file.pdf")), "my-file.pdf");
        assert_eq!(shown_name(id, "other-name.pdf"), "other-name.pdf");
        assert_eq!(shown_name(id, &format!("{id}-")), format!("{id}-"));
    }

    #[test]
    fn the_sweep_sees_young_manifests_oldest_first() {
        let dir = std::env::temp_dir().join(format!("share-inbox-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aaaa-1.json"), b"{}").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("bbbb-2.json"), b"{}").unwrap();
        // Files the manifests point at, and names no extension wrote, are not shares.
        std::fs::write(dir.join("bbbb-2-photo.jpg"), b"x").unwrap();
        std::fs::write(dir.join("bad id.json"), b"{}").unwrap();
        let now = SystemTime::now();
        assert_eq!(pending_in(&dir, now), vec!["aaaa-1", "bbbb-2"]);
        // Ten minutes on, they are leftovers rather than requests.
        assert!(pending_in(&dir, now + Duration::from_secs(11 * 60)).is_empty());
        assert!(pending_in(&dir.join("missing"), now).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn android_writes_the_inbox_this_module_reads() {
        // The share target is Kotlin, built only in the Android lane: pin the
        // folder and the manifest keys it writes to the ones read here.
        let kotlin = include_str!(
            "../android/src/main/java/xyz/carpediem/subrosa/nativebridge/ShareReceiverActivity.kt"
        );
        assert!(kotlin.contains(&format!("INBOX_DIR = \"{INBOX_DIR}\"")));
        for key in [
            "\"kind\"",
            "\"link\"",
            "\"url\"",
            "\"file\"",
            "\"fileName\"",
            "\"text\"",
        ] {
            assert!(
                kotlin.contains(key),
                "ShareReceiverActivity.kt does not write {key}"
            );
        }
        assert!(kotlin.contains("subrosa://share/"));
    }
}
