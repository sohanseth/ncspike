//
//  OnDeviceLLMPlugin.swift
//  NeuralConnexions — Phase 2.8 on-device PRIVATE tier (iOS native).
//
//  Bridged from `src/lib/native-on-device-llm.ts`. See
//  `docs/11-spec-on-device-tier.md` §6 for the contract this plugin
//  implements.
//
//  Contract (must match the JS bridge exactly):
//
//    probe() -> {
//        available: Bool,
//        platform: "ios",
//        model: String?,         // present when available=true
//        reason: String?         // present when available=false
//    }
//
//    generate({ requestId: String,
//               messages: [{ role: String, content: String }],
//               maxTokens: Int?,
//               temperature: Double? })
//        -> { ok: true }
//        Streams output via `notifyListeners("onDeviceDelta", …)` and
//        terminates with either `onDeviceDone` or `onDeviceError`. The
//        plugin NEVER returns the full assistant string in the resolve
//        payload — streaming-only by design (see JS bridge docstring).
//
//    cancel({ requestId: String }) -> {}
//
//  Drop into `ios/App/App/Plugins/` after `npx cap add ios`. Registered
//  in `AppDelegate.swift` via the existing `capacitorViewDidLoad`
//  observer pattern (see that file). Requires:
//    - iOS 18.1 deployment target
//    - `import FoundationModels` (Apple Intelligence framework)
//    - "Apple Intelligence" capability on the app target
//

import Capacitor
import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

@objc(OnDeviceLLMPlugin)
public class OnDeviceLLMPlugin: CAPPlugin {

    // Active streaming tasks keyed by client-supplied requestId so
    // `cancel(requestId:)` can target the right one. Sessions are kept
    // alongside so they outlive the suspension points inside the Task.
    private var tasks: [String: Task<Void, Never>] = [:]
    #if canImport(FoundationModels)
    @available(iOS 18.1, *)
    private var sessions: [String: LanguageModelSession] {
        get { _sessions as? [String: LanguageModelSession] ?? [:] }
        set { _sessions = newValue }
    }
    private var _sessions: Any = [String: Any]()
    #endif

    // MARK: - probe

    @objc public func probe(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 18.1, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                call.resolve([
                    "available": true,
                    "platform": "ios",
                    "model": "apple-foundation-3b"
                ])
            case .unavailable(let reason):
                call.resolve([
                    "available": false,
                    "platform": "ios",
                    "reason": String(describing: reason)
                ])
            }
            return
        }
        #endif
        call.resolve([
            "available": false,
            "platform": "ios",
            "reason": "Requires iOS 18.1 with Apple Intelligence enabled."
        ])
    }

    // MARK: - generate

    @objc public func generate(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        guard #available(iOS 18.1, *) else {
            call.reject("Requires iOS 18.1+")
            return
        }
        guard let requestId = call.getString("requestId") else {
            call.reject("requestId required")
            return
        }
        guard let rawMessages = call.getArray("messages") else {
            call.reject("messages required")
            return
        }
        let messages: [[String: String]] = rawMessages.compactMap { entry in
            guard let dict = entry as? [String: Any],
                  let role = dict["role"] as? String,
                  let content = dict["content"] as? String else { return nil }
            return ["role": role, "content": content]
        }
        let maxTokens = call.getInt("maxTokens") ?? 1024
        let temperature = call.getDouble("temperature") ?? 0.4

        // Apple's LanguageModelSession takes a single prompt string;
        // we flatten the role-tagged history the same way the Android
        // adapter does so per-platform behaviour is consistent.
        let prompt = messages.map { m -> String in
            let role = (m["role"] ?? "user").uppercased()
            let content = m["content"] ?? ""
            return "\(role): \(content)"
        }.joined(separator: "\n\n") + "\n\nASSISTANT:"

        let session = LanguageModelSession()
        var current = sessions
        current[requestId] = session
        sessions = current

        let task = Task { [weak self] in
            guard let self = self else { return }
            do {
                let options = GenerationOptions(
                    temperature: temperature,
                    maximumResponseTokens: maxTokens
                )
                let stream = session.streamResponse(to: prompt, options: options)
                for try await partial in stream {
                    if Task.isCancelled { break }
                    self.notifyListeners("onDeviceDelta", data: [
                        "requestId": requestId,
                        "text": partial
                    ])
                }
                if Task.isCancelled {
                    self.notifyListeners("onDeviceError", data: [
                        "requestId": requestId,
                        "error": "Cancelled by user"
                    ])
                } else {
                    self.notifyListeners("onDeviceDone", data: [
                        "requestId": requestId,
                        "model": "apple-foundation-3b"
                    ])
                }
            } catch {
                self.notifyListeners("onDeviceError", data: [
                    "requestId": requestId,
                    "error": error.localizedDescription
                ])
            }
            var s = self.sessions
            s.removeValue(forKey: requestId)
            self.sessions = s
            self.tasks.removeValue(forKey: requestId)
        }
        tasks[requestId] = task
        call.resolve(["ok": true])
        #else
        call.reject("FoundationModels framework not available in this build")
        #endif
    }

    // MARK: - cancel

    @objc public func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            call.reject("requestId required")
            return
        }
        tasks[requestId]?.cancel()
        tasks.removeValue(forKey: requestId)
        #if canImport(FoundationModels)
        if #available(iOS 18.1, *) {
            var s = sessions
            s.removeValue(forKey: requestId)
            sessions = s
        }
        #endif
        call.resolve()
    }
}
