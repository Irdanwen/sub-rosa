//! Deliverables: the Word, Excel and PowerPoint files the assistant makes on
//! request (ADR-0090).
//!
//! One tool, `make_document`, on both shells: agent-lite calls [`agent_tool`]
//! in-process, and the desktop agent calls the `june_media` MCP's tool of the
//! same name, which posts to the loopback route [`proxy_route`]. Both land in
//! [`make`], so the same request makes the same file on the phone and on the
//! computer. The writers are this app's own, by hand, like the Word writer
//! the research report uses (ADR-0089): a page of XML per format, no
//! dependency, nothing to bundle into the sandboxed runtime.
//!
//! - **The file is a gallery file** (ADR-0020), in the gallery's `documents`
//!   folder and named by a fresh UUID. The Studio's media views list only the
//!   gallery's top level, so a spreadsheet never shows up as a broken
//!   picture there.
//! - **The chat shows it as a `subrosa:file` block** (ADR-0024) that names the
//!   file, never a path: an absolute path goes stale on iOS when the app is
//!   reinstalled, and the card's commands resolve the name inside the
//!   documents folder, so a model cannot point them anywhere else.
//! - **What the model wrote is data.** Every writer escapes text and drops
//!   the characters XML refuses, and the spreadsheet writer keeps formulas
//!   that reach outside the file as text.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

pub(crate) use crate::docx::xml_text;
use crate::domain::types::AppError;

pub mod commands;
mod docx_content;
mod pptx;
mod pptx_parts;
#[cfg(test)]
mod tests_support;
mod xlsx;

pub const TOOL: &str = "make_document";
/// The gallery's subfolder for documents.
pub(crate) const DOCUMENTS_DIR: &str = "documents";
const MAX_TITLE: usize = 120;
/// A picture larger than this is not put in a deck.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Docx,
    Xlsx,
    Pptx,
}

impl DocumentKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "docx" | "word" | "document" => Some(Self::Docx),
            "xlsx" | "excel" | "spreadsheet" | "workbook" => Some(Self::Xlsx),
            "pptx" | "powerpoint" | "presentation" | "slides" | "deck" => Some(Self::Pptx),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Self::Docx => "Word document",
            Self::Xlsx => "Excel workbook",
            Self::Pptx => "PowerPoint deck",
        }
    }
}

/// A picture for a slide: bytes a deck can embed (PNG, JPEG or GIF) and its
/// size in pixels, for fitting.
#[derive(Debug, Clone)]
pub struct SlideImage {
    pub bytes: Vec<u8>,
    pub extension: &'static str,
    pub width: u32,
    pub height: u32,
}

/// A file made from a request, before it is saved.
#[derive(Debug)]
pub struct Built {
    pub bytes: Vec<u8>,
    /// What it holds, in a few words ("5 slides", "2 sheets, 40 rows").
    pub detail: String,
    /// What was asked for and left out, for the model to pass on.
    pub warnings: Vec<String>,
}

/// A saved document, as the tool and the route report it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MadeDocument {
    /// The gallery name (`<uuid>.<ext>`): what the chat block carries.
    pub file: String,
    pub path: String,
    pub title: String,
    pub kind: DocumentKind,
    pub bytes: u64,
    pub detail: String,
    pub warnings: Vec<String>,
}

pub(crate) fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("document_invalid", message)
}

/// `docProps/core.xml`, shared with the Word writer.
pub(crate) fn core_xml(title: &str) -> String {
    crate::docx::core_xml(title)
}

/// The zip every Office file is, with its parts in the order given (the
/// content types first, as readers expect).
pub(crate) fn package(parts: &[(String, Vec<u8>)]) -> Result<Vec<u8>, AppError> {
    let failed =
        |error: &dyn std::fmt::Display| AppError::new("document_failed", error.to_string());
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in parts {
        zip.start_file(name.as_str(), options)
            .map_err(|e| failed(&e))?;
        zip.write_all(content).map_err(|e| failed(&e))?;
    }
    Ok(zip.finish().map_err(|e| failed(&e))?.into_inner())
}

/// Builds the file. Pure apart from `images`, which resolves a slide's
/// picture reference.
pub fn build(
    kind: DocumentKind,
    title: &str,
    content: &Value,
    images: &dyn Fn(&str) -> Result<SlideImage, String>,
) -> Result<Built, AppError> {
    match kind {
        DocumentKind::Docx => {
            let markdown = docx_content::markdown(content)?;
            let words = markdown.split_whitespace().count();
            Ok(Built {
                bytes: crate::docx::markdown_to_docx(title, &markdown)?,
                detail: format!("{words} word{}", if words == 1 { "" } else { "s" }),
                warnings: Vec::new(),
            })
        }
        DocumentKind::Xlsx => {
            let (bytes, detail) = xlsx::build(title, content)?;
            Ok(Built {
                bytes,
                detail,
                warnings: Vec::new(),
            })
        }
        DocumentKind::Pptx => {
            let (bytes, warnings) = pptx::build(title, content, images)?;
            let slides = slide_count(content);
            Ok(Built {
                bytes,
                detail: format!("{slides} slide{}", if slides == 1 { "" } else { "s" }),
                warnings,
            })
        }
    }
}

fn slide_count(content: &Value) -> usize {
    let slides = content.get("slides").unwrap_or(content);
    slides.as_array().map_or(0, |slides| {
        slides.iter().filter(|slide| slide.is_object()).count()
    })
}

/// The request's title, one line, never empty.
fn clean_title(raw: Option<&str>, kind: DocumentKind) -> String {
    let title: String = raw
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE)
        .collect();
    if title.is_empty() {
        match kind {
            DocumentKind::Docx => "Document".into(),
            DocumentKind::Xlsx => "Workbook".into(),
            DocumentKind::Pptx => "Presentation".into(),
        }
    } else {
        title
    }
}

/// The parts of a request: `{kind, title, content}`. A model that sends the
/// content as a JSON string gets it parsed.
fn parse_request(args: &Value) -> Result<(DocumentKind, String, Value), AppError> {
    let kind = args
        .get("kind")
        .or_else(|| args.get("format"))
        .and_then(Value::as_str)
        .and_then(DocumentKind::parse)
        .ok_or_else(|| invalid("kind must be docx, xlsx or pptx."))?;
    let title = clean_title(args.get("title").and_then(Value::as_str), kind);
    let content = match args.get("content") {
        Some(Value::String(text)) if kind != DocumentKind::Docx => {
            serde_json::from_str(text).map_err(|_| invalid("content must be a JSON object."))?
        }
        Some(content) => content.clone(),
        None => return Err(invalid("content is required.")),
    };
    Ok((kind, title, content))
}

/// The gallery's documents folder, created on first use.
pub(crate) fn documents_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = crate::carpe_diem::media::artifacts_dir(app)?.join(DOCUMENTS_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| AppError::new("document_failed", error.to_string()))?;
    Ok(dir)
}

/// A picture named by the model, looked up in the gallery by its file name
/// alone (whatever folder the model put in front of it), and made into
/// something a deck can embed.
pub(crate) fn gallery_image(gallery: &Path, reference: &str) -> Result<SlideImage, String> {
    let name = Path::new(reference.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let missing =
        || format!("{reference} is not a picture in the gallery, so the slide has no picture");
    if name.is_empty() || name.starts_with('.') {
        return Err(missing());
    }
    let path = gallery.join(&name);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| missing())?;
    if !metadata.is_file() {
        return Err(missing());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(format!("{name} is too large to put in a slide"));
    }
    let bytes = std::fs::read(&path).map_err(|_| missing())?;
    slide_image(bytes).map_err(|_| format!("{name} is not a picture a slide can show"))
}

fn slide_image(bytes: Vec<u8>) -> Result<SlideImage, image::ImageError> {
    let reader = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format()?;
    let format = reader.format();
    let extension = match format {
        Some(image::ImageFormat::Png) => Some("png"),
        Some(image::ImageFormat::Jpeg) => Some("jpeg"),
        Some(image::ImageFormat::Gif) => Some("gif"),
        _ => None,
    };
    if let Some(extension) = extension {
        let (width, height) = reader.into_dimensions()?;
        return Ok(SlideImage {
            bytes,
            extension,
            width,
            height,
        });
    }
    // WebP and TIFF are not in every reader's deck: carry them as PNG.
    let decoded = reader.decode()?;
    let mut png = Vec::new();
    decoded.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok(SlideImage {
        bytes: png,
        extension: "png",
        width: decoded.width(),
        height: decoded.height(),
    })
}

/// Makes the file and saves it in the gallery's documents folder.
pub async fn make(app: &AppHandle, args: &Value) -> Result<MadeDocument, AppError> {
    let (kind, title, content) = parse_request(args)?;
    let gallery = crate::carpe_diem::media::artifacts_dir(app)?;
    let dir = documents_dir(app)?;
    let built_title = title.clone();
    let built = tokio::task::spawn_blocking(move || {
        build(kind, &built_title, &content, &|reference| {
            gallery_image(&gallery, reference)
        })
    })
    .await
    .map_err(|error| AppError::new("document_failed", error.to_string()))??;
    let made = save(&dir, kind, title, built).await?;
    // A gallery file, so it follows the person to their other devices on the
    // gallery's lane (best effort; the lane's inventory catches up later).
    crate::account::studio::completed(app, Path::new(&made.path)).await;
    Ok(made)
}

async fn save(
    dir: &Path,
    kind: DocumentKind,
    title: String,
    built: Built,
) -> Result<MadeDocument, AppError> {
    let file = format!("{}.{}", uuid::Uuid::new_v4(), kind.extension());
    let path = dir.join(&file);
    let bytes = built.bytes.len() as u64;
    tokio::fs::write(&path, &built.bytes)
        .await
        .map_err(|error| AppError::new("document_failed", error.to_string()))?;
    Ok(MadeDocument {
        file,
        path: path.to_string_lossy().into_owned(),
        title,
        kind,
        bytes,
        detail: built.detail,
        warnings: built.warnings,
    })
}

/// The `subrosa:file` block the chat renders as a card.
pub fn file_block(made: &MadeDocument) -> String {
    let payload = serde_json::json!({
        "v": 1,
        "file": made.file,
        "title": made.title,
        "kind": made.kind,
        "detail": made.detail,
    });
    format!("```subrosa:file\n{payload}\n```")
}

/// What the tool answers the model: what was made, and the block to show.
pub fn tool_reply(made: &MadeDocument) -> String {
    let mut reply = format!(
        "Made the {} \"{}\" ({}) and saved it in the user's gallery. Show it to the user by copying this block into your reply exactly as it is, on its own lines; it renders as a card with buttons to open, share and save the file:\n\n{}",
        made.kind.noun(),
        made.title,
        made.detail,
        file_block(made)
    );
    if !made.warnings.is_empty() {
        reply.push_str("\n\nTell the user what was left out: ");
        reply.push_str(&made.warnings.join("; "));
        reply.push('.');
    }
    reply
}

/// Agent-lite's `make_document`: the reply text, or why it failed.
pub async fn agent_tool(app: &AppHandle, args: &Value) -> String {
    match make(app, args).await {
        Ok(made) => tool_reply(&made),
        Err(error) => format!("The document was not made: {}", error.message),
    }
}

/// The schema both shells offer. The desktop MCP restates it in Python; the
/// test in `tests_support` keeps the two descriptions of `content` aligned.
pub fn tool_definition() -> Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": TOOL,
            "description": TOOL_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["docx", "xlsx", "pptx"] },
                    "title": { "type": "string", "description": "The file's title, in the user's language." },
                    "content": { "type": "object", "description": CONTENT_DESCRIPTION }
                },
                "required": ["kind", "title", "content"]
            }
        }
    })
}

pub const TOOL_DESCRIPTION: &str = "Make a Word document (docx), an Excel workbook (xlsx) or a PowerPoint deck (pptx) the user can open, share and save. Use it when the user asks for a file, a spreadsheet, slides or a document to send, not for an answer that belongs in the chat. The file is saved in the user's gallery; copy the subrosa:file block the tool returns into your reply.";

pub const CONTENT_DESCRIPTION: &str = "docx: {markdown} (headings, lists, tables, bold, links) or {sections: [{heading, level, paragraphs, bullets, numbered, table: {header, rows}, quote}]}. xlsx: {sheets: [{name, columns: [{width, format}], rows: [[cell]], header, freezeHeader}]}; a cell is a number, text, true/false, null, an ISO date, a formula starting with = (like =SUM(B2:B9)), or {value or formula, format, bold}; formats like #,##0.00, 0.0%, yyyy-mm-dd. pptx: {slides: [{layout: title|bullets|two_column|image, title, subtitle, bullets: [text or {text, level}], left: {heading, bullets}, right: {heading, bullets}, image: a gallery picture's file name, caption, notes}]}; notes are the speaker notes.";

/// `/v1/media/document`, the desktop agent's way in (the `june_media` MCP):
/// the same request, answered with the made document and the reply text.
#[cfg(desktop)]
pub async fn proxy_route(app: &AppHandle, body: &[u8]) -> (u16, Value) {
    let args = match serde_json::from_slice::<Value>(body) {
        Ok(args) => args,
        Err(error) => {
            return (
                400,
                serde_json::json!({ "error": { "message": format!("Invalid document request: {error}") } }),
            )
        }
    };
    match make(app, &args).await {
        Ok(made) => {
            let reply = tool_reply(&made);
            let mut body = serde_json::to_value(&made).unwrap_or_else(|_| serde_json::json!({}));
            if let Some(map) = body.as_object_mut() {
                map.insert("reply".into(), Value::String(reply));
            }
            (200, body)
        }
        Err(error) => {
            let status = if error.code == "document_invalid" {
                400
            } else {
                500
            };
            (
                status,
                serde_json::json!({ "error": { "code": error.code, "message": error.message } }),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::{assert_valid_package, part};
    use super::*;
    use serde_json::json;

    fn no_images(reference: &str) -> Result<SlideImage, String> {
        Err(format!("{reference} missing"))
    }

    #[test]
    fn a_request_is_read_leniently() {
        let (kind, title, content) = parse_request(&json!({
            "kind": "Excel", "title": "  Q3\nbudget ", "content": "{\"rows\": [[1]]}"
        }))
        .unwrap();
        assert_eq!(kind, DocumentKind::Xlsx);
        assert_eq!(title, "Q3 budget");
        assert_eq!(content, json!({"rows": [[1]]}));
        let (_, title, content) =
            parse_request(&json!({"kind": "docx", "content": "# Plain markdown"})).unwrap();
        assert_eq!(title, "Document");
        assert_eq!(content, json!("# Plain markdown"));
        assert!(parse_request(&json!({"kind": "pdf", "content": {}})).is_err());
        assert!(parse_request(&json!({"kind": "pptx"})).is_err());
    }

    #[test]
    fn every_kind_builds_a_valid_package() {
        let word = build(
            DocumentKind::Docx,
            "Plan",
            &json!({"sections": [{"heading": "Goal", "paragraphs": ["Ship it."]}]}),
            &no_images,
        )
        .unwrap();
        assert_valid_package(&word.bytes);
        assert_eq!(word.detail, "4 words");
        assert!(part(&word.bytes, "word/document.xml").contains("Ship it."));
        let sheet = build(
            DocumentKind::Xlsx,
            "Numbers",
            &json!({"rows": [["a"], [1]]}),
            &no_images,
        )
        .unwrap();
        assert_valid_package(&sheet.bytes);
        let deck = build(
            DocumentKind::Pptx,
            "Deck",
            &json!({"slides": [{"title": "One"}, {"title": "Two", "image": "x.png"}]}),
            &no_images,
        )
        .unwrap();
        assert_valid_package(&deck.bytes);
        assert_eq!(deck.detail, "2 slides");
        assert_eq!(deck.warnings, vec!["Slide 2: x.png missing"]);
    }

    #[test]
    fn the_block_names_the_file_never_a_path() {
        let made = MadeDocument {
            file: "0b7c1d2e-0000-4000-8000-000000000000.pptx".into(),
            path: "/private/gallery/documents/0b7c1d2e-0000-4000-8000-000000000000.pptx".into(),
            title: "Board \"deck\"".into(),
            kind: DocumentKind::Pptx,
            bytes: 10,
            detail: "3 slides".into(),
            warnings: vec!["Slide 2: x.png missing".into()],
        };
        let block = file_block(&made);
        assert!(block.starts_with("```subrosa:file\n{"));
        assert!(!block.contains("/private"));
        let json: Value = serde_json::from_str(block.lines().nth(1).unwrap()).unwrap();
        assert_eq!(json["v"], 1);
        assert_eq!(json["kind"], "pptx");
        assert_eq!(json["title"], "Board \"deck\"");
        let reply = tool_reply(&made);
        assert!(reply.contains("PowerPoint deck"));
        assert!(reply.ends_with("Slide 2: x.png missing."));
    }

    #[test]
    fn gallery_pictures_are_found_by_name_and_converted() {
        let dir =
            std::env::temp_dir().join(format!("subrosa-deliverables-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let picture = image::RgbImage::from_pixel(4, 2, image::Rgb([200, 10, 10]));
        picture.save(dir.join("a.png")).unwrap();
        image::DynamicImage::ImageRgb8(picture.clone())
            .save_with_format(dir.join("b.tiff"), image::ImageFormat::Tiff)
            .unwrap();
        let png = gallery_image(&dir, "/somewhere/else/a.png").unwrap();
        assert_eq!((png.extension, png.width, png.height), ("png", 4, 2));
        let tiff = gallery_image(&dir, "b.tiff").unwrap();
        assert_eq!(tiff.extension, "png");
        assert!(tiff.bytes.starts_with(b"\x89PNG"));
        assert!(gallery_image(&dir, "../a.png").is_ok());
        assert!(gallery_image(&dir, "missing.png").is_err());
        assert!(gallery_image(&dir, "..").is_err());
        std::fs::write(dir.join("c.png"), b"not a picture").unwrap();
        assert!(gallery_image(&dir, "c.png").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_tool_definition_matches_the_dispatch_name() {
        let definition = tool_definition();
        assert_eq!(definition["function"]["name"], TOOL);
        assert_eq!(
            definition["function"]["parameters"]["required"],
            json!(["kind", "title", "content"])
        );
    }
}
