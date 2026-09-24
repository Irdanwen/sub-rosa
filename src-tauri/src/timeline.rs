//! Writing a timeline bundle to disk.
//!
//! The Studio's own assembly records the canvas in real time through
//! MediaRecorder: it re-encodes, it takes as long as the film runs, and it
//! flattens every lane into one. That is a fine preview and a poor master. A
//! timeline bundle is the finishing path instead - the cut as text, next to
//! the media, opened in whatever editor does the grade and the fine mix. It is
//! the reason the app can keep refusing to ship ffmpeg
//! (see `docs/adr/0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md`).
//!
//! A bundle is self-contained on purpose. A timeline that points back into the
//! gallery is a timeline that breaks the first time the user tidies up, and it
//! cannot be handed to anybody. Copying costs disk, once, at the moment the
//! user asked for a deliverable.
//!
//! The document itself is generated in the webview (`src/lib/studio/timeline/`)
//! because that is where the durations are measured. This side only writes
//! bytes, and only where it is allowed to.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Where the media lives inside a bundle. The generated document must agree.
pub const MEDIA_SUBDIR: &str = "media";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTimelineRequest {
    /// Bundle name, also the stem of the files inside it.
    pub name: String,
    /// The interchange document, already generated.
    pub document: String,
    /// Its extension, without the dot.
    pub extension: String,
    /// SubRip sidecar, when the cut has subtitles.
    pub subtitles: Option<String>,
    /// Editable Sub Rosa montage, retained beside the interchange document.
    #[serde(default)]
    pub editor_document: Option<String>,
    /// Gallery files to copy into `media/`. Each must already be in the gallery.
    pub media: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedTimelineDto {
    /// The bundle folder that was created. Empty when the user cancelled.
    pub directory: String,
    /// The document inside it. Empty when the user cancelled.
    pub document_path: String,
    pub media_count: usize,
    /// True when the user dismissed the folder picker and nothing was written.
    pub cancelled: bool,
}

impl ExportedTimelineDto {
    fn cancelled() -> Self {
        Self {
            directory: String::new(),
            document_path: String::new(),
            media_count: 0,
            cancelled: true,
        }
    }
}

/// The native folder picker, awaited off the main thread. On mobile there is no
/// picker and no Assemble surface, so the bundle lands in the app's documents.
async fn pick_export_directory(app: &AppHandle) -> Result<Option<PathBuf>, AppError> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;

        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().file().pick_folder(move |path| {
            let _ = tx.send(path);
        });
        let picked = rx
            .await
            .map_err(|error| AppError::new("timeline_write_failed", error.to_string()))?;
        Ok(picked.and_then(|path| path.into_path().ok()))
    }
    #[cfg(not(desktop))]
    {
        use tauri::Manager;
        let dir = app
            .path()
            .document_dir()
            .map_err(|error| AppError::new("timeline_write_failed", error.to_string()))?;
        std::fs::create_dir_all(&dir)
            .map_err(|error| AppError::new("timeline_write_failed", error.to_string()))?;
        Ok(Some(dir))
    }
}

/// A file name safe to write, derived from something a user typed.
///
/// Not a slug: the bundle is a deliverable and its name is what the editor sees
/// in their finder, so spaces and accents survive. Only what a path cannot
/// carry is replaced, and a name that reduces to nothing gets a fallback rather
/// than creating a dotfile or writing into the parent.
pub fn safe_file_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "Timeline".to_string();
    }
    trimmed
        .chars()
        .take(80)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The bundle folder, given a parent and a name, avoiding an existing one.
///
/// Exporting twice must not silently overwrite the first bundle: an editor may
/// already have the earlier one open, and a half-overwritten folder is worse
/// than two folders.
fn unique_bundle_dir(parent: &Path, stem: &str) -> PathBuf {
    let base = parent.join(format!("{stem}.timeline"));
    if !base.exists() {
        return base;
    }
    for suffix in 2..1000 {
        let candidate = parent.join(format!("{stem} {suffix}.timeline"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem} {}.timeline", uuid::Uuid::new_v4()))
}

fn extension_of(raw: &str) -> Result<String, AppError> {
    let value = raw.trim().trim_start_matches('.').to_ascii_lowercase();
    if (1..=6).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(value);
    }
    Err(AppError::new(
        "timeline_invalid",
        "That timeline extension is not valid.",
    ))
}

/// Validate the optional editing sidecar before asking for a destination or
/// creating files. The native layer keeps unknown editor fields intact.
fn validate_editor_document(document: Option<&str>) -> Result<(), AppError> {
    let Some(document) = document else {
        return Ok(());
    };
    if document.len() > 8 * 1024 * 1024 {
        return Err(AppError::new(
            "timeline_invalid",
            "The montage document is too large.",
        ));
    }
    let value: serde_json::Value = serde_json::from_str(document)
        .map_err(|_| AppError::new("timeline_invalid", "The montage document is invalid."))?;
    if !value.is_object() {
        return Err(AppError::new(
            "timeline_invalid",
            "The montage document is invalid.",
        ));
    }
    Ok(())
}

/// Build out of sight and publish only after every file has been written.
/// A failed copy must not leave a bundle that looks ready to open or consume
/// the intended name on the next attempt.
fn write_bundle_atomically(
    parent: &Path,
    stem: &str,
    extension: &str,
    request: &ExportTimelineRequest,
    sources: &[PathBuf],
) -> Result<ExportedTimelineDto, AppError> {
    let staging = parent.join(format!(".{stem}.timeline-{}.partial", uuid::Uuid::new_v4()));
    let write_error =
        |error: std::io::Error| AppError::new("timeline_write_failed", error.to_string());
    std::fs::create_dir(&staging).map_err(write_error)?;
    let written = (|| -> Result<usize, AppError> {
        std::fs::create_dir(staging.join(MEDIA_SUBDIR)).map_err(write_error)?;
        std::fs::write(
            staging.join(format!("{stem}.{extension}")),
            request.document.as_bytes(),
        )
        .map_err(write_error)?;
        if let Some(subtitles) = request.subtitles.as_ref().filter(|text| !text.is_empty()) {
            std::fs::write(staging.join(format!("{stem}.srt")), subtitles.as_bytes())
                .map_err(write_error)?;
        }
        if let Some(editor_document) = request.editor_document.as_ref() {
            std::fs::write(
                staging.join("studio-montage.json"),
                editor_document.as_bytes(),
            )
            .map_err(write_error)?;
        }
        let mut copied = 0usize;
        for source in sources {
            let Some(file_name) = source.file_name() else {
                continue;
            };
            let destination = staging.join(MEDIA_SUBDIR).join(file_name);
            if destination.exists() {
                continue;
            }
            std::fs::copy(source, &destination).map_err(write_error)?;
            copied += 1;
        }
        Ok(copied)
    })();
    let copied = match written {
        Ok(count) => count,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let bundle = unique_bundle_dir(parent, stem);
    if let Err(error) = std::fs::rename(&staging, &bundle) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(write_error(error));
    }
    Ok(ExportedTimelineDto {
        directory: bundle.to_string_lossy().to_string(),
        document_path: bundle
            .join(format!("{stem}.{extension}"))
            .to_string_lossy()
            .to_string(),
        media_count: copied,
        cancelled: false,
    })
}

/// Write a self-contained timeline bundle: the document, its subtitles, and a
/// copy of every clip it references.
#[tauri::command]
pub async fn export_timeline_bundle(
    app: AppHandle,
    request: ExportTimelineRequest,
) -> Result<ExportedTimelineDto, AppError> {
    validate_editor_document(request.editor_document.as_deref())?;
    // The folder is picked here, not sent across IPC. A destination from the
    // webview would make this an arbitrary directory-write primitive: the
    // document and the subtitles are generated content, and a bundle folder
    // dropped into an auto-run location is persistence. The user picks, or
    // nothing is written. (Mobile has no folder picker and no Assemble
    // surface; there the bundle lands in the app's own documents.)
    let Some(parent) = pick_export_directory(&app).await? else {
        return Ok(ExportedTimelineDto::cancelled());
    };
    if !parent.is_dir() {
        return Err(AppError::new(
            "timeline_invalid",
            "That export destination is not a folder.",
        ));
    }
    let extension = extension_of(&request.extension)?;
    let stem = safe_file_stem(&request.name);

    // Every source has to be a gallery file. Without this the command is an
    // arbitrary file-copy primitive reachable from the webview.
    let gallery = crate::carpe_diem::media::artifacts_dir(&app)?;
    let sources: Vec<PathBuf> = request.media.iter().map(PathBuf::from).collect();
    for source in &sources {
        if !crate::carpe_diem::media::is_within_gallery(&gallery, source) {
            return Err(AppError::new(
                "timeline_invalid",
                "Only gallery files can be exported into a timeline.",
            ));
        }
    }

    write_bundle_atomically(&parent, &stem, &extension, &request, &sources)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_montage_sidecar_is_bounded_json_and_legacy_requests_still_work() {
        assert!(validate_editor_document(None).is_ok());
        assert!(validate_editor_document(Some(r#"{"version":1,"futureField":true}"#)).is_ok());
        assert!(validate_editor_document(Some("[]")).is_err());
        assert!(validate_editor_document(Some("not json")).is_err());
        assert!(validate_editor_document(Some(&" ".repeat(8 * 1024 * 1024 + 1))).is_err());
        let legacy: ExportTimelineRequest = serde_json::from_value(serde_json::json!({
            "name": "Old montage", "document":"<xml />", "extension":"xml", "media":[]
        }))
        .expect("legacy request");
        assert!(legacy.editor_document.is_none());
    }

    #[test]
    fn a_bundle_name_keeps_what_a_path_can_carry_and_replaces_what_it_cannot() {
        // The name is a deliverable the editor reads in their finder, so it is
        // not slugified - only what a filesystem refuses is replaced.
        assert_eq!(safe_file_stem("Neon alley duel"), "Neon alley duel");
        assert_eq!(safe_file_stem("Été / hiver"), "Été - hiver");
        assert_eq!(safe_file_stem("a:b*c?d\"e<f>g|h"), "a-b-c-d-e-f-g-h");
        // A name that reduces to nothing must not create a dotfile or escape.
        assert_eq!(safe_file_stem("   "), "Timeline");
        assert_eq!(safe_file_stem("..."), "Timeline");
        assert_eq!(safe_file_stem("../../etc"), "-..-etc");
    }

    #[test]
    fn a_bundle_name_is_bounded() {
        let long = "x".repeat(400);
        assert_eq!(safe_file_stem(&long).len(), 80);
    }

    #[test]
    fn only_sane_extensions_are_written() {
        assert_eq!(extension_of(".FCPXML").unwrap(), "fcpxml");
        assert_eq!(extension_of("xml").unwrap(), "xml");
        assert!(extension_of("").is_err());
        assert!(extension_of("../sh").is_err());
        assert!(extension_of("toolongextension").is_err());
    }

    #[test]
    fn a_second_export_does_not_overwrite_the_first() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_bundle_dir(dir.path(), "Film");
        assert!(first.ends_with("Film.timeline"));
        std::fs::create_dir_all(&first).unwrap();
        let second = unique_bundle_dir(dir.path(), "Film");
        assert!(second.ends_with("Film 2.timeline"));
    }

    #[test]
    fn a_failed_media_copy_leaves_no_incomplete_bundle_or_reserved_name() {
        let destination = tempfile::tempdir().unwrap();
        let gallery = tempfile::tempdir().unwrap();
        let first = gallery.path().join("first.mp4");
        std::fs::write(&first, b"video").unwrap();
        let missing = gallery.path().join("missing.mp4");
        let request = ExportTimelineRequest {
            name: "Film".into(),
            document: "<xml />".into(),
            extension: "xml".into(),
            subtitles: Some("1\n00:00:00,000 --> 00:00:01,000\nHi".into()),
            editor_document: Some("{}".into()),
            media: vec![],
        };
        assert!(write_bundle_atomically(
            destination.path(),
            "Film",
            "xml",
            &request,
            &[first.clone(), missing],
        )
        .is_err());
        assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 0);
        let exported =
            write_bundle_atomically(destination.path(), "Film", "xml", &request, &[first]).unwrap();
        assert!(exported.directory.ends_with("Film.timeline"));
        assert_eq!(exported.media_count, 1);
        assert!(Path::new(&exported.document_path).exists());
        assert!(Path::new(&exported.directory)
            .join("media/first.mp4")
            .exists());
    }
}
