//! Every host this binary can reach, and why.
//!
//! "Your prompts do not go anywhere else" was an argument about architecture:
//! true, and unmeasured. This is the list that makes it checkable, and it has
//! exactly one copy on purpose. `tests/egress.rs` asserts that no host appears
//! in the source without appearing here, and the Privacy screen in Settings
//! renders the same rows — so a destination that is not in this list is one the
//! build refuses AND one the user would never have been shown.
//!
//! The Carpe Diem base is deliberately not a row. The user types it in
//! Settings, so it is theirs rather than ours; the screen reads it live and
//! shows it first. `validate_base_url` is what bounds it (https for anything
//! that is not loopback), and the local backend is the only thing that ever
//! receives a prompt.

use serde::Serialize;

/// Whether the app contacts a host on its own, or only because the user asked.
///
/// This is the distinction a person actually cares about, and the reason the
/// screen is worth having at all: a flat list of hosts would answer a question
/// nobody asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reach {
    /// Contacted as part of running normally.
    Always,
    /// Contacted only after the user clicks something, pastes a link, or
    /// enters a key of their own.
    WhenAsked,
}

/// One declared destination.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressHost {
    pub host: &'static str,
    pub reach: Reach,
    /// Plain language, addressed to the reader of the settings screen.
    pub reason: &'static str,
}

const fn host(host: &'static str, reach: Reach, reason: &'static str) -> EgressHost {
    EgressHost {
        host,
        reach,
        reason,
    }
}

/// The whole list. Ordered as the screen reads it: what happens without you,
/// then what happens because of you.
pub const DECLARED_EGRESS: &[EgressHost] = &[
    host(
        "127.0.0.1",
        Reach::Always,
        "The local backend on your own machine. Your notes, transcripts and recordings go here and stop here.",
    ),
    host(
        "carpe-diem.xyz",
        Reach::Always,
        "The default address for your requests to a model. You can change it in Connection.",
    ),
    host(
        "api.venice.ai",
        Reach::Always,
        "The public list of models, read to show you their names and prices. Your key is not sent.",
    ),
    host(
        "raw.githubusercontent.com",
        Reach::Always,
        "The update manifest, checked against a signing key built into the app.",
    ),
    host(
        "github.com",
        Reach::Always,
        "The agent runtime, downloaded once and checked against a known fingerprint.",
    ),
    host(
        "objects.githubusercontent.com",
        Reach::Always,
        "Where a download from github.com actually fetches the file.",
    ),
    host(
        "astral.sh",
        Reach::Always,
        "The Python launcher the agent needs on Windows, downloaded once and checked against a known fingerprint.",
    ),
    host(
        "api.github.com",
        Reach::WhenAsked,
        "Filing a report, with your own account, when you send one.",
    ),
    host(
        "places.googleapis.com",
        Reach::WhenAsked,
        "Details for a place, only once you have entered a Google Places key of your own.",
    ),
    host(
        "tile.openstreetmap.org",
        Reach::WhenAsked,
        "The map behind a place card.",
    ),
    host(
        "t.me",
        Reach::WhenAsked,
        "The community link, opened in your browser when you click it.",
    ),
];

/// The declared destinations, for the Privacy screen.
///
/// A command rather than a bundled constant in the frontend, so there is one
/// list and the test that guards it guards the same rows the user reads.
#[tauri::command]
pub fn declared_egress() -> Vec<EgressHost> {
    DECLARED_EGRESS.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_readable_and_has_no_duplicates() {
        let mut hosts: Vec<&str> = DECLARED_EGRESS.iter().map(|entry| entry.host).collect();
        let before = hosts.len();
        hosts.sort_unstable();
        hosts.dedup();
        assert_eq!(before, hosts.len(), "a host is declared twice");

        for entry in DECLARED_EGRESS {
            assert!(!entry.host.is_empty());
            assert!(
                entry.reason.len() > 25,
                "{} needs a reason a person can read, not a label",
                entry.host
            );
            assert!(
                entry.reason.ends_with('.'),
                "{} reads on a settings screen, so it is a sentence",
                entry.host
            );
        }
    }

    #[test]
    fn both_kinds_of_reach_are_represented() {
        // A list that was all "Always" would be hiding the distinction it
        // exists to show.
        assert!(DECLARED_EGRESS
            .iter()
            .any(|entry| entry.reach == Reach::Always));
        assert!(DECLARED_EGRESS
            .iter()
            .any(|entry| entry.reach == Reach::WhenAsked));
    }

    #[test]
    fn the_loopback_row_comes_first() {
        // The answer to "where does my data go" is the first line, not the
        // eleventh.
        assert_eq!(DECLARED_EGRESS[0].host, "127.0.0.1");
    }
}
