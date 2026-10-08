//! Destination addresses, Rust side.
//!
//! The mirror of `src/lib/destinations.ts`: the shell parses these, this
//! module builds them. Notifications are posted from Rust (the webview is
//! frozen while backgrounded), so the address a tap should land on has to be
//! decided here and travel with the notification, under the `extra` key both
//! sides agree on.
//!
//! Keep the two files in lockstep — a `#[test]` below pins the shapes, and
//! the TypeScript parser refuses anything it does not recognise, so a drift
//! shows up as a tap that does nothing rather than a tap that misfires.

/// The `extra` key a notification carries its destination under.
pub const EXTRA_KEY: &str = "destination";

const SCHEME: &str = "subrosa://";

pub fn note(note_id: &str) -> String {
    format!("{SCHEME}note/{note_id}")
}

pub fn chat(session_id: Option<&str>) -> String {
    match session_id {
        Some(id) if !id.is_empty() => format!("{SCHEME}chat/{id}"),
        _ => format!("{SCHEME}chat"),
    }
}

pub fn assistant(task_id: &str) -> String {
    format!("{SCHEME}assistant/{task_id}")
}

pub fn dictation() -> String {
    format!("{SCHEME}dictation")
}

pub fn studio() -> String {
    format!("{SCHEME}studio")
}

/// A retouch that finished: its session, open on the new version. Gallery
/// ids are file names the app minted (`<uuid>.png`), never paths.
pub fn retouch(root_id: &str, version_id: &str) -> String {
    format!("{SCHEME}studio?root={root_id}&retouch={version_id}")
}

/// The Today view: the daily brief and the results waiting for review
/// (ADR-0091). What an assignment's notification opens.
pub fn today() -> String {
    format!("{SCHEME}today")
}

/// Start a recording. This is what a brief's tap does: the one thing you
/// were about to do anyway.
pub fn record() -> String {
    format!("{SCHEME}record")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_match_the_shapes_the_shell_parses() {
        assert_eq!(note("note-abc"), "subrosa://note/note-abc");
        assert_eq!(chat(Some("task-1")), "subrosa://chat/task-1");
        assert_eq!(assistant("task-1"), "subrosa://assistant/task-1");
        assert_eq!(chat(None), "subrosa://chat");
        assert_eq!(chat(Some("")), "subrosa://chat");
        assert_eq!(dictation(), "subrosa://dictation");
        assert_eq!(studio(), "subrosa://studio");
        assert_eq!(
            retouch("a1.png", "b2.jpg"),
            "subrosa://studio?root=a1.png&retouch=b2.jpg"
        );
        assert_eq!(record(), "subrosa://record");
        assert_eq!(today(), "subrosa://today");
    }
}
