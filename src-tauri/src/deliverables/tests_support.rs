//! What every Office file this app writes must satisfy before a reader will
//! open it without a repair prompt: the package rules of OPC (ECMA-376 part
//! 2), checked on the bytes the writers produce.
//!
//! - `[Content_Types].xml` comes first and gives every part a content type,
//!   by override or by extension, and every override names a part that
//!   exists;
//! - every XML part is well formed;
//! - every relationship part belongs to a part that exists, its ids are
//!   unique, and every internal target resolves to a part in the zip;
//! - the package's root relationships name the main document.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;

pub(crate) fn part_names(bytes: &[u8]) -> Vec<String> {
    let archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    archive.file_names().map(str::to_string).collect()
}

pub(crate) fn part(bytes: &[u8], name: &str) -> String {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut file = archive
        .by_name(name)
        .unwrap_or_else(|_| panic!("missing part {name}"));
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    text
}

/// Every element's attributes, in document order: `(element, {name: value})`.
fn elements(xml: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut depth = 0i32;
    loop {
        let (tag, opened) = match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(Event::Start(tag)) => (tag, true),
            Ok(Event::Empty(tag)) => (tag, false),
            Ok(Event::End(_)) => {
                depth -= 1;
                continue;
            }
            Ok(_) => continue,
            Err(error) => panic!("XML is not well formed: {error}\n{xml}"),
        };
        let name = String::from_utf8_lossy(tag.local_name().as_ref()).into_owned();
        let mut attributes = BTreeMap::new();
        for attribute in tag.attributes() {
            let attribute = attribute.unwrap_or_else(|e| panic!("bad attribute: {e}"));
            let value = attribute
                .decoded_and_normalized_value(quick_xml::XmlVersion::default(), reader.decoder())
                .unwrap()
                .into_owned();
            attributes.insert(
                String::from_utf8_lossy(attribute.key.local_name().as_ref()).into_owned(),
                value,
            );
        }
        out.push((name, attributes));
        if opened {
            depth += 1;
        }
    }
    assert_eq!(depth, 0, "unbalanced XML");
    out
}

/// `../media/a.png` from `ppt/slides/` is `ppt/media/a.png`.
fn resolve(base: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    for piece in target.split('/') {
        match piece {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub(crate) fn assert_valid_package(bytes: &[u8]) {
    let names = part_names(bytes);
    assert_eq!(
        names.first().map(String::as_str),
        Some("[Content_Types].xml")
    );
    let present: BTreeSet<&str> = names.iter().map(String::as_str).collect();

    let mut defaults = BTreeMap::new();
    let mut overrides = BTreeMap::new();
    for (element, attributes) in elements(&part(bytes, "[Content_Types].xml")) {
        match element.as_str() {
            "Default" => {
                defaults.insert(
                    attributes["Extension"].to_ascii_lowercase(),
                    attributes["ContentType"].clone(),
                );
            }
            "Override" => {
                let name = attributes["PartName"].trim_start_matches('/').to_string();
                assert!(
                    present.contains(name.as_str()),
                    "override for missing part {name}"
                );
                overrides.insert(name, attributes["ContentType"].clone());
            }
            _ => {}
        }
    }
    for name in &names {
        if name == "[Content_Types].xml" {
            continue;
        }
        let extension = name
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            overrides.contains_key(name) || defaults.contains_key(&extension),
            "{name} has no content type"
        );
        if name.ends_with(".xml") || name.ends_with(".rels") {
            elements(&part(bytes, name));
        }
    }

    let mut root_has_document = false;
    for name in names.iter().filter(|name| name.ends_with(".rels")) {
        let (folder, file) = name.rsplit_once("_rels/").unwrap_or(("", name));
        let source = format!("{folder}{}", file.trim_end_matches(".rels"));
        if !source.is_empty() {
            assert!(
                present.contains(source.as_str()),
                "{name} belongs to no part"
            );
        }
        let mut ids = BTreeSet::new();
        for (element, attributes) in elements(&part(bytes, name)) {
            if element != "Relationship" {
                continue;
            }
            assert!(
                ids.insert(attributes["Id"].clone()),
                "duplicate id in {name}"
            );
            if attributes.get("TargetMode").map(String::as_str) == Some("External") {
                continue;
            }
            let target = resolve(folder, &attributes["Target"]);
            assert!(
                present.contains(target.as_str()),
                "{name} points at missing {target}"
            );
            if source.is_empty() && attributes["Type"].ends_with("/officeDocument") {
                root_has_document = true;
            }
        }
    }
    assert!(root_has_document, "the root relationships name no document");
}

#[test]
fn resolution_follows_relative_targets() {
    assert_eq!(resolve("ppt/slides/", "../media/a.png"), "ppt/media/a.png");
    assert_eq!(resolve("", "word/document.xml"), "word/document.xml");
    assert_eq!(resolve("xl/", "/xl/styles.xml"), "xl/styles.xml");
}

#[test]
fn the_word_writer_passes_the_same_checks() {
    let bytes = crate::docx::markdown_to_docx(
        "Check",
        "# Check\n\n- a\n\n1. b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n[link](https://example.org)",
    )
    .unwrap();
    assert_valid_package(&bytes);
}

#[test]
fn the_app_reads_back_the_sheets_and_slides_it_writes() {
    let (sheet, _) = super::xlsx::build(
        "Read back",
        &serde_json::json!({"rows": [["Name", "Total"], ["Rent & co", "=SUM(1,2)"]]}),
    )
    .unwrap();
    let text = crate::documents::extract_for_chat("x.xlsx", sheet)
        .unwrap()
        .text;
    assert!(text.contains("Rent & co"), "{text}");
    let (deck, _) = super::pptx::build(
        "Read back",
        &serde_json::json!({"slides": [{"title": "Opening"}, {"title": "Plan", "bullets": ["Ship **it**"]}]}),
        &|_| Err(String::new()),
    )
    .unwrap();
    let text = crate::documents::extract_for_chat("x.pptx", deck)
        .unwrap()
        .text;
    assert!(text.contains("Opening") && text.contains("Ship"), "{text}");
    assert!(text.contains("[Slide 2]"), "{text}");
}

#[test]
fn the_mcp_restates_the_same_tool() {
    let script = include_str!("../hermes/june_media_mcp.py");
    assert!(script.contains("\"name\": \"make_document\""));
    assert!(script.contains(super::CONTENT_DESCRIPTION));
    assert!(script.contains(super::TOOL_DESCRIPTION));
}
