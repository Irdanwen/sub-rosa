import MobileCoreServices
import Social
import UIKit
import UniformTypeIdentifiers

/// The share sheet's half of "share to Sub Rosa" (ADR-0048).
///
/// An extension is a separate process with no access to the app's data, so
/// it does one thing: it copies what was shared (a link, a file, a text)
/// into the App Group container the app can read, writes a small manifest
/// next to it, and opens the app on `subrosa://share/<id>`. Everything else
/// (fetching the link, transcribing the file, making the note) is the app's
/// job, on its own rows, the way every import already works.
final class ShareViewController: UIViewController {
    private static let appGroup = "group.xyz.carpediem.subrosa"
    private static let scheme = "subrosa"
    private static let maxFileBytes: Int64 = 512 * 1024 * 1024

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        collect()
    }

    private func collect() {
        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
            let attachments = item.attachments, !attachments.isEmpty
        else {
            finish(nil)
            return
        }
        let id = UUID().uuidString.lowercased()
        // A link first: a page shared from Safari carries a URL and a text
        // preview, and the URL is the one the app can do something with.
        if let provider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { value, _ in
                if let url = value as? URL, url.scheme?.hasPrefix("http") == true {
                    self.write(id: id, manifest: ["kind": "link", "url": url.absoluteString])
                    self.finish(id)
                } else {
                    self.finish(nil)
                }
            }
            return
        }
        // Then a file (an audio or a video recording, a document).
        let fileTypes = [UTType.audio, UTType.movie, UTType.data]
        if let type = fileTypes.first(where: { type in attachments.contains { $0.hasItemConformingToTypeIdentifier(type.identifier) } }),
            let provider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(type.identifier) })
        {
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url, let copied = self.copyIntoContainer(url, id: id) else {
                    self.finish(nil)
                    return
                }
                self.write(id: id, manifest: ["kind": "file", "fileName": copied])
                self.finish(id)
            }
            return
        }
        // Last, plain text: a paragraph, a quote, a thought.
        if let provider = attachments.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { value, _ in
                let text = (value as? String) ?? (value as? NSAttributedString)?.string ?? ""
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    self.finish(nil)
                    return
                }
                self.write(id: id, manifest: ["kind": "text", "text": text])
                self.finish(id)
            }
            return
        }
        finish(nil)
    }

    private func inbox() -> URL? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else {
            return nil
        }
        let inbox = container.appendingPathComponent("share-inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        return inbox
    }

    private func copyIntoContainer(_ source: URL, id: String) -> String? {
        guard let inbox = inbox() else { return nil }
        let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        if size > Self.maxFileBytes { return nil }
        // The name the app shows and the extension it decodes by; the id keeps
        // two shares of the same file apart.
        let name = source.lastPathComponent.isEmpty ? "shared" : source.lastPathComponent
        let target = inbox.appendingPathComponent("\(id)-\(name)")
        try? FileManager.default.removeItem(at: target)
        do {
            try FileManager.default.copyItem(at: source, to: target)
            return target.lastPathComponent
        } catch {
            return nil
        }
    }

    private func write(id: String, manifest: [String: String]) {
        guard let inbox = inbox(),
            let data = try? JSONSerialization.data(withJSONObject: manifest, options: [])
        else { return }
        try? data.write(to: inbox.appendingPathComponent("\(id).json"), options: .atomic)
    }

    /// Hand over to the app, then let the sheet go. An extension may not call
    /// UIApplication.open; walking the responder chain to the host's
    /// application object is the sanctioned way to open a URL from one.
    private func finish(_ id: String?) {
        DispatchQueue.main.async {
            if let id, let url = URL(string: "\(Self.scheme)://share/\(id)") {
                var responder: UIResponder? = self
                while let current = responder {
                    if let application = current as? UIApplication {
                        application.open(url, options: [:], completionHandler: nil)
                        break
                    }
                    responder = current.next
                }
            }
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
    }
}
