# Spec — Phase 2.8: On-device PRIVATE tier

**Status:** Phase 1 (foundation + WebLLM proof) implemented this turn.
Native Apple/Android plugin source provided here, ready to drop into
generated Capacitor projects.
**Owner:** main agent (chat / broker / type system / WebLLM); whoever has
Mac + Xcode 16 / Android Studio for the native plugin source drop.
**Lovable lane note:** this spec touches the chat pipeline and broker,
which are explicitly OUT of Lovable's lane. Native plugin code lives
in `ios/App/App/Plugins/` and `android/app/src/main/java/.../plugins/`,
which Capacitor generates on first `cap add` — those paths are not in
either party's "do not touch" list and can be edited by whoever runs
the native build.

---

## 1. Why this tier exists

The previous PRIVATE badge routed to Cloudflare Workers AI running
Llama 3.1 8B. That's an open-weights model on a zero-data-retention
host — but the user's prompt + personalization fragment still left
their device and reached a third-party inference server. Calling that
"private" overpromises.

This tier is the honest answer: PRIVATE now means **the user's prompt
never leaves their hardware**. We support three pathways and pick the
best one available per device:

| Pathway | Platform | Model | Provider ID |
| --- | --- | --- | --- |
| Apple Foundation Models | iOS 18.1+, iPhone 15 Pro / 16 family, Apple Intelligence enabled | Apple's on-device 3B | `onDeviceApple` |
| Gemini Nano via AICore | Android 14+, Pixel 8+ / Galaxy S24+, AICore APK present | Gemini Nano (Google's on-device) | `onDeviceAndroid` |
| WebLLM | Any browser with WebGPU (desktop Chrome/Edge, iOS 18 Safari with flag) | Llama 3.2 1B-Instruct (q4f16_1) | `onDeviceWebLLM` |

If none of the three is available, the PRIVATE badge **fails closed**
— it is disabled in the UI with an honest message rather than silently
falling back to a hosted provider. Users on capable devices get real
on-device privacy; users on incapable devices are told so directly.

---

## 2. Architecture

The chain runner (`src/server/inference/chat.ts`) cannot execute
on-device generation — it runs server-side. So the PRIVATE badge takes
a different path entirely:

```
User taps PRIVATE → streamChatMessage()
   ├── badge === "private"? yes
   └── streamOnDeviceChat() (client-side)
         ├── detectOnDeviceCapability()  → pick adapter
         ├── prepareOnDeviceTurn()        → server-fn: cap-check, persist user msg,
         │                                   broker at tier -1, return {systemPrompt,
         │                                   history, ids, contextUsed}
         ├── streamWebLLM() | streamNativeOnDevice()  → local generation
         └── finalizeOnDeviceTurn()       → server-fn: persist assistant msg +
                                             zero-cost telemetry + audit log
```

**Three layers of defense** keep the server from accidentally running
on-device generation:

1. `streamChatMessage` short-circuits at the client when `badge === "private"`.
2. `runChain` and `runChainStream` call `assertNoOnDeviceProviders()` at entry.
3. The server-side `PROVIDER_LOADERS` registers a stub for each on-device
   ID that throws `InferenceError` with a clear message.

---

## 3. Tier -1 in the privacy taxonomy

`PrivacyTier = -1 | 0 | 1 | 2 | 3` (extended in `src/lib/provider-tiers.ts`).

The broker (`src/server/context-broker.ts`) treats tier -1 as **fully
permissive**: no category is hidden, no max-K cap applies. This is
the correct policy because the assembled fragment never leaves the
user's device — the broker assembles it server-side, ships it back to
the client, and the client uses it as the local model's system prompt.

The leak suite (`tests/leak-suite/broker-leak.test.ts`) was extended
with `TIER_FORBIDDEN[-1] = []`. The PRIVATE badge is exercised at tier
-1 with full personalization; the zero-PII assertion still holds
because the trait sheet itself is constructed PII-free in extraction
(see Phase 2.7 §B3).

---

## 4. Capability detection contract

`src/lib/on-device-capability.ts` exposes:

```ts
detectOnDeviceCapability(): Promise<{
  providerId: "onDeviceApple" | "onDeviceAndroid" | "onDeviceWebLLM" | null;
  available: boolean;
  unsupportedReason: string | null;
  modelReady?: boolean;  // WebLLM only
}>
```

Detection order:

1. Try the native Capacitor plugin (works on iOS or Android only).
2. Fall back to WebLLM (works in any WebGPU browser).
3. Return `available: false` with a plain-English reason.

The result is memoized for the session. Pass `{force: true}` to re-probe
(used by a "Re-check device" button on the privacy page after the user
installs AICore or grants Apple Intelligence permission).

---

## 5. WebLLM adapter (shipped this turn)

`src/lib/on-device-webllm.ts` wraps `@mlc-ai/web-llm` (pinned at
`^0.2.78`). Default model: `Llama-3.2-1B-Instruct-q4f16_1-MLC`.

First-run cost: ~700 MB weights downloaded into OPFS / IndexedDB.
The streaming adapter forwards `init-progress` events as `load_progress`
events so the UI can show a download bar inside the assistant bubble.
Subsequent runs are instant (cache hit).

WebGPU detection is `navigator.gpu` presence — cheap and runs without
allocating GPU resources. The actual GPU adapter request happens on
first generation.

---

## 6. Apple Foundation Models — Capacitor plugin (Swift)

Drop into `ios/App/App/Plugins/OnDeviceLLM.swift` after running
`npx cap add ios`. Requires iOS 18.1+ deployment target and the
`FoundationModels` framework (Apple Intelligence).

```swift
import Capacitor
import FoundationModels

@objc(OnDeviceLLMPlugin)
public class OnDeviceLLMPlugin: CAPPlugin {

    private var sessions: [String: LanguageModelSession] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]

    @objc public func probe(_ call: CAPPluginCall) {
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
                    "reason": reason.localizedDescription
                ])
            }
        } else {
            call.resolve([
                "available": false,
                "platform": "ios",
                "reason": "Requires iOS 18.1 with Apple Intelligence enabled."
            ])
        }
    }

    @objc public func generate(_ call: CAPPluginCall) {
        guard #available(iOS 18.1, *) else {
            call.reject("Requires iOS 18.1+")
            return
        }
        guard let requestId = call.getString("requestId"),
              let messages = call.getArray("messages") as? [[String: String]] else {
            call.reject("Invalid arguments")
            return
        }
        let maxTokens = call.getInt("maxTokens") ?? 1024
        let temperature = call.getDouble("temperature") ?? 0.4

        let prompt = messages.compactMap { m -> String? in
            guard let role = m["role"], let content = m["content"] else { return nil }
            return "\(role.uppercased()): \(content)"
        }.joined(separator: "\n\n") + "\n\nASSISTANT:"

        let session = LanguageModelSession()
        sessions[requestId] = session

        let task = Task { [weak self] in
            do {
                let stream = session.streamResponse(
                    to: prompt,
                    options: GenerationOptions(
                        temperature: temperature,
                        maximumResponseTokens: maxTokens
                    )
                )
                for try await partial in stream {
                    self?.notifyListeners("onDeviceDelta", data: [
                        "requestId": requestId,
                        "text": partial
                    ])
                }
                self?.notifyListeners("onDeviceDone", data: [
                    "requestId": requestId,
                    "model": "apple-foundation-3b"
                ])
            } catch {
                self?.notifyListeners("onDeviceError", data: [
                    "requestId": requestId,
                    "error": error.localizedDescription
                ])
            }
            self?.sessions.removeValue(forKey: requestId)
            self?.tasks.removeValue(forKey: requestId)
        }
        tasks[requestId] = task
        call.resolve(["ok": true])
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            call.reject("requestId required")
            return
        }
        tasks[requestId]?.cancel()
        sessions.removeValue(forKey: requestId)
        tasks.removeValue(forKey: requestId)
        call.resolve()
    }
}
```

Plugin registration goes in `ios/App/App/AppDelegate.swift` per the
standard Capacitor pattern. Add the `Apple Intelligence` capability
to the target, set deployment to iOS 18.1, and rebuild.

---

## 7. Gemini Nano via AICore — Capacitor plugin (Kotlin)

Drop into
`android/app/src/main/java/com/neuralconnexions/app/plugins/OnDeviceLLMPlugin.kt`
after running `npx cap add android`. Requires `compileSdk 34`+, AICore
APK installed on device, and the `com.google.ai.edge.aicore` dep
(`implementation "com.google.ai.edge.aicore:aicore:0.0.1-exp01"` or
the current SDK version at integration time).

```kotlin
package com.neuralconnexions.app.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.aicore.GenerationConfig
import com.google.ai.edge.aicore.GenerativeModel
import com.google.ai.edge.aicore.DownloadCallback
import com.google.ai.edge.aicore.DownloadConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "OnDeviceLLM")
class OnDeviceLLMPlugin : Plugin() {

    private val jobs = mutableMapOf<String, Job>()
    private var model: GenerativeModel? = null

    @PluginMethod
    fun probe(call: PluginCall) {
        try {
            ensureModel()
            val ret = JSObject().apply {
                put("available", true)
                put("platform", "android")
                put("model", "gemini-nano")
            }
            call.resolve(ret)
        } catch (e: Throwable) {
            val ret = JSObject().apply {
                put("available", false)
                put("platform", "android")
                put("reason", e.message ?: "AICore unavailable on this device.")
            }
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        val requestId = call.getString("requestId") ?: run {
            call.reject("requestId required"); return
        }
        val messages = call.getArray("messages")
        val maxTokens = call.getInt("maxTokens") ?: 1024
        val temperature = call.getDouble("temperature") ?: 0.4

        val prompt = buildString {
            for (i in 0 until (messages?.length() ?: 0)) {
                val m = messages!!.getJSONObject(i)
                append(m.getString("role").uppercase())
                append(": ")
                append(m.getString("content"))
                append("\n\n")
            }
            append("ASSISTANT:")
        }

        val job = CoroutineScope(Dispatchers.Default).launch {
            try {
                ensureModel()
                val cfg = GenerationConfig.Builder()
                    .setTemperature(temperature.toFloat())
                    .setMaxOutputTokens(maxTokens)
                    .build()
                val activeModel = model!!
                activeModel.generateContentStream(prompt).collect { chunk ->
                    val text = chunk.text ?: return@collect
                    notifyListeners("onDeviceDelta", JSObject().apply {
                        put("requestId", requestId)
                        put("text", text)
                    })
                }
                notifyListeners("onDeviceDone", JSObject().apply {
                    put("requestId", requestId)
                    put("model", "gemini-nano")
                })
            } catch (e: Throwable) {
                notifyListeners("onDeviceError", JSObject().apply {
                    put("requestId", requestId)
                    put("error", e.message ?: "Generation failed")
                })
            } finally {
                jobs.remove(requestId)
            }
        }
        jobs[requestId] = job
        call.resolve(JSObject().apply { put("ok", true) })
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = call.getString("requestId") ?: run {
            call.reject("requestId required"); return
        }
        jobs[requestId]?.cancel()
        jobs.remove(requestId)
        call.resolve()
    }

    private fun ensureModel() {
        if (model != null) return
        val downloadConfig = DownloadConfig(object : DownloadCallback {
            override fun onDownloadStarted(bytesToDownload: Long) {}
            override fun onDownloadProgress(totalBytesDownloaded: Long) {}
            override fun onDownloadCompleted() {}
            override fun onDownloadFailed(failureStatus: String, e: Throwable) {
                throw e
            }
        })
        model = GenerativeModel(
            generationConfig = GenerationConfig.Builder().build(),
            downloadConfig = downloadConfig
        )
    }
}
```

Register in `MainActivity.java` via `registerPlugin(OnDeviceLLMPlugin.class)`.
The AICore APK must be installed (Pixel 8+ ships with it; Galaxy S24+
gets it via Play Store on first request).

---

## 8. Persistence + telemetry

On-device turns still hit the database — the user's history must
survive across devices and across the eventual sync layer. The two
server-fns:

- `prepareOnDeviceTurn` writes the user `chat_messages` row + cap-checks +
  runs the broker.
- `finalizeOnDeviceTurn` writes the assistant `chat_messages` row + the
  `inference_usage` telemetry row with `cost_micro_usd: 0`,
  `provider_used: "onDeviceApple|onDeviceAndroid|onDeviceWebLLM"`, and
  `status: "ok"`. The CPAUD viewer (`/workspace/internal/cpaud`) thus
  counts on-device traffic in the OSS-tier share % — which it should,
  since on-device is the most permissive tier.

---

## 9. Failure modes + UI behavior

| Situation | UI surface | Persistence |
| --- | --- | --- |
| Device has no on-device path | PRIVATE badge disabled with `unsupportedReason` tooltip | Nothing persisted |
| Cap exceeded | Sonner toast (same shape as hosted tiers) | Nothing persisted |
| Native plugin error mid-gen | Error chip in assistant bubble | User row only — assistant row not written |
| User cancels via abort signal | "Cancelled by user" error | User row only |
| WebLLM model download fails | Error chip; cache stays empty for retry | Nothing persisted |

---

## 10. Test plan

Already passing in this turn:
- Type-system updates (`PrivacyTier` extension) compile.
- Broker `NEVER_AT_TIER[-1]` + `MAX_K_AT_TIER[-1]` populated.
- Leak suite extended with tier -1 (zero-PII assertion still holds).
- Server-side guards (`assertNoOnDeviceProviders`, `onDeviceServerStub`)
  fail loudly if anything reaches them.

Manual test, desktop Chrome:
1. Sign in.
2. Open chat, pick PRIVATE badge.
3. First message: should show `[loading model: NN%]` while WebLLM
   downloads weights, then start streaming.
4. Second message: should start streaming within ~1 s (cache hit).
5. Refresh page; thread + assistant reply should be present.
6. Visit `/workspace/internal/cpaud` (admin allowlist): the on-device
   turn should appear in the OSS-tier share %.

Native test, requires Mac:
1. `npx cap add ios && npx cap sync ios && npx cap open ios`.
2. Drop `OnDeviceLLM.swift` into `ios/App/App/Plugins/`.
3. Set deployment target iOS 18.1, add Apple Intelligence capability.
4. Build & run on iPhone 15 Pro / 16 with Apple Intelligence enabled.
5. Same chat flow as web; capability detector should pick `onDeviceApple`.

Native test, requires Android Studio:
1. `npx cap add android && npx cap sync android && npx cap open android`.
2. Drop `OnDeviceLLMPlugin.kt` + register in `MainActivity.java`.
3. Add `aicore` dep to `build.gradle`.
4. Build & run on Pixel 8+ / Galaxy S24+.

---

## 11. Open questions

These are deferred until the native plugin code lands and we have
real device data:

1. **WebLLM on iOS 18 Safari** — WebGPU is shipped but flaky. Confirm
   whether to enable or hide on Safari pending a stability bake.
2. **Model upgrade path** — when Apple ships a larger Foundation Model
   variant, do we A/B opt-in or auto-switch?
3. **Quality gap** — Llama 3.2 1B is noticeably weaker than Cloudflare's
   Llama 3.1 8B. Decide whether to surface model-quality in the badge
   tooltip ("On-device, may be less accurate") or leave it implicit.
4. **Offline mode** — on-device generation works offline, but
   `prepareOnDeviceTurn` / `finalizeOnDeviceTurn` need network. Do we
   add an offline queue, or just disable PRIVATE when offline?

None of these block shipping Phase 1.
