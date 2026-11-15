//
//  FoundItemsPlugin.swift
//  NeuralConnexions: Apple's on-device model for the message reader (src/lib/family-engine.ts, ModelCall).
//
//  JavaScript (registerPlugin("FoundItems")):
//    status() -> { available: boolean, reason: string }
//    find({ instructions, text }) -> { items: [{ type, title, child, when, time, prep, quote }] }
//
//  It reads one part of one shared message and proposes items in the shape the reader checks; the reader keeps
//  only what the message supports. Everything runs on the iPhone: no network, no account, nothing kept.
//  Apple's model needs iOS 26 and Apple Intelligence (iPhone 15 Pro and newer, turned on in Settings). Elsewhere
//  status() says why in plain words, and the reader uses its rules alone. A part too long for the model's window
//  is rejected with "exceededContextWindowSize": the reader then sends it again in smaller parts.
//
//  Registered in MainViewController.swift.
//

import Capacitor
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct FoundItems {
    @Guide(description: "Everything in the message that affects the family's days. Empty if nothing does.", .maximumCount(12))
    var items: [FoundItem]
}

@available(iOS 26.0, *)
@Generable
struct FoundItem {
    @Guide(description: "weekly, event, forward or closure", .anyOf(["weekly", "event", "forward", "closure"]))
    var type: String
    @Guide(description: "A few words naming it")
    var title: String
    @Guide(description: "The child's name only if the quote names them, else empty")
    var child: String
    @Guide(description: "The exact words from the message that say when. Never a date in your own words.")
    var when: String
    @Guide(description: "Any time given, copied, else empty")
    var time: String
    @Guide(description: "What to bring or wear, copied, else empty")
    var prep: String
    @Guide(description: "The sentence it comes from, copied exactly, at most 40 words")
    var quote: String
}
#endif

@objc(FoundItemsPlugin)
public class FoundItemsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FoundItemsPlugin"
    public let jsName = "FoundItems"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "find", returnType: CAPPluginReturnPromise),
    ]

    /// Whether this iPhone can run Apple's model now, and if not, why.
    @objc func status(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                call.resolve(["available": true, "reason": ""])
            case .unavailable(let why):
                let reason: String
                switch why {
                case .deviceNotEligible:
                    reason = "This iPhone can't run Apple Intelligence."
                case .appleIntelligenceNotEnabled:
                    reason = "Apple Intelligence is turned off in Settings."
                case .modelNotReady:
                    reason = "Apple Intelligence is still getting ready. Try again later."
                @unknown default:
                    reason = String(describing: why)
                }
                call.resolve(["available": false, "reason": reason])
            }
            return
        }
        #endif
        call.resolve(["available": false, "reason": "Apple's model needs iOS 26 or later."])
    }

    /// One part of one message in, the model's proposals out. The reader checks every one against the message.
    @objc func find(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else {
            call.reject("Apple's model needs iOS 26 or later.")
            return
        }
        let instructions = call.getString("instructions") ?? ""
        let text = call.getString("text") ?? ""
        Task {
            do {
                let session = LanguageModelSession(instructions: instructions)
                let reply = try await session.respond(
                    to: "MESSAGE:\n" + text,
                    generating: FoundItems.self,
                    options: GenerationOptions(sampling: .greedy)
                )
                let items: [JSObject] = reply.content.items.map { item in
                    ["type": item.type, "title": item.title, "child": item.child, "when": item.when,
                     "time": item.time, "prep": item.prep, "quote": item.quote]
                }
                call.resolve(["items": items])
            } catch {
                call.reject(String(describing: error))
            }
        }
        #else
        call.reject("This build doesn't include Apple's model (it needs Xcode 26).")
        #endif
    }
}
