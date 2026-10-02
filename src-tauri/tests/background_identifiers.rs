//! The BGTaskScheduler identifiers the Rust side registers must be the ones
//! the app declares. A mismatch fails silently on the phone: the registration
//! returns NO, nothing logs, and the work it was meant to keep alive simply
//! stops when the screen locks (ADR-0018, ADR-0071).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::path::Path;

fn read(relative: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(relative))
        .unwrap_or_else(|error| panic!("{relative}: {error}"))
}

/// The value of a `const NAME: &str = "...";` in a source file.
fn string_const(source: &str, name: &str) -> String {
    let declaration = format!("const {name}: &str = \"");
    let start = source
        .find(&declaration)
        .unwrap_or_else(|| panic!("{name} is declared"))
        + declaration.len();
    let end = source[start..].find('"').expect("the literal is closed") + start;
    source[start..end].to_string()
}

fn plist_identifiers() -> Vec<String> {
    let plist = read("gen/apple/os-june_iOS/Info.plist");
    let start = plist
        .find("<key>BGTaskSchedulerPermittedIdentifiers</key>")
        .expect("the plist permits identifiers");
    let array = &plist[start..plist[start..].find("</array>").expect("the array closes") + start];
    array
        .split("<string>")
        .skip(1)
        .map(|item| {
            item.split("</string>")
                .next()
                .unwrap_or_default()
                .to_string()
        })
        .collect()
}

#[test]
fn every_registered_identifier_is_permitted_by_the_app() {
    let background = read("src/ios_background.rs");
    let continued = read("src/ios_continued.rs");
    let permitted = plist_identifiers();
    for name in ["REFRESH_IDENTIFIER", "PROCESSING_IDENTIFIER"] {
        let identifier = string_const(&background, name);
        assert!(
            permitted.contains(&identifier),
            "{identifier} is registered but not in BGTaskSchedulerPermittedIdentifiers"
        );
    }
    let prefix = string_const(&continued, "IDENTIFIER_PREFIX");
    assert!(
        prefix.ends_with('.'),
        "continued identifiers are <prefix>.<suffix>"
    );
    assert!(
        permitted.contains(&format!("{prefix}*")),
        "the continued-processing wildcard {prefix}* is not permitted"
    );
}

#[test]
fn the_project_spec_declares_the_same_identifiers_as_the_plist() {
    let project = read("gen/apple/project.yml");
    for identifier in plist_identifiers() {
        assert!(
            project.contains(&format!("- {identifier}")),
            "project.yml must list {identifier}, or a regenerated project drops it"
        );
    }
}
