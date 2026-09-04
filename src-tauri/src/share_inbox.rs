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
//! Only the container lookup is iOS; the manifest and the id rules are
//! plain Rust, tested on every platform.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::domain::types::AppError;

pub const APP_GROUP: &str = "group.xyz.carpediem.subrosa";
const INBOX_DIR: &str = "share-inbox";
const MAX_TEXT_CHARS: usize = 200_000;

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

fn inbox_dir() -> Result<PathBuf, AppError> {
    app_group_container()
        .map(|container| container.join(INBOX_DIR))
        .ok_or_else(|| {
            AppError::new(
                "share_inbox_unavailable",
                "Sharing into Sub Rosa is only available on the phone.",
            )
        })
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
    let inbox = inbox_dir()?;
    let manifest_path = inbox.join(format!("{}.json", request.item_id));
    let bytes = std::fs::read(&manifest_path).map_err(|_| {
        AppError::new(
            "share_inbox_missing",
            "That shared item is no longer in the inbox.",
        )
    })?;
    let manifest = parse_manifest(&bytes)?;
    let outcome = match manifest {
        SharedManifest::Link { url } => {
            let ingest = crate::ingest::start_link_ingest(app.clone(), url, None).await?;
            SharedImport {
                kind: "link",
                note_id: None,
                ingest_id: Some(ingest.id),
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
            // The original name, without the id the extension prefixed.
            let shown = file_name
                .split_once('-')
                .map(|(_, rest)| rest.to_string())
                .filter(|rest| !rest.is_empty())
                .unwrap_or(file_name.clone());
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
            }
        }
    };
    remove_quietly(&manifest_path);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::{parse_manifest, valid_file_name, valid_item_id, SharedManifest};

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
}
