import Foundation
import WatchConnectivity

/// The iPhone's end of the Apple Watch channel (ADR-0095; the app's half of
/// the work is `src-tauri/src/watch_relay.rs`).
///
/// The watch asks, the phone answers: a question arrives as a WatchConnectivity
/// message (iOS wakes the app in the background for it), is handed to Rust as
/// JSON through the C function Rust registered at launch, and Rust runs it as
/// an ordinary chat. The answer comes back through `deliver(_:)`, which sends
/// it at once when the watch is in reach and queues it otherwise.
///
/// Rust finds this class by its Objective-C name, so the name and the two
/// selectors are part of the contract (a Rust test reads them here).
@objc(SubRosaWatchBridge)
final class WatchBridge: NSObject, WCSessionDelegate {
    typealias Handler = @convention(c) (UnsafePointer<CChar>?) -> Void

    private static let shared = WatchBridge()
    private let lock = NSLock()
    private var handler: Handler?

    /// Called once at launch by Rust. Activates the session, after which
    /// messages the watch sent while the app was not running are delivered.
    @objc(startWithHandler:)
    static func start(handler: Handler) {
        guard WCSession.isSupported() else { return }
        shared.lock.lock()
        shared.handler = handler
        shared.lock.unlock()
        let session = WCSession.default
        session.delegate = shared
        session.activate()
    }

    /// An answer from Rust, as JSON. `false` when there is no watch to give it
    /// to, so Rust keeps the promise for a later try.
    @objc(deliver:)
    static func deliver(_ json: String) -> Bool {
        guard WCSession.isSupported(),
            let data = json.data(using: .utf8),
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return false }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled
        else { return false }
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { _ in
                // Out of reach between the check and the send: queue it.
                session.transferUserInfo(payload)
            }
        } else {
            session.transferUserInfo(payload)
        }
        return true
    }

    private func forward(_ message: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(message),
            let data = try? JSONSerialization.data(withJSONObject: message),
            let json = String(data: data, encoding: .utf8)
        else { return }
        lock.lock()
        let handler = self.handler
        lock.unlock()
        json.withCString { pointer in handler?(pointer) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        forward(message)
        // Only an acknowledgement: the answer takes longer than a reply may.
        replyHandler(["accepted": true])
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        forward(message)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        forward(userInfo)
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        // A switch to another watch: listen to the new one.
        session.activate()
    }
}
