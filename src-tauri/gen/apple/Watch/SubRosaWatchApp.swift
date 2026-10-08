import SwiftUI

/// Sub Rosa on the wrist (ADR-0095): ask a question by voice, read the answer
/// and hear it. The watch holds no key and no notes; the iPhone runs the turn
/// and sends back the text (`WatchSession`).
@main
struct SubRosaWatchApp: App {
    @StateObject private var session = WatchSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(session)
        }
    }
}
