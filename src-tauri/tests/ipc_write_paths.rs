//! No command accepts a place to write.
//!
//! `save_hermes_bridge_file` took a `destination` and created its parent
//! directories. The source was confined; the destination was not, and the
//! contents were whatever the agent last wrote into its workspace. That is an
//! arbitrary file write reachable from the webview, and it read as a download
//! button.
//!
//! The fix was to remove the parameter, not to filter it: both commands that
//! wrote where they were told now open the native picker in Rust. This test is
//! what keeps the parameter from coming back — the next person to add a
//! "save as" reaches for a `destination: String` field first, because that is
//! the obvious shape.
//!
//! Reading a path is a different question and stays allowed: those go through
//! `path_confinement::confine_existing`, which `tests/path_confinement.rs`
//! holds to its own corpus.

use std::collections::BTreeSet;
use std::path::Path;

/// Field names that name a place to write. A request struct reachable from the
/// webview must not carry one.
const WRITE_DESTINATION_FIELDS: &[&str] = &[
    "destination",
    "destination_path",
    "dest",
    "dest_path",
    "directory",
    "output_path",
    "output_dir",
    "save_path",
    "save_to",
    "target_path",
];

/// Structs that legitimately carry one of those names for something that is
/// **not** a webview-supplied write target. Each entry says why.
fn exempt(struct_name: &str, field: &str) -> bool {
    matches!(
        (struct_name, field),
        // What the export produced, on the way back out. Not an input.
        ("ExportedTimelineDto", "directory")
            // The gallery root the app itself computed, echoed for display.
            | ("MediaArtifactDto", "directory")
    )
}

fn rust_sources(dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            if let Ok(source) = std::fs::read_to_string(&path) {
                out.push((path.display().to_string(), source));
            }
        }
    }
}

/// Every `pub struct X { … }` in the file, as (name, body).
fn structs(source: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut rest = source;
    while let Some(at) = rest.find("pub struct ") {
        let after = &rest[at + "pub struct ".len()..];
        let name: String = after
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let Some(open) = after.find('{') else { break };
        let mut depth = 0usize;
        let mut end = None;
        for (index, ch) in after[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else { break };
        found.push((name, after[open..end].to_string()));
        rest = &after[end..];
    }
    found
}

/// `pub some_field:` declared in a struct body, ignoring doc comments.
fn field_names(body: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for line in body.lines() {
        let line = line.trim();
        let Some(after) = line.strip_prefix("pub ") else {
            continue;
        };
        let name: String = after
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() && after[name.len()..].trim_start().starts_with(':') {
            names.insert(name);
        }
    }
    names
}

#[test]
fn no_request_struct_carries_a_place_to_write() {
    let mut sources = Vec::new();
    rust_sources(Path::new("src"), &mut sources);
    assert!(
        sources.len() > 40,
        "the scan found only {} Rust files, which means it is looking in the wrong place",
        sources.len()
    );

    let mut offenders = Vec::new();
    for (path, source) in &sources {
        for (name, body) in structs(source) {
            for field in field_names(&body) {
                if WRITE_DESTINATION_FIELDS.contains(&field.as_str()) && !exempt(&name, &field) {
                    offenders.push(format!("{path}: {name}.{field}"));
                }
            }
        }
    }

    assert_eq!(
        offenders,
        Vec::<String>::new(),
        "a command must not be handed a place to write. Open the native picker in Rust \
         (see save_hermes_bridge_file / export_timeline_bundle), or add an exemption \
         in this test saying why the field is not a write target."
    );
}

#[test]
fn the_scanner_can_see_a_field_when_there_is_one() {
    // A parser that silently matched nothing would make the guard above pass
    // forever, which is the one way a test like this fails quietly.
    let sample = r#"
        #[derive(Deserialize)]
        pub struct SomeRequest {
            /// doc comment
            pub path: String,
            pub destination: String,
        }
    "#;
    let parsed = structs(sample);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].0, "SomeRequest");
    let fields = field_names(&parsed[0].1);
    assert!(fields.contains("path"));
    assert!(fields.contains("destination"));
}
