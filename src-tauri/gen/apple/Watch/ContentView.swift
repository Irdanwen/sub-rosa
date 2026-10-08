import SwiftUI

/// The one screen: a field that opens the system's dictation, and the last
/// answer under it.
struct ContentView: View {
    @EnvironmentObject private var session: WatchSession
    @State private var question = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Ask Sub Rosa", text: $question)
                        .submitLabel(.send)
                        .onSubmit {
                            session.ask(question)
                            question = ""
                        }
                    if let exchange = session.latest {
                        ExchangeView(exchange: exchange)
                    }
                }
            }
            .navigationTitle("Sub Rosa")
        }
    }
}

struct ExchangeView: View {
    @EnvironmentObject private var session: WatchSession
    let exchange: Exchange

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(exchange.question)
                .font(.footnote)
                .foregroundColor(.secondary)
            switch exchange.state {
            case .asking:
                HStack(spacing: 6) {
                    ProgressView()
                        .frame(width: 18, height: 18)
                    Text("Your iPhone is answering.")
                        .font(.footnote)
                }
            case .queued:
                Text("Sent. Your iPhone answers when it is nearby.")
                    .font(.footnote)
            case .failed:
                Text("Sub Rosa could not answer. Open the chat on your iPhone.")
                    .font(.footnote)
            case .answered:
                Text(exchange.answer ?? "")
                Button {
                    if session.speaking {
                        session.stopSpeaking()
                    } else {
                        session.speak(exchange)
                    }
                } label: {
                    if session.speaking {
                        Label("Stop", systemImage: "stop.fill")
                    } else {
                        Label("Read aloud", systemImage: "speaker.wave.2")
                    }
                }
            }
        }
    }
}
