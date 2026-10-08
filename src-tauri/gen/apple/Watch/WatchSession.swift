import AVFoundation
import Foundation
import WatchConnectivity

/// One question and what became of it.
struct Exchange: Codable, Identifiable, Equatable {
    enum State: String, Codable {
        /// The iPhone has it and is answering.
        case asking
        /// Out of reach: WatchConnectivity holds it until the iPhone is near.
        case queued
        case answered
        case failed
    }

    let id: String
    let question: String
    var answer: String?
    var state: State
}

/// The watch's end of the channel to the iPhone (the phone's end is
/// `Sources/os-june/Watch/WatchBridge.swift`, then Rust's `watch_relay.rs`).
///
/// A question goes as a message when the iPhone is in reach (iOS wakes the
/// app in the background to take it) and as a queued transfer when it is
/// not. The answer comes back either way, keyed by the question's id; the
/// last few exchanges are kept so an answer that lands while the app is
/// closed is there when it opens.
final class WatchSession: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var exchanges: [Exchange] = []
    @Published private(set) var speaking = false

    private let synthesizer = AVSpeechSynthesizer()
    private static let storeKey = "subrosa.watch.exchanges"
    private static let kept = 10

    override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: Self.storeKey),
            let saved = try? JSONDecoder().decode([Exchange].self, from: data)
        {
            exchanges = saved
        }
        synthesizer.delegate = self
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    var latest: Exchange? { exchanges.last }

    func ask(_ text: String) {
        let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }
        let id = UUID().uuidString.lowercased()
        let message: [String: Any] = ["v": 1, "kind": "ask", "id": id, "question": question]
        let session = WCSession.default
        if session.activationState == .activated, session.isReachable {
            record(Exchange(id: id, question: question, answer: nil, state: .asking))
            session.sendMessage(message, replyHandler: nil) { [weak self] _ in
                session.transferUserInfo(message)
                self?.update(id) { $0.state = .queued }
            }
        } else {
            record(Exchange(id: id, question: question, answer: nil, state: .queued))
            session.transferUserInfo(message)
        }
    }

    func speak(_ exchange: Exchange) {
        guard let answer = exchange.answer else { return }
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(AVSpeechUtterance(string: answer))
    }

    func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    // MARK: - Answers

    private func receive(_ payload: [String: Any]) {
        guard payload["kind"] as? String == "answer", let id = payload["id"] as? String else { return }
        let answer = payload["answer"] as? String
        let failed = payload["failed"] as? Bool ?? false
        DispatchQueue.main.async {
            self.update(id) { exchange in
                if let answer, !failed {
                    exchange.answer = answer
                    exchange.state = .answered
                } else {
                    exchange.state = .failed
                }
            }
            if let exchange = self.exchanges.first(where: { $0.id == id }),
                exchange.state == .answered, exchange.id == self.latest?.id
            {
                self.speak(exchange)
            }
        }
    }

    private func record(_ exchange: Exchange) {
        exchanges.append(exchange)
        if exchanges.count > Self.kept { exchanges.removeFirst(exchanges.count - Self.kept) }
        save()
    }

    private func update(_ id: String, _ change: (inout Exchange) -> Void) {
        guard let index = exchanges.firstIndex(where: { $0.id == id }) else { return }
        change(&exchanges[index])
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(exchanges) {
            UserDefaults.standard.set(data, forKey: Self.storeKey)
        }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        receive(message)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        receive(userInfo)
    }
}

extension WatchSession: AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.speaking = true }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.speaking = false }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.speaking = false }
    }
}
