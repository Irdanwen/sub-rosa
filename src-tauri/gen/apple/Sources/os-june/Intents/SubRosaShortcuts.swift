import AppIntents

/// Puts the actions in the Shortcuts app, Spotlight and the Action button
/// picker by themselves, with nothing to build. Every phrase names the app,
/// as the system requires; the question is asked for when the action runs.
@available(iOS 16.0, *)
struct SubRosaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RecordAudioNoteIntent(),
            phrases: [
                "New audio note in \(.applicationName)",
                "Record with \(.applicationName)",
            ]
        )
        AppShortcut(
            intent: DictateIntent(),
            phrases: [
                "Dictate with \(.applicationName)",
            ]
        )
        AppShortcut(
            intent: AskSubRosaIntent(),
            phrases: [
                "Ask \(.applicationName)",
            ]
        )
    }
}
