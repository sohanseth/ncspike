//
//  ShareViewController.swift (the NCShare share extension)
//  NeuralConnexions: Share → NeuralConnexions from WhatsApp, Mail, Messages, Photos or any other app.
//
//  It saves what was shared (its text, and one photo) to the App Group for the app to read on the phone, says
//  so, and closes. No network calls, nothing else kept (docs/10-spec-share-extension.md §4 and §5, with text up
//  to 64 KB, and a photo saved again as a JPEG at most 3,000 pixels across, which also drops its location).
//
//  This replaces the ShareViewController.swift Xcode makes with the Share Extension target; the target's
//  MainInterface.storyboard keeps working with it.
//

import UIKit
import UniformTypeIdentifiers

class ShareViewController: UIViewController {
    private let group = "group.com.neuralconnexions.shared"
    private let maxTextBytes = 64 * 1024
    private let label = UILabel()

    private enum ShareError: Error { case nothing, tooLong, noGroup }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.text = "Saving…"
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
        ])
        Task { await save() }
    }

    private func save() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        do {
            var saved = 0
            var texts: [String] = []
            for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                if let t = try? await loadText(p), !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    texts.append(t)
                }
            }
            if texts.isEmpty, let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
                let item = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier)
                if let url = item as? URL {
                    texts.append(url.absoluteString)
                }
            }
            if !texts.isEmpty {
                let text = texts.joined(separator: "\n\n")
                if text.utf8.count > maxTextBytes { throw ShareError.tooLong }
                try saveCapture(payload: ["kind": "text", "text": text])
                saved += 1
            }
            if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }),
               let image = try? await loadImage(p), let data = jpeg(image) {
                try saveCapture(payload: ["kind": "image", "mimeType": "image/jpeg", "bytes": data.count], blob: data)
                saved += 1
            }
            if saved == 0 { throw ShareError.nothing }
            finish("Saved. Open NeuralConnexions to check what it found.")
        } catch ShareError.tooLong {
            finish("That's too long to save. Try sharing part of it.")
        } catch {
            finish("Couldn't save that. Copy it, then paste it into NeuralConnexions instead.")
        }
    }

    private func loadText(_ p: NSItemProvider) async throws -> String {
        let item = try await p.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        if let s = item as? String { return s }
        if let a = item as? NSAttributedString { return a.string }
        if let d = item as? Data, let s = String(data: d, encoding: .utf8) { return s }
        if let u = item as? URL, u.isFileURL, let s = try? String(contentsOf: u, encoding: .utf8) { return s }
        throw ShareError.nothing
    }

    private func loadImage(_ p: NSItemProvider) async throws -> UIImage {
        let item = try await p.loadItem(forTypeIdentifier: UTType.image.identifier)
        if let image = item as? UIImage { return image }
        if let d = item as? Data, let image = UIImage(data: d) { return image }
        if let u = item as? URL, let image = UIImage(contentsOfFile: u.path) { return image }
        throw ShareError.nothing
    }

    /// Drawn again upright and at most 3,000 pixels across: small enough for this extension's memory, sharp enough
    /// to read, and the photo's metadata (its location too) isn't copied.
    private func jpeg(_ image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height, 1)
        let scale = min(1, 3000 / longest)
        let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return drawn.jpegData(compressionQuality: 0.85)
    }

    /// The photo first, then its manifest, each written whole (.atomic), so the app never sees half of one.
    private func saveCapture(payload: [String: Any], blob: Data? = nil) throws {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw ShareError.noGroup
        }
        let dir = base.appendingPathComponent("captures/pending", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        var payload = payload
        if let blob = blob {
            try blob.write(to: dir.appendingPathComponent(id + ".bin"), options: .atomic)
            payload["relativePath"] = "captures/pending/\(id).bin"
        }
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let doc: [String: Any] = [
            "id": id, "capturedAt": stamp.string(from: Date()), "schemaVersion": 1,
            "sourceBundleId": NSNull(), "sourceAppName": NSNull(), "payload": payload,
        ]
        let data = try JSONSerialization.data(withJSONObject: doc)
        try data.write(to: dir.appendingPathComponent(id + ".json"), options: .atomic)
    }

    private func finish(_ message: String) {
        label.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }
}
