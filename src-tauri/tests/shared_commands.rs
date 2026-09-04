//! `lib.rs` carries two `generate_handler!` lists — one for desktop, one for
//! mobile — because the macro cannot cfg individual entries. A command added
//! to only one of them compiles perfectly and then fails at runtime on the
//! other platform, which is exactly the kind of mistake nothing else here
//! catches: the desktop build is green, the desktop tests are green, and the
//! phone throws "command not found" the first time a user taps the button.
//!
//! AGENTS.md says every new shared command goes in both lists. This is that
//! rule, enforced.
// Integration tests fail by panicking; the production rules on unwrap and
// expect (Cargo.toml [lints]) stop at this crate boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

use std::collections::BTreeSet;

/// Commands that genuinely belong to one platform. Everything else must appear
/// in both lists.
///
/// Add to this only when a command cannot exist on the other platform — a
/// desktop tray, an iOS share sheet — never to silence a mistake.
fn platform_specific(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        // Desktop-only subsystems.
        "hermes",
        "updates::",
        "menu_bar::",
        "agent_hud::",
        "meeting_hud::",
        "win_console::",
        "autostart",
        "dictation::",
        "os_accounts::",
        "theme_icon::",
        // A council issues a mandate for one agent to execute, and there is
        // no agent runtime on iOS to hand it to (ADR-0034).
        "council::",
        // The extractor rail runs a binary the user installed; iOS cannot
        // execute one at all (ADR-0028).
        "ingest::extractor::",
        // Mobile-only subsystems.
        "audio::ios_session::",
        "dictation_mobile::",
        "agent_lite::",
        "photos_ios::",
        "share_ios::",
        "keyboard_ios::",
        "ios_background::",
    ];
    const NAMES: &[&str] = &[
        "set_recording_presence_bounds",
        "open_hud_window",
        "close_hud_window",
        // Both are part of the desktop Hermes agent surface, which mobile
        // replaces with agent-lite.
        "commands::explain_agent_approval",
        "commands::save_agent_hermes_session",
        // The bundle is written where a native folder dialog says; the phone
        // has no such dialog and gets its logs through the share sheet later.
        "diagnostics::export_diagnostics",
        // Same reason: the archive is written where a save dialog says; the
        // phone imports one (pick_file works there) and exports through the
        // share sheet later.
        "archive::export_archive",
    ];
    PREFIXES.iter().any(|prefix| name.starts_with(prefix)) || NAMES.contains(&name)
}

/// The raw entries of every `generate_handler!` list in `lib.rs`, in order.
///
/// Parsing rather than pattern-matching, because the lists carry `#[cfg(...)]`
/// attributes whose own brackets would fool a search for the first `]`.
fn handler_entries() -> Vec<Vec<String>> {
    let source = include_str!("../src/lib.rs");
    let mut lists = Vec::new();
    let mut rest = source;
    while let Some(start) = rest.find("generate_handler![") {
        let after = &rest[start + "generate_handler![".len()..];
        let end = matching_bracket(after).expect("an unterminated generate_handler!");
        lists.push(parse_entries(&after[..end]));
        rest = &after[end..];
    }
    lists
}

/// Offset of the `]` that closes a list opened just before `body`.
fn matching_bracket(body: &str) -> Option<usize> {
    let mut depth = 0_i32;
    for (index, character) in body.char_indices() {
        match character {
            '[' => depth += 1,
            ']' => {
                if depth == 0 {
                    return Some(index);
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    None
}

/// Command paths in a list body, with attributes and comments removed.
fn parse_entries(body: &str) -> Vec<String> {
    let mut entries = Vec::new();
    for line in body.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        for entry in line.split(',') {
            let entry = entry.trim();
            if entry.is_empty() || entry.starts_with('#') {
                continue;
            }
            entries.push(entry.to_string());
        }
    }
    entries
}

fn handler_lists() -> Vec<BTreeSet<String>> {
    handler_entries()
        .into_iter()
        .map(|entries| entries.into_iter().collect())
        .collect()
}

#[test]
fn both_command_lists_exist() {
    let lists = handler_lists();
    assert_eq!(
        lists.len(),
        2,
        "lib.rs should carry exactly two generate_handler! lists (desktop and mobile)"
    );
}

#[test]
fn every_shared_command_is_registered_on_both_platforms() {
    let lists = handler_lists();
    let (first, second) = (&lists[0], &lists[1]);

    let only_in_first: Vec<&String> = first
        .difference(second)
        .filter(|name| !platform_specific(name))
        .collect();
    let only_in_second: Vec<&String> = second
        .difference(first)
        .filter(|name| !platform_specific(name))
        .collect();

    assert!(
        only_in_first.is_empty() && only_in_second.is_empty(),
        "these commands are registered on one platform only. Add them to both \
         generate_handler! lists in lib.rs, or add them to `platform_specific` \
         in this test if they genuinely cannot exist on the other platform.\n\
         missing from the second list: {only_in_first:?}\n\
         missing from the first list: {only_in_second:?}"
    );
}

#[test]
fn no_command_is_registered_twice_in_the_same_list() {
    // A set hides duplicates, so compare against the raw entries: a duplicated
    // entry is the fingerprint of an edit that matched the wrong list.
    for (index, entries) in handler_entries().into_iter().enumerate() {
        let unique: BTreeSet<&String> = entries.iter().collect();
        let duplicates: Vec<&String> = entries
            .iter()
            .filter(|entry| entries.iter().filter(|other| other == entry).count() > 1)
            .collect();
        assert_eq!(
            entries.len(),
            unique.len(),
            "generate_handler! list {index} registers a command twice: {duplicates:?}"
        );
    }
}
