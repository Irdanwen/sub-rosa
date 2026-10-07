//! Documents a person hands a chat: the text of a PDF, a Word, Excel or
//! PowerPoint file, read on the device by the extractors assistant
//! references already use (ADR-0058, ADR-0085).
//!
//! The phone's chat sends the file's bytes and attaches the text it gets back
//! with the existing `[File: …]` marker, so the model reads the document and
//! the stored message keeps only the marker. The desktop's Hermes runtime is
//! given a path, and its file tools read bytes: a `.docx` is a zip to them.
//! So an imported document also gets its text written beside it
//! ([`extract_beside`]), and the attachment block names that file.

use crate::domain::types::AppError;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What a chat turn can carry of one document. Agent-lite clips attachments
/// again to its own budget; this keeps the IPC answer bounded.
const MAX_CHAT_CHARS: usize = 200_000;
/// The most text extraction may produce before it is refused outright.
const MAX_EXTRACTED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExtractRequest {
    pub name: String,
    /// The file's bytes in base64, optionally as a `data:` URL.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub name: String,
    pub format: String,
    pub text: String,
    /// Pages of a PDF, sheets of a workbook, slides of a deck; 0 otherwise.
    pub pages: usize,
    pub sheets: usize,
    pub slides: usize,
    /// The text was cut to what a chat turn can carry.
    pub truncated: bool,
}

/// The formats read as documents rather than as plain text or an image.
pub fn is_document(format: &str) -> bool {
    matches!(format, "pdf" | "docx" | "xlsx" | "pptx")
}

pub fn format_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

#[tauri::command]
pub async fn document_extract(request: DocumentExtractRequest) -> Result<DocumentText, AppError> {
    let encoded = match request.data.split_once(";base64,") {
        Some((_, rest)) => rest,
        None => request.data.as_str(),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| unreadable())?;
    let name = request.name;
    tokio::task::spawn_blocking(move || extract_for_chat(&name, bytes))
        .await
        .map_err(|_| unreadable())?
}

/// The text of one document for a chat turn, clipped to what a turn carries.
pub fn extract_for_chat(name: &str, bytes: Vec<u8>) -> Result<DocumentText, AppError> {
    let format = format_of(name);
    if !is_document(&format) && !matches!(format.as_str(), "txt" | "md" | "csv") {
        return Err(AppError::new(
            "document_format",
            "This file type cannot be read. Attach a PDF, Word, Excel, PowerPoint, text or CSV file.",
        ));
    }
    if bytes.len() as u64 > crate::assistants::MAX_BYTES {
        return Err(too_large());
    }
    let text = crate::assistants::extract_bytes(bytes, &format, MAX_EXTRACTED_BYTES)
        .map_err(chat_error)?;
    let count = |marker: &str| text.matches(marker).count();
    let (pages, sheets, slides) = (count("[Page "), count("[Sheet "), count("[Slide "));
    let truncated = text.chars().count() > MAX_CHAT_CHARS;
    let text = if truncated {
        text.chars().take(MAX_CHAT_CHARS).collect()
    } else {
        text
    };
    if text.trim().is_empty() {
        return Err(AppError::new(
            "document_empty",
            "This document has no text to read.",
        ));
    }
    Ok(DocumentText {
        name: name.to_string(),
        format,
        text,
        pages,
        sheets,
        slides,
        truncated,
    })
}

/// Writes the text of an imported document next to it (`report.docx.txt`)
/// and answers that path, so the desktop agent reads words rather than a zip.
/// Anything that is not a document, or cannot be read, answers `None` and the
/// attachment goes out as it always did.
pub fn extract_beside(path: &Path) -> Option<String> {
    let format = format_of(&path.to_string_lossy());
    if !is_document(&format) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let text = crate::assistants::extract_bytes(bytes, &format, MAX_EXTRACTED_BYTES).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let mut target: PathBuf = path.to_path_buf();
    let mut file_name = path.file_name()?.to_os_string();
    file_name.push(".txt");
    target.set_file_name(file_name);
    std::fs::write(&target, text).ok()?;
    Some(target.to_string_lossy().into_owned())
}

fn chat_error(error: AppError) -> AppError {
    match error.code.as_str() {
        "assistant_reference_needs_ocr" => AppError::new(
            "document_needs_ocr",
            "This PDF has no readable text, so it is probably a scan. Export it with text recognition and attach it again.",
        ),
        "assistant_reference_too_large" => too_large(),
        "assistant_reference_encoding" => AppError::new(
            "document_encoding",
            "Save this text file as UTF-8 and attach it again.",
        ),
        _ => unreadable(),
    }
}

fn too_large() -> AppError {
    AppError::new(
        "document_too_large",
        "This document is too large. Attach a file under 20 MB.",
    )
}

fn unreadable() -> AppError {
    AppError::new(
        "document_unreadable",
        "This document could not be read. Export a new copy and attach it again.",
    )
}

#[cfg(test)]
pub(crate) mod fixtures {
    use std::io::{Cursor, Write};

    /// A one-entry Office zip: enough for the extractors, which read only
    /// the parts that carry text.
    pub fn office(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in parts {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    pub fn docx(text: &str) -> Vec<u8> {
        office(&[(
            "word/document.xml",
            &format!(
                "<w:document><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"
            ),
        )])
    }

    pub fn xlsx() -> Vec<u8> {
        office(&[
            (
                "xl/sharedStrings.xml",
                "<sst><si><t>Budget</t></si><si><t>Rent</t></si></sst>",
            ),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><sheetData><row><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\"><v>1200</v></c></row></sheetData></worksheet>",
            ),
            (
                "xl/worksheets/sheet2.xml",
                "<worksheet><sheetData><row><c r=\"A1\" t=\"s\"><v>1</v></c></row></sheetData></worksheet>",
            ),
        ])
    }

    pub fn pptx() -> Vec<u8> {
        office(&[
            (
                "ppt/slides/slide1.xml",
                "<p:sld><a:p><a:t>Roadmap</a:t></a:p></p:sld>",
            ),
            (
                "ppt/slides/slide2.xml",
                "<p:sld><a:p><a:t>Next steps</a:t></a:p></p:sld>",
            ),
        ])
    }

    /// A one-page PDF whose content stream draws `text`, or nothing at all
    /// when `text` is empty (a scan has pages and no text).
    pub fn pdf(text: &str) -> Vec<u8> {
        let content = if text.is_empty() {
            String::new()
        } else {
            format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET")
        };
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_owned(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_owned(),
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        ];
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
        }
        let xref = bytes.len();
        bytes.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
        for offset in offsets {
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn every_document_format_reads_with_its_counts() {
        let pdf = extract_for_chat("Report.PDF", pdf("Quarterly figures")).unwrap();
        assert_eq!(pdf.format, "pdf");
        assert_eq!(pdf.pages, 1);
        assert!(pdf.text.contains("Quarterly figures"));

        let doc = extract_for_chat("memo.docx", docx("Signed on Friday")).unwrap();
        assert!(doc.text.contains("Signed on Friday"));
        assert_eq!((doc.pages, doc.sheets, doc.slides), (0, 0, 0));

        let sheet = extract_for_chat("budget.xlsx", xlsx()).unwrap();
        assert_eq!(sheet.sheets, 2);
        assert!(sheet.text.contains("A1: Budget"));
        assert!(sheet.text.contains("B1: 1200"));

        let deck = extract_for_chat("plan.pptx", pptx()).unwrap();
        assert_eq!(deck.slides, 2);
        assert!(deck.text.contains("Next steps"));

        let csv = extract_for_chat("rows.csv", b"a,b\n1,2\n".to_vec()).unwrap();
        assert_eq!(csv.text, "a,b\n1,2\n");
        assert!(!csv.truncated);
    }

    #[test]
    fn a_scan_a_stranger_and_a_broken_file_each_say_why() {
        assert_eq!(
            extract_for_chat("scan.pdf", pdf("")).unwrap_err().code,
            "document_needs_ocr"
        );
        assert_eq!(
            extract_for_chat("old.doc", vec![1, 2, 3]).unwrap_err().code,
            "document_format"
        );
        assert_eq!(
            extract_for_chat("broken.docx", b"not a zip".to_vec())
                .unwrap_err()
                .code,
            "document_unreadable"
        );
    }

    #[test]
    fn a_long_document_is_clipped_for_the_turn() {
        let long = "word ".repeat(MAX_CHAT_CHARS);
        let read = extract_for_chat("long.txt", long.into_bytes()).unwrap();
        assert!(read.truncated);
        assert_eq!(read.text.chars().count(), MAX_CHAT_CHARS);
    }

    #[tokio::test]
    async fn the_command_takes_base64_or_a_data_url() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(docx("Hello"));
        for data in [
            encoded.clone(),
            format!("data:application/octet-stream;base64,{encoded}"),
        ] {
            let read = document_extract(DocumentExtractRequest {
                name: "a.docx".into(),
                data,
            })
            .await
            .unwrap();
            assert!(read.text.contains("Hello"));
        }
    }

    #[test]
    fn an_imported_document_gets_its_text_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let deck = dir.path().join("plan.pptx");
        std::fs::write(&deck, pptx()).unwrap();
        let text_path = extract_beside(&deck).expect("text written");
        assert!(text_path.ends_with("plan.pptx.txt"));
        assert!(std::fs::read_to_string(&text_path)
            .unwrap()
            .contains("Roadmap"));

        let image = dir.path().join("photo.png");
        std::fs::write(&image, [0u8; 8]).unwrap();
        assert_eq!(extract_beside(&image), None);
        let scan = dir.path().join("scan.pdf");
        std::fs::write(&scan, pdf("")).unwrap();
        assert_eq!(extract_beside(&scan), None);
    }
}
