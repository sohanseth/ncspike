//
//  NCImageSafetyVision.swift
//  NeuralConnexions — Phase 2.9b output-side safety gate (iOS native).
//
//  Bridged from `src/lib/imagegen-safety.ts` (`tryLoadNativeClassifier`).
//  See `docs/12-spec-image-gen-private.md` §15.4 for the locked NSFW
//  pipeline contract this plugin implements.
//
//  Contract (must match the JS bridge exactly):
//
//    isAvailable() -> { available: Bool }
//        Returns true on every iOS 13+ device (VNClassifyImageRequest
//        is OS-bundled and ships in the base Vision framework — no
//        download, no model file, no network). We still return false
//        on unsupported OS versions so the JS bridge can fall through
//        to the WebGPU/WASM classifier on those devices.
//
//    classify({ pngBase64, mime }) -> { nsfw: Bool, topLabel: String?, score: Number? }
//        Decodes the base64 PNG/JPEG/WebP bytes, runs
//        `VNClassifyImageRequest`, and maps Apple's scene-tag
//        observations to a single NSFW verdict. The JS bridge
//        normalizes the shape and treats any throw / reject as a
//        fail-CLOSED deny — we therefore call `call.reject(...)` on
//        any decode/classify failure rather than silently resolving
//        with `nsfw: false`.
//
//  Drop this file into `ios/App/App/Plugins/` after running
//  `npx cap add ios`. Register in `AppDelegate.swift` with the
//  standard Capacitor pattern, e.g.
//      bridge.registerPluginInstance(NCImageSafetyVision())
//  (or via `@objc(NCImageSafetyVision)` auto-discovery — Capacitor
//  picks up both forms.)
//

import Capacitor
import Vision
import UIKit

@objc(NCImageSafetyVision)
public class NCImageSafetyVision: CAPPlugin {

    // Substrings of Apple Vision scene-classification labels that we
    // treat as unsafe. Apple's label vocabulary is internal and not
    // perfectly documented; we match case-insensitively against the
    // same family of needles the JS side uses so a future Vision
    // label rename doesn't desync the gate. Tuned conservatively;
    // bumping is a deliberate change.
    private static let UNSAFE_NEEDLES: [String] = [
        "nsfw", "porn", "hentai", "explicit", "nudity", "sexy",
        "adult", "erotic"
    ]

    // Confidence floor for a single label to flag the image. Mirrors
    // `UNSAFE_THRESHOLD` in `imagegen-safety.ts`. Vision returns
    // confidences in [0, 1].
    private static let UNSAFE_THRESHOLD: Float = 0.6

    @objc public func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 13.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc public func classify(_ call: CAPPluginCall) {
        guard #available(iOS 13.0, *) else {
            call.reject("VNClassifyImageRequest requires iOS 13+")
            return
        }
        guard let pngBase64 = call.getString("pngBase64") else {
            call.reject("Missing 'pngBase64'")
            return
        }
        guard let bytes = Data(base64Encoded: pngBase64, options: .ignoreUnknownCharacters) else {
            call.reject("Invalid base64 payload")
            return
        }
        guard let image = UIImage(data: bytes), let cgImage = image.cgImage else {
            call.reject("Could not decode image bytes into a CGImage")
            return
        }

        let request = VNClassifyImageRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

        // Run on a background queue — Vision is CPU/Neural-Engine
        // heavy and we don't want to block the WebView's main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                call.reject("Vision classify failed: \(error.localizedDescription)")
                return
            }
            guard let observations = request.results as? [VNClassificationObservation] else {
                call.reject("Vision returned no observations")
                return
            }

            var topLabel: String? = nil
            var topScore: Float = 0
            var flagged = false

            for obs in observations {
                if obs.confidence > topScore {
                    topScore = obs.confidence
                    topLabel = obs.identifier
                }
                if obs.confidence >= NCImageSafetyVision.UNSAFE_THRESHOLD {
                    let lower = obs.identifier.lowercased()
                    for needle in NCImageSafetyVision.UNSAFE_NEEDLES {
                        if lower.contains(needle) {
                            flagged = true
                            break
                        }
                    }
                }
            }

            var ret: [String: Any] = ["nsfw": flagged]
            if let label = topLabel { ret["topLabel"] = label }
            if topScore > 0 { ret["score"] = Double(topScore) }
            call.resolve(ret)
        }
    }
}
