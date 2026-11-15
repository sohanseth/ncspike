//
//  OnDeviceLLMPlugin.swift
//  NeuralConnexions: Phase 2.8 on-device PRIVATE tier (iOS native).
//
//  Bridged from `src/lib/native-on-device-llm.ts`. The contract is unchanged (docs/11-spec-on-device-tier.md §6):
//
//    probe() -> { available: Bool, platform: "ios", model: String?, reason: String? }
//    generate({ requestId, messages: [{ role, content }], maxTokens?, temperature? }) -> { ok: true }
//      Streams "onDeviceDelta" { requestId, text } with only the new text each time, then ends with
//      "onDeviceDone" { requestId, model } or "onDeviceError" { requestId, error }.
//    cancel({ requestId }) -> {}
//
//  Fixed on 15 Nov 2026, so PRIVATE chat can use Apple's model on the iPhone:
//    - Apple's model needs iOS 26. It was gated on iOS 18.1, which Xcode 26 refuses to build.
//    - Capacitor 8 doesn't find plugins inside the app by itself: it's registered in MainViewController.swift,
//      and names itself here (CAPBridgedPlugin).
//    - The stream's snapshots hold the whole answer so far, so only the new part is sent as a delta.
//  No capability or entitlement is needed for Apple's model.
//

import Capacitor
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

@objc(OnDeviceLLMPlugin)
public class OnDeviceLLMPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OnDeviceLLMPlugin"
    public let jsName = "OnDeviceLLM"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    // Streaming tasks by the client's requestId, so cancel() can stop the right one.
    private var tasks: [String: Task<Void, Never>] = [:]
    private let lock = NSLock()

    // MARK: - probe

    @objc public func probe(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                call.resolve(["available": true, "platform": "ios", "model": "apple-foundation-3b"])
            case .unavailable(let reason):
                call.resolve(["available": false, "platform": "ios", "reason": String(describing: reason)])
            }
            return
        }
        #endif
        call.resolve([
            "available": false,
            "platform": "ios",
            "reason": "Requires iOS 26 with Apple Intelligence turned on."
        ])
    }

    // MARK: - generate

    @objc public func generate(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, *) else {
            call.reject("Requires iOS 26 or later.")
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
        let messages: [(role: String, content: String)] = rawMessages.compactMap { entry in
            guard let dict = entry as? [String: Any],
                  let role = dict["role"] as? String,
                  let content = dict["content"] as? String else { return nil }
            return (role, content)
        }
        let maxTokens = call.getInt("maxTokens") ?? 1024
        let temperature = call.getDouble("temperature") ?? 0.4

        // Apple's session takes one prompt: the role-tagged history is flattened the same way as on Android.
        let prompt = messages.map { "\($0.role.uppercased()): \($0.content)" }.joined(separator: "\n\n")
            + "\n\nASSISTANT:"

        let task = Task { [weak self] in
            var sent = ""
            do {
                let session = LanguageModelSession()
                let options = GenerationOptions(temperature: temperature, maximumResponseTokens: maxTokens)
                for try await snapshot in session.streamResponse(to: prompt, options: options) {
                    if Task.isCancelled { break }
                    let whole = snapshot.content
                    let delta = whole.hasPrefix(sent) ? String(whole.dropFirst(sent.count)) : whole
                    sent = whole
                    if !delta.isEmpty {
                        self?.notifyListeners("onDeviceDelta", data: ["requestId": requestId, "text": delta])
                    }
                }
                if Task.isCancelled {
                    self?.notifyListeners("onDeviceError", data: ["requestId": requestId, "error": "Cancelled by user"])
                } else {
                    self?.notifyListeners("onDeviceDone", data: ["requestId": requestId, "model": "apple-foundation-3b"])
                }
            } catch {
                self?.notifyListeners("onDeviceError", data: ["requestId": requestId, "error": error.localizedDescription])
            }
            self?.setTask(nil, for: requestId)
        }
        setTask(task, for: requestId)
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
        lock.lock()
        let task = tasks.removeValue(forKey: requestId)
        lock.unlock()
        task?.cancel()
        call.resolve()
    }

    private func setTask(_ task: Task<Void, Never>?, for requestId: String) {
        lock.lock()
        defer { lock.unlock() }
        if let task = task {
            tasks[requestId] = task
        } else {
            tasks.removeValue(forKey: requestId)
        }
    }
}
