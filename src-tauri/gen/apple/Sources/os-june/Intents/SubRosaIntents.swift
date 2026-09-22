import AppIntents

// The app's actions in the Shortcuts app: each one opens Sub Rosa and hands
// the request over through the inbox (see IntentInbox). Available from iOS 16;
// the app itself still runs on iOS 15, where the framework is weakly linked
// and these types simply do not exist.

@available(iOS 16.0, *)
struct RecordAudioNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "New audio note"
    static let description = IntentDescription("Opens Sub Rosa on a new note and starts recording.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await IntentInbox.deliver(action: "record")
        return .result()
    }
}

@available(iOS 16.0, *)
struct DictateIntent: AppIntent {
    static let title: LocalizedStringResource = "Dictate"
    static let description = IntentDescription("Opens dictation and starts listening.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await IntentInbox.deliver(action: "dictate")
        return .result()
    }
}

@available(iOS 16.0, *)
struct AskSubRosaIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Sub Rosa"
    static let description = IntentDescription("Opens a new chat with your question, and sends it.")
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Question", requestValueDialog: "What do you want to ask?")
    var question: String

    @Parameter(title: "Send now", default: true)
    var sendNow: Bool

    @MainActor
    func perform() async throws -> some IntentResult {
        await IntentInbox.deliver(action: "ask", query: question, send: sendNow)
        return .result()
    }
}
