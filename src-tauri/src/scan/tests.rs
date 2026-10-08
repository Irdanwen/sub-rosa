use super::*;

fn line(text: &str, top: f64, bottom: f64) -> NativeLine {
    NativeLine {
        text: text.to_string(),
        top,
        bottom,
    }
}

fn page(lines: Vec<NativeLine>) -> NativePage {
    NativePage { lines }
}

#[derive(serde::Deserialize)]
struct Fixture {
    raw: String,
    escaped: String,
}

/// The same fixture `src/test/document-scan.test.ts` reads back through the
/// note's own parser: what Rust writes is what the editor reads.
#[test]
fn escapes_lines_the_way_the_note_serializer_does() {
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("escape_fixtures.json")).expect("fixture parses");
    assert!(fixtures.len() > 10);
    for fixture in fixtures {
        assert_eq!(
            escape_line(&fixture.raw),
            fixture.escaped,
            "{}",
            fixture.raw
        );
    }
}

#[test]
fn a_gap_of_about_one_line_starts_a_paragraph() {
    let lines = vec![
        line("Dear Ms Martin,", 0.10, 0.12),
        line("Thank you for your letter", 0.15, 0.17),
        line("of last week.", 0.175, 0.195),
        line("Kind regards", 0.30, 0.32),
    ];
    assert_eq!(
        paragraphs(&lines),
        vec![
            vec!["Dear Ms Martin,".to_string()],
            vec![
                "Thank you for your letter".to_string(),
                "of last week.".to_string()
            ],
            vec!["Kind regards".to_string()],
        ]
    );
}

#[test]
fn a_line_above_the_previous_one_is_the_next_column() {
    let lines = vec![
        line("left one", 0.10, 0.12),
        line("left two", 0.125, 0.145),
        line("right one", 0.10, 0.12),
    ];
    assert_eq!(paragraphs(&lines).len(), 2);
}

#[test]
fn blank_lines_and_inner_whitespace_are_dropped() {
    let lines = vec![
        line("  spaced    out  ", 0.1, 0.12),
        line("   ", 0.125, 0.145),
        line("next", 0.125, 0.145),
    ];
    assert_eq!(
        paragraphs(&lines),
        vec![vec!["spaced out".to_string(), "next".to_string()]]
    );
}

#[test]
fn lines_without_geometry_stay_one_paragraph() {
    let lines = vec![line("a", 0.0, 0.0), line("b", 0.0, 0.0)];
    assert_eq!(
        paragraphs(&lines),
        vec![vec!["a".to_string(), "b".to_string()]]
    );
}

#[test]
fn a_single_page_has_no_heading() {
    let pages = vec![page(vec![line("- 4 eggs", 0.1, 0.12)])];
    assert_eq!(note_body(&pages, "Page {n}"), "\\- 4 eggs");
}

#[test]
fn several_pages_get_a_heading_each_even_when_empty() {
    let pages = vec![
        page(vec![
            line("Invoice 42", 0.1, 0.12),
            line("Total *due*", 0.3, 0.32),
        ]),
        page(vec![]),
        page(vec![line("Signed", 0.5, 0.52)]),
    ];
    assert_eq!(
        note_body(&pages, "Page {n}"),
        "## Page 1\n\nInvoice 42\n\nTotal \\*due\\*\n\n## Page 2\n\n## Page 3\n\nSigned"
    );
    assert_eq!(plain_text(&pages), "Invoice 42\n\nTotal *due*\n\nSigned");
}

#[test]
fn the_page_heading_is_escaped_too() {
    let pages = vec![page(vec![]), page(vec![])];
    assert_eq!(note_body(&pages, "#{n}"), "## \\#1\n\n## \\#2");
}

#[test]
fn a_pdf_path_is_only_ever_named_by_a_note_id() {
    let dir = Path::new("/data/scans");
    let id = "0f9c6a4e-2b8c-4a59-9d1e-6c3c1d0b7e21";
    assert_eq!(pdf_path(dir, id), Some(dir.join(format!("{id}.pdf"))));
    assert_eq!(pdf_path(dir, "../notes"), None);
    assert_eq!(pdf_path(dir, ""), None);
    assert_eq!(pdf_path(dir, "0f9c6a4e/../../x"), None);
}

#[test]
fn stale_pdfs_are_the_orphans_and_the_half_written() {
    let dir = std::env::temp_dir().join(format!("subrosa-scan-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let live = "0f9c6a4e-2b8c-4a59-9d1e-6c3c1d0b7e21";
    let gone = "6a1f0f2e-8b3c-4d2a-9e4f-1a2b3c4d5e6f";
    for name in [
        format!("{live}.pdf"),
        format!("{gone}.pdf"),
        format!("{PENDING_PREFIX}abc.pdf"),
        "notes.txt".to_string(),
    ] {
        std::fs::write(dir.join(name), b"%PDF").expect("write");
    }
    let mut stale = stale_pdfs(&dir, |id| id == live);
    stale.sort();
    let mut expected = vec![
        dir.join(format!("{gone}.pdf")),
        dir.join(format!("{PENDING_PREFIX}abc.pdf")),
    ];
    expected.sort();
    assert_eq!(stale, expected);
    let _ = std::fs::remove_dir_all(&dir);
    assert!(stale_pdfs(&dir, |_| false).is_empty());
}

#[test]
fn the_native_answer_reads_with_missing_fields() {
    let scan: NativeScan = serde_json::from_str(
        r#"{"pages":[{"lines":[{"text":"Hello","top":0.1,"bottom":0.12}]},{}]}"#,
    )
    .expect("parses");
    assert!(!scan.cancelled);
    assert_eq!(scan.pages.len(), 2);
    let cancelled: NativeScan = serde_json::from_str(r#"{"cancelled":true}"#).expect("parses");
    assert!(cancelled.cancelled && cancelled.pages.is_empty());
}
