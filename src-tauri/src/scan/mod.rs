//! Scanning paper into a note, on the phone.
//!
//! The platform does the hard part: VisionKit's document camera and Vision's
//! text recognition on iOS (`ios.rs`, over `native/document-scanner`), ML
//! Kit's document scanner and text recognizer on Android (`android.rs`, over
//! `DocumentScanner.kt`). Both hand back the same thing: a multi-page PDF
//! written where this module asked, and the recognized lines of every page
//! with where each sits on its page. Everything after that is shared and
//! lives here, so the two phones cannot write two different notes from the
//! same sheet of paper.
//!
//! **A scan is a note.** No new noun and no new list: the recognized text is
//! the note's body, searchable and readable by the assistant like anything
//! the user typed, and the PDF is kept beside it so the original page is one
//! tap away.
//!
//! **The PDF is a file named by its note.** Notes have no attachments, and a
//! scan did not justify inventing them: the PDF lives at
//! `<app data>/scans/<note id>.pdf`, found again from the note id alone, so no
//! column has to point at it and no path is ever persisted (the iOS container
//! moves across reinstalls). A PDF whose note no longer exists is pruned the
//! next time anything is scanned. The file stays on the device: the note
//! synchronises, the scan does not.
//!
//! **The body round-trips.** It is written in the note's markdown dialect
//! (`src/lib/note-markdown.ts`), with every line escaped the way the editor's
//! serializer escapes it, so a line of OCR that happens to read `- 12 €` or
//! `# 3` stays text instead of becoming a list or a heading the first time
//! the note is opened. The escaping is pinned against the TypeScript parser
//! by a shared fixture (`escape_fixtures.json`).
#![cfg_attr(desktop, allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(target_os = "android")]
mod android;
#[cfg(mobile)]
pub mod commands;
#[cfg(target_os = "ios")]
mod ios;

/// The folder under the app data directory that holds every scan's PDF.
pub(crate) const SCANS_DIR: &str = "scans";

/// What a platform bridge reports once the camera closes.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeScan {
    /// The person closed the camera without keeping a page.
    #[serde(default)]
    pub cancelled: bool,
    /// The platform could not scan at all (no camera, no scanner module).
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub pages: Vec<NativePage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePage {
    /// Recognized lines in reading order.
    #[serde(default)]
    pub lines: Vec<NativeLine>,
}

/// One recognized line, positioned on its page as fractions of the page
/// height measured from the top, so both platforms speak the same units.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLine {
    pub text: String,
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub bottom: f64,
}

/// What the webview gets back: the note it can open, and the plain text for
/// a chat attachment.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentScanResult {
    pub note_id: String,
    pub pages: usize,
    /// The recognized text, unescaped, page after page.
    pub text: String,
}

/// The copy the note is written with. It comes from the webview, which owns
/// the person's language: the title and the page heading are words they read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentScanRequest {
    pub title: String,
    /// A heading for each page of a multi-page scan, with `{n}` for its number.
    pub page_heading: String,
}

/// Where the PDF of the scan behind `note_id` lives. `None` for anything that
/// is not a note id: the id names a file, so it must never be able to name a
/// path.
pub(crate) fn pdf_path(scans_dir: &Path, note_id: &str) -> Option<PathBuf> {
    let id = uuid::Uuid::parse_str(note_id.trim()).ok()?;
    Some(scans_dir.join(format!("{}.pdf", id.hyphenated())))
}

/// The paragraphs of one page. A gap between two lines wider than most of
/// the page's line heights starts a paragraph, and so does a line that sits
/// above the one before it (the next column). Lines inside a paragraph keep
/// their own line: the note reads a single newline as a line break, which is
/// what a scanned address, a receipt or a poem needs.
pub(crate) fn paragraphs(lines: &[NativeLine]) -> Vec<Vec<String>> {
    let kept: Vec<&NativeLine> = lines
        .iter()
        .filter(|line| !clean_line(&line.text).is_empty())
        .collect();
    let mut heights: Vec<f64> = kept
        .iter()
        .map(|line| (line.bottom - line.top).abs())
        .filter(|height| height.is_finite() && *height > 0.0)
        .collect();
    heights.sort_by(f64::total_cmp);
    let typical = heights.get(heights.len() / 2).copied().unwrap_or(0.0);

    let mut out: Vec<Vec<String>> = Vec::new();
    let mut previous: Option<&NativeLine> = None;
    for line in kept {
        let starts_paragraph = match previous {
            None => true,
            Some(before) if typical > 0.0 => {
                let gap = line.top - before.bottom;
                gap > typical * PARAGRAPH_GAP || line.bottom < before.top
            }
            Some(_) => false,
        };
        if starts_paragraph || out.is_empty() {
            out.push(Vec::new());
        }
        if let Some(paragraph) = out.last_mut() {
            paragraph.push(clean_line(&line.text));
        }
        previous = Some(line);
    }
    out
}

/// How much wider than a typical line height a gap has to be to read as a
/// blank line between paragraphs. Line spacing is a fraction of a line;
/// paragraph spacing is about one.
const PARAGRAPH_GAP: f64 = 0.8;

/// One line of recognized text, on one line, without the whitespace at its
/// ends that the note would trim anyway.
fn clean_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The note body: each page's paragraphs, under a heading per page when there
/// is more than one.
pub(crate) fn note_body(pages: &[NativePage], page_heading: &str) -> String {
    let headed = pages.len() > 1;
    let mut blocks: Vec<String> = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        if headed {
            let heading = page_heading.replace("{n}", &(index + 1).to_string());
            let heading = clean_line(&heading);
            blocks.push(format!("## {}", escape_line(&heading)));
        }
        for paragraph in paragraphs(&page.lines) {
            blocks.push(
                paragraph
                    .iter()
                    .map(|line| escape_line(line))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
    }
    blocks.join("\n\n")
}

/// The recognized text as a person would copy it, for the chat: no headings
/// and no escapes.
pub(crate) fn plain_text(pages: &[NativePage]) -> String {
    pages
        .iter()
        .map(|page| {
            paragraphs(&page.lines)
                .iter()
                .map(|paragraph| paragraph.join("\n"))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .filter(|page| !page.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Escapes one line of text so the note's markdown reads it back unchanged.
///
/// A port of `escapeMarkdownText` in `src/lib/note-markdown.ts` for a line of
/// bare text at the start of a line, outside any link. Keep the two in step:
/// `escape_fixtures.json` is asserted by both test suites.
pub(crate) fn escape_line(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(text.len() + 8);
    for (index, &c) in chars.iter().enumerate() {
        match c {
            '\\' | '`' | '*' => {
                out.push('\\');
                out.push(c);
            }
            '_' => {
                let intra_word = index > 0
                    && index + 1 < chars.len()
                    && is_word(chars[index - 1])
                    && is_word(chars[index + 1]);
                if !intra_word {
                    out.push('\\');
                }
                out.push(c);
            }
            '~' | '=' if chars.get(index + 1) == Some(&c) => {
                out.push('\\');
                out.push(c);
            }
            ']' if chars.get(index + 1) == Some(&'(') => out.push_str("\\]"),
            _ => out.push(c),
        }
    }
    escape_line_start(out)
}

/// The block markers, escaped in the first column only: a paragraph reading
/// `- not a list` must come back as a paragraph.
fn escape_line_start(line: String) -> String {
    if let Some(first) = line.chars().next() {
        if matches!(first, '#' | '>' | '+' | '-' | '|') {
            return format!("\\{line}");
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        let rest = &line[digits..];
        if rest.starts_with('.') || rest.starts_with(')') {
            return format!("{}\\{}", &line[..digits], rest);
        }
    }
    line
}

/// Removes the PDF of every scan whose note is gone for good, and any PDF a
/// scan left half-written. Best-effort: a stray file costs disk, never a scan.
pub(crate) fn stale_pdfs(scans_dir: &Path, live_note: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(scans_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                return false;
            };
            if stem.starts_with(PENDING_PREFIX) {
                return true;
            }
            path.extension().and_then(|ext| ext.to_str()) == Some("pdf")
                && uuid::Uuid::parse_str(stem).is_ok()
                && !live_note(stem)
        })
        .collect()
}

/// A PDF the native side is still writing, before it has a note to be named
/// after.
pub(crate) const PENDING_PREFIX: &str = "pending-";

#[cfg(test)]
mod tests;
