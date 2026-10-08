import SwiftUI
import WidgetKit

// The watch face complication (ADR-0095): "Ask", which opens the watch app on
// its question field. It shows nothing of the person's data, so it has one
// entry and never refreshes.

struct AskEntry: TimelineEntry {
    let date: Date
}

struct AskProvider: TimelineProvider {
    func placeholder(in context: Context) -> AskEntry { AskEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (AskEntry) -> Void) {
        completion(AskEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<AskEntry>) -> Void) {
        completion(Timeline(entries: [AskEntry(date: Date())], policy: .never))
    }
}

struct AskComplicationView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
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
            case .accessoryCorner:
                Image(systemName: "text.bubble")
                    .font(.title3)
                    .widgetLabel {
                        Text("Ask")
                    }
            default:
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "text.bubble")
                        .font(.title3)
                }
            }
        }
        .accessibilityLabel(Text("Ask Sub Rosa"))
        .containerBackground(for: .widget) { Color.clear }
    }
}

@main
struct AskComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "xyz.carpediem.subrosa.watch.ask", provider: AskProvider()) { _ in
            AskComplicationView()
        }
        .configurationDisplayName("Ask Sub Rosa")
        .description("Opens Sub Rosa to ask a question.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }
}
