//! What the `subrosa:file` card can ask of a document it shows. The card
//! names a file; these commands find it in the gallery's documents folder and
//! nowhere else, so a block a model wrote cannot reach any other file.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::DocumentKind;
use crate::domain::types::AppError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverableRequest {
    pub file: String,
}

/// `<uuid>.<docx|xlsx|pptx>`, the only names [`super::make`] writes.
pub(crate) fn is_document_name(file: &str) -> bool {
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    uuid::Uuid::parse_str(stem).is_ok()
        && stem.len() == 36
        && super::DocumentKind::parse(extension).is_some_and(|kind| kind.extension() == extension)
}

fn resolve(app: &AppHandle, file: &str) -> Result<PathBuf, AppError> {
    if !is_document_name(file) {
        return Err(AppError::new(
            "deliverable_missing",
            "The file could not be found.",
        ));
    }
    let dir = super::documents_dir(app)?;
    crate::path_confinement::confine_existing(
        std::slice::from_ref(&dir),
        &dir.join(file),
        "deliverable_missing",
        "The file could not be found.",
    )
}

/// A document in the gallery's documents folder, as the Library lists it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEntry {
    /// The gallery name (`<uuid>.<ext>`), what the card's buttons send back.
    pub file: String,
    /// The title written in the file itself, so a document that came from
    /// another device has its title too. Absent when the file has none.
    pub title: Option<String>,
    pub kind: DocumentKind,
    pub bytes: u64,
    /// RFC 3339, when the file was last written.
    pub modified_at: Option<String>,
}

/// The largest `docProps/core.xml` read for a title: the app writes a few
/// hundred bytes, and a file is not opened further than that.
const MAX_CORE_BYTES: u64 = 64 * 1024;

/// The title in an Office file's core properties (`<dc:title>`).
fn document_title(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let entry = archive.by_name("docProps/core.xml").ok()?;
    let mut xml = String::new();
    entry.take(MAX_CORE_BYTES).read_to_string(&mut xml).ok()?;
    let start = xml.find("<dc:title>")? + "<dc:title>".len();
    let end = start + xml[start..].find("</dc:title>")?;
    let title = unescape(&xml[start..end]);
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (!title.is_empty()).then_some(title)
}

/// The five XML entities, the reverse of `xml_text`.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Every document `make_document` wrote in `dir`, newest first. Anything
/// else in the folder (a partial file, a name the tool never writes) is left
/// out.
pub(crate) fn list_in(dir: &Path) -> Vec<DocumentEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut documents: Vec<(std::time::SystemTime, DocumentEntry)> = entries
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().to_str()?.to_string();
            if !is_document_name(&file) {
                return None;
            }
            let metadata = entry.metadata().ok().filter(|meta| meta.is_file())?;
            let kind = DocumentKind::parse(file.rsplit_once('.')?.1)?;
            let modified = metadata.modified().ok();
            Some((
                modified.unwrap_or(std::time::UNIX_EPOCH),
                DocumentEntry {
                    title: document_title(&entry.path()),
                    kind,
                    bytes: metadata.len(),
                    modified_at: modified.map(|time| {
                        chrono::DateTime::<chrono::Utc>::from(time)
                            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                    }),
                    file,
                },
            ))
        })
        .collect();
    documents.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.file.cmp(&b.1.file)));
    documents.into_iter().map(|(_, entry)| entry).collect()
}

/// The documents the assistant made, on this device or synchronised from
/// another, for the Library's "Files" (ADR-0088, ADR-0090).
#[tauri::command]
pub async fn deliverable_list(app: AppHandle) -> Result<Vec<DocumentEntry>, AppError> {
    let dir = super::documents_dir(&app)?;
    tokio::task::spawn_blocking(move || list_in(&dir))
        .await
        .map_err(|error| AppError::new("document_failed", error.to_string()))
}

/// The document's absolute path, for "Save a copy" (the gallery export,
/// which opens its own dialog and confines the path again).
#[tauri::command]
pub async fn deliverable_path(
    app: AppHandle,
    request: DeliverableRequest,
) -> Result<String, AppError> {
    Ok(resolve(&app, &request.file)?.to_string_lossy().into_owned())
}

/// Opens the document: in its default app on the computer, in the share
/// sheet on the phone (which offers the apps that open it and "Save to
/// Files").
#[tauri::command]
pub async fn deliverable_open(app: AppHandle, request: DeliverableRequest) -> Result<(), AppError> {
    let path = resolve(&app, &request.file)?;
    open(&app, path)
}

#[cfg(desktop)]
fn open(_app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        crate::win_console::hide_console(&mut command);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::new("deliverable_open_failed", error.to_string()))
}

#[cfg(target_os = "ios")]
fn open(app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    crate::share_ios::present_file(app, path.to_string_lossy().into_owned())
}

#[cfg(target_os = "android")]
fn open(_app: &AppHandle, path: PathBuf) -> Result<(), AppError> {
    crate::android::invoke::<serde_json::Value>("shareFile", serde_json::json!({ "path": path }))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_library_lists_the_documents_newest_first_with_the_titles_inside_them() {
        let dir = tempfile::tempdir().unwrap();
        let older = "0b7c1d2e-1111-4222-8333-444455556666.docx";
        let newer = "0b7c1d2e-1111-4222-8333-444455556667.xlsx";
        std::fs::write(
            dir.path().join(older),
            crate::docx::markdown_to_docx("Q3 & Q4 <review>", "Body").unwrap(),
        )
        .unwrap();
        std::fs::write(dir.path().join(newer), b"not a zip").unwrap();
        let earlier = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(dir.path().join(older))
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        // Not the tool's: left out.
        std::fs::write(dir.path().join("notes.docx"), b"x").unwrap();
        std::fs::write(dir.path().join(format!("{older}.part")), b"x").unwrap();
        std::fs::create_dir(dir.path().join("0b7c1d2e-1111-4222-8333-444455556668.pptx")).unwrap();

        let listed = list_in(dir.path());
        assert_eq!(
            listed
                .iter()
                .map(|entry| entry.file.as_str())
                .collect::<Vec<_>>(),
            vec![newer, older]
        );
        assert_eq!(listed[0].kind, DocumentKind::Xlsx);
        assert_eq!(listed[0].title, None);
        assert_eq!(listed[0].bytes, 9);
        assert_eq!(listed[1].title.as_deref(), Some("Q3 & Q4 <review>"));
        assert!(listed[1].modified_at.as_deref().unwrap().ends_with('Z'));
        let json = serde_json::to_value(&listed[1]).unwrap();
        assert_eq!(json["kind"], "docx");
        assert!(json.get("modifiedAt").is_some());
        assert!(list_in(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn only_the_names_the_tool_writes_are_accepted() {
        assert!(is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.docx"
        ));
        assert!(is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.pptx"
        ));
        assert!(!is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.DOCX"
        ));
        assert!(!is_document_name(
            "0b7c1d2e-1111-4222-8333-444455556666.png"
        ));
        assert!(!is_document_name(
            "../0b7c1d2e-1111-4222-8333-444455556666.docx"
        ));
        assert!(!is_document_name("0b7c1d2e11114222833344445555666.docx"));
        assert!(!is_document_name("notes.docx"));
        assert!(!is_document_name("docx"));
    }
}
