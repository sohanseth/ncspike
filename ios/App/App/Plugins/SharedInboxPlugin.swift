//
//  SharedInboxPlugin.swift
//  NeuralConnexions: what was shared to the app from other apps (the NCShare extension), for reading on the phone.
//
//  JavaScript (registerPlugin("SharedInbox")):
//    list() -> { items: [{ id, capturedAt, kind: "text" | "image", text?, path? }] }
//      Oldest first. A photo's path can go straight to LetterText.read.
//    remove({ ids: [string] }) -> { removed: number }
//      Call once the app has kept what it needs, so shared messages don't stay in the shared folder.
//
//  The extension writes captures/pending/<id>.json (and <id>.bin for a photo) in the App Group
//  group.com.neuralconnexions.shared, as docs/10-spec-share-extension.md §4 says. Unlike its §6 and §7, nothing is
//  sent to a server: the app reads each one on the phone, then removes it.
//
//  Registered in MainViewController.swift.
//

import Capacitor
import Foundation

@objc(SharedInboxPlugin)
public class SharedInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedInboxPlugin"
    public let jsName = "SharedInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]
    static let group = "group.com.neuralconnexions.shared"

    private var pending: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group)?
            .appendingPathComponent("captures/pending", isDirectory: true)
    }

    @objc func list(_ call: CAPPluginCall) {
        guard let dir = pending else {
            call.resolve(["items": [JSObject]()])
            return
        }
        let fm = FileManager.default
        var items: [JSObject] = []
        for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasSuffix(".json") {
            let file = dir.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: file),
                  let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let id = doc["id"] as? String, Self.safeId(id), name == id + ".json",
                  let payload = doc["payload"] as? [String: Any],
                  let kind = payload["kind"] as? String else {
                try? fm.removeItem(at: file)                          // unreadable: nothing worth keeping
                continue
            }
            var item: JSObject = ["id": id, "capturedAt": (doc["capturedAt"] as? String) ?? "", "kind": kind]
            if kind == "text", let text = payload["text"] as? String {
                item["text"] = text
            } else if kind == "image", fm.fileExists(atPath: dir.appendingPathComponent(id + ".bin").path) {
                item["path"] = dir.appendingPathComponent(id + ".bin").path
            } else {
                continue
            }
            items.append(item)
        }
        items.sort { (($0["capturedAt"] as? String) ?? "") < (($1["capturedAt"] as? String) ?? "") }
        call.resolve(["items": items])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let dir = pending else {
            call.resolve(["removed": 0])
            return
        }
        var removed = 0
        for id in call.getArray("ids", String.self) ?? [] where Self.safeId(id) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(id + ".bin"))
            if (try? FileManager.default.removeItem(at: dir.appendingPathComponent(id + ".json"))) != nil {
                removed += 1
            }
        }
        call.resolve(["removed": removed])
    }

    /// A capture's id is a UUID, so a name built from it can't point outside the folder.
    static func safeId(_ id: String) -> Bool {
        UUID(uuidString: id) != nil
    }
}
