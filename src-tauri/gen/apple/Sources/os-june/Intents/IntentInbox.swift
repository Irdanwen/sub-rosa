import Foundation
import UIKit

/// The Shortcuts actions' half of the hand-off to the app (the app's half is
/// `src-tauri/src/intent_inbox.rs`).
///
/// An action runs in the app's own process, but the app's logic lives in the
/// webview and in Rust, not here. So an action does one thing: it writes what
/// was asked for in the App Group container and opens the app on
/// `subrosa://intent/<id>`. The manifest, not the address, is what carries the
/// request: any page can open an address, only the app can write here, and
/// that is what lets "send the question now" be honoured.
///
/// The address is the fast path. The app also sweeps this inbox whenever it
/// comes to the foreground, so a request whose address was lost (a cold
/// start) is still acted on.
enum IntentInbox {
    static let appGroup = "group.xyz.carpediem.subrosa"
    static let directory = "intent-inbox"

    @MainActor
    static func deliver(action: String, query: String? = nil, send: Bool = false) async {
        let id = UUID().uuidString.lowercased()
        var manifest: [String: Any] = [
            "v": 1,
            "action": action,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
        if let query { manifest["query"] = query }
        if send { manifest["send"] = true }
        guard
            let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup),
            let data = try? JSONSerialization.data(withJSONObject: manifest)
        else {
            return
        }
        let inbox = container.appendingPathComponent(directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        do {
            try data.write(to: inbox.appendingPathComponent("\(id).json"), options: .atomic)
        } catch {
            return
        }
        if let url = URL(string: "subrosa://intent/\(id)") {
            _ = await UIApplication.shared.open(url)
        }
    }
}
