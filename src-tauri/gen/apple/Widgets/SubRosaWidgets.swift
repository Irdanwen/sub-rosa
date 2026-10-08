import SwiftUI
import WidgetKit

// Sub Rosa's widgets (ADR-0095): one tap from the Home Screen or the Lock
// Screen to the place in the app where something starts. Each one is a link
// into the app's address vocabulary (src/lib/destinations.ts), the same
// addresses Settings lists; the app does the rest. Nothing here reads the
// app's data, so the widgets show no content and never need refreshing.

enum WidgetDestination {
    static let ask = URL(string: "subrosa://chat/new")!
    static let dictate = URL(string: "subrosa://dictation?start=1")!
    static let record = URL(string: "subrosa://record")!
}

struct ActionEntry: TimelineEntry {
    let date: Date
}

/// One entry, forever: the widgets are buttons, not a view of anything.
struct StaticProvider: TimelineProvider {
    func placeholder(in context: Context) -> ActionEntry { ActionEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (ActionEntry) -> Void) {
        completion(ActionEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ActionEntry>) -> Void) {
        completion(Timeline(entries: [ActionEntry(date: Date())], policy: .never))
    }
}

extension View {
    /// iOS 17 asks every widget for its background; earlier systems draw
    /// their own.
    @ViewBuilder
    func subRosaWidgetBackground() -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) { Color(uiColor: .secondarySystemBackground) }
        } else {
            background(Color(uiColor: .secondarySystemBackground))
        }
    }
}

// MARK: - Ask (small, and the Lock Screen)

struct AskWidgetView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .systemSmall:
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: "text.bubble")
                    .font(.title2)
                    .foregroundColor(.accentColor)
                Spacer(minLength: 0)
                Text("Ask Sub Rosa")
                    .font(.headline)
                Text("Opens a new chat.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .subRosaWidgetBackground()
            .widgetURL(WidgetDestination.ask)
        default:
            AskAccessoryView()
                .widgetURL(WidgetDestination.ask)
        }
    }
}

/// The Lock Screen families exist from iOS 16; the widget only offers them
/// there (see `AskWidget.families`).
struct AskAccessoryView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if #available(iOSApplicationExtension 16.0, *) {
            switch family {
            case .accessoryInline:
                Label("Ask Sub Rosa", systemImage: "text.bubble")
            case .accessoryRectangular:
                VStack(alignment: .leading) {
                    Label("Sub Rosa", systemImage: "text.bubble")
                        .font(.headline)
                    Text("Ask")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .subRosaWidgetBackground()
            default:
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "text.bubble")
                        .font(.title3)
                }
                .accessibilityLabel(Text("Ask Sub Rosa"))
                .subRosaWidgetBackground()
            }
        } else {
            Text("Ask Sub Rosa")
        }
    }
}

struct AskWidget: Widget {
    static var families: [WidgetFamily] {
        if #available(iOSApplicationExtension 16.0, *) {
            return [.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline]
        }
        return [.systemSmall]
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "xyz.carpediem.subrosa.ask", provider: StaticProvider()) { _ in
            AskWidgetView()
        }
        .configurationDisplayName("Ask Sub Rosa")
        .description("Opens a new chat.")
        .supportedFamilies(Self.families)
    }
}

// MARK: - Ask, dictate, record (medium)

struct ActionTile: View {
    let title: LocalizedStringKey
    let symbol: String
    let destination: URL

    var body: some View {
        Link(destination: destination) {
            VStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.title2)
                    .foregroundColor(.accentColor)
                Text(title)
                    .font(.footnote.weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(uiColor: .tertiarySystemBackground))
            )
        }
    }
}

struct ActionsWidgetView: View {
    var body: some View {
        HStack(spacing: 8) {
            ActionTile(title: "Ask", symbol: "text.bubble", destination: WidgetDestination.ask)
            ActionTile(title: "Dictate", symbol: "mic", destination: WidgetDestination.dictate)
            ActionTile(title: "Record", symbol: "waveform", destination: WidgetDestination.record)
        }
        .subRosaWidgetBackground()
    }
}

struct ActionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "xyz.carpediem.subrosa.actions", provider: StaticProvider()) { _ in
            ActionsWidgetView()
        }
        .configurationDisplayName("Sub Rosa")
        .description("Ask, dictate or record in one tap.")
        .supportedFamilies([.systemMedium])
    }
}

@main
struct SubRosaWidgets: WidgetBundle {
    var body: some Widget {
        AskWidget()
        ActionsWidget()
    }
}
