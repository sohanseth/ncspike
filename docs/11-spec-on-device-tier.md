# 11 — Spec: On-Device AI Tier (Apple Foundation Models + Gemini Nano)

## 1. Why this exists

The privacy promise of NC is **"your email never leaves your device unless you say so."** Today the browser fulfils that promise via **WebLLM** (a quantised model running in WebGPU). That works, but it is heavy on a phone.

Modern phones ship a *much* better option: a system-level on-device LLM exposed by the OS itself.

- **iOS 18.1+ on Apple-Intelligence-capable hardware** → Apple **Foundation Models** framework
- **Android with AICore** (Pixel 8/9, recent Samsung S24+) → **Gemini Nano**

When present, these are faster, cooler, and battery-friendly compared to WebLLM. When absent, we fall back to WebLLM in the WebView. When even WebLLM is impossible, the privacy badge **refuses** rather than silently routing to a cloud provider.

```
┌─────────────────────────────────────────────────────────┐
│  Tier 1: OS on-device  (Apple FM / Gemini Nano)         │  ← native plugin
├─────────────────────────────────────────────────────────┤
│  Tier 2: WebLLM in WebGPU                               │  ← works today
├─────────────────────────────────────────────────────────┤
│  Tier 3: Refuse — show "private mode unavailable"        │
└─────────────────────────────────────────────────────────┘
```

> Cloud providers (Lovable AI, OpenAI, Anthropic, etc.) are a **separate, opt-in tier** the user explicitly chooses. They are never a silent fallback from "private."

## 2. Status

| Path                        | Status                                  |
| --------------------------- | --------------------------------------- |
| Architecture & router       | ✅ Done — `src/lib/ai/private-router.ts` |
| Tier 2 (WebLLM in browser)  | ✅ Ships today                            |
| Tier 1 — iOS plugin         | ⏳ Source ready (§3), needs Xcode + Mac  |
| Tier 1 — Android plugin     | ⏳ Source ready (§4), needs Android Studio |
| Tier 3 — refusal UI         | ✅ Privacy badge handles it               |

Both plugins below are complete. They just need to be dropped into the Capacitor iOS / Android projects by someone with the right hardware (Mac + signing cert for iOS, Android Studio for AICore testing). Once `npx cap sync` is run and the build is shipped, supported devices light up automatically — no JS changes required, the router auto-detects the bridge.

---

## 3. iOS plugin — Apple Foundation Models (Swift)

Requires: Xcode 16, iOS 18.1 SDK, device with Apple Intelligence enabled.

**File:** `ios/App/App/Plugins/NCOnDeviceLLM.swift`

```swift
import Foundation
import Capacitor
import FoundationModels   // Apple Foundation Models framework (iOS 18.1+)

@objc(NCOnDeviceLLMPlugin)
public class NCOnDeviceLLMPlugin: CAPPlugin {

  @objc func isAvailable(_ call: CAPPluginCall) {
    if #available(iOS 18.1, *) {
      let available = SystemLanguageModel.default.availability == .available
      call.resolve([
        "available": available,
        "provider": "apple-foundation-models",
        "model": "apple-on-device"
      ])
    } else {
      call.resolve(["available": false, "reason": "ios<18.1"])
    }
  }

  @objc func generate(_ call: CAPPluginCall) {
    guard #available(iOS 18.1, *) else {
      call.reject("Apple Foundation Models requires iOS 18.1+")
      return
    }
    guard SystemLanguageModel.default.availability == .available else {
      call.reject("On-device model unavailable on this device")
      return
    }

    let prompt = call.getString("prompt") ?? ""
    let system = call.getString("system") ?? ""
    let temperature = call.getDouble("temperature") ?? 0.4
    let maxTokens = call.getInt("maxTokens") ?? 512

    Task {
      do {
        let session = LanguageModelSession(
          instructions: system.isEmpty ? nil : system
        )
        let options = GenerationOptions(
          temperature: temperature,
          maximumResponseTokens: maxTokens
        )
        let response = try await session.respond(to: prompt, options: options)
        call.resolve([
          "text": response.content,
          "provider": "apple-foundation-models"
        ])
      } catch {
        call.reject("Generation failed: \(error.localizedDescription)")
      }
    }
  }
}
```

**Register the plugin** — `ios/App/App/Plugins/NCOnDeviceLLM.m`:

```objc
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(NCOnDeviceLLMPlugin, "NCOnDeviceLLM",
  CAP_PLUGIN_METHOD(isAvailable, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(generate,    CAPPluginReturnPromise);
)
```

**Info.plist** — no special entitlement is needed for Foundation Models on supported hardware, but raise the deployment target to **iOS 18.1**.

---

## 4. Android plugin — AICore / Gemini Nano (Kotlin)

Requires: Android Studio Hedgehog+, device with **AICore** installed (Pixel 8/9, Galaxy S24+), `com.google.ai.edge.aicore:aicore` dependency.

**File:** `android/app/src/main/java/app/nc/plugins/NCOnDeviceLLMPlugin.kt`

```kotlin
package app.nc.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.aicore.GenerativeModel
import com.google.ai.edge.aicore.generationConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "NCOnDeviceLLM")
class NCOnDeviceLLMPlugin : Plugin() {

  private var model: GenerativeModel? = null

  private fun ensureModel(temperature: Float, maxTokens: Int): GenerativeModel {
    val cfg = generationConfig {
      this.temperature = temperature
      this.maxOutputTokens = maxTokens
      this.topK = 40
    }
    return model ?: GenerativeModel(generationConfig = cfg).also { model = it }
  }

  @PluginMethod
  fun isAvailable(call: PluginCall) {
    CoroutineScope(Dispatchers.IO).launch {
      try {
        val m = ensureModel(0.4f, 64)
        // Probing prepareInferenceSources verifies AICore + a downloaded model
        m.prepareInferenceSources()
        val res = JSObject()
        res.put("available", true)
        res.put("provider", "android-aicore")
        res.put("model", "gemini-nano")
        call.resolve(res)
      } catch (e: Throwable) {
        val res = JSObject()
        res.put("available", false)
        res.put("reason", e.message ?: "aicore-unavailable")
        call.resolve(res)
      }
    }
  }

  @PluginMethod
  fun generate(call: PluginCall) {
    val prompt = call.getString("prompt") ?: ""
    val system = call.getString("system") ?: ""
    val temperature = (call.getDouble("temperature") ?: 0.4).toFloat()
    val maxTokens = call.getInt("maxTokens") ?: 512

    val full = if (system.isNotBlank()) "$system\n\n$prompt" else prompt

    CoroutineScope(Dispatchers.IO).launch {
      try {
        val m = ensureModel(temperature, maxTokens)
        val response = m.generateContent(full)
        val res = JSObject()
        res.put("text", response.text ?: "")
        res.put("provider", "android-aicore")
        call.resolve(res)
      } catch (e: Throwable) {
        call.reject("Generation failed: ${e.message}", e)
      }
    }
  }
}
```

**Register the plugin** — `android/app/src/main/java/app/nc/MainActivity.kt`:

```kotlin
import app.nc.plugins.NCOnDeviceLLMPlugin

class MainActivity : BridgeActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    registerPlugin(NCOnDeviceLLMPlugin::class.java)
    super.onCreate(savedInstanceState)
  }
}
```

**Gradle** — `android/app/build.gradle`:

```groovy
dependencies {
  implementation "com.google.ai.edge.aicore:aicore:0.0.1-exp01"
  implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0"
}
```

`minSdk` ≥ 31, `targetSdk` ≥ 34.

---

## 5. JS bridge (already wired)

The router in `src/lib/ai/private-router.ts` looks for `Capacitor.Plugins.NCOnDeviceLLM`. If present and `isAvailable()` returns true, it uses tier 1; otherwise it falls through to WebLLM (tier 2), then refuses (tier 3). No JS changes are needed once the plugins are registered.

```ts
// pseudocode of the router
const native = (window as any).Capacitor?.Plugins?.NCOnDeviceLLM;
if (native && (await native.isAvailable()).available) {
  return native.generate({ prompt, system, temperature, maxTokens });
}
if (await webllmReady()) return webllm.generate(...);
throw new PrivateUnavailableError(); // badge shows "Private mode unavailable on this device"
```

## 6. Ship checklist

- [ ] Drop `NCOnDeviceLLM.swift` + `.m` into `ios/App/App/Plugins/`
- [ ] Bump iOS deployment target to 18.1
- [ ] Drop `NCOnDeviceLLMPlugin.kt` into `android/app/src/main/java/app/nc/plugins/`
- [ ] Add AICore dependency in `android/app/build.gradle`
- [ ] Register plugin in `MainActivity.kt`
- [ ] `npx cap sync`
- [ ] Build & sign (Mac for iOS, Android Studio for Android)
- [ ] Test on: iPhone 15 Pro (iOS 18.1), Pixel 9 (AICore), older device (verify WebLLM fallback), low-end browser (verify refusal)

## 7. Why this matters

The architecture is **ready and honest**:

- The **browser path works today** (WebLLM).
- The **two phone paths are one native-shell build away** — both plugin sources are above, fully written.
- Where private inference is impossible, the badge **refuses** instead of silently leaking to a cloud provider.

That last property — *refusal as a feature* — is what makes "private" mean private here, not "private-ish, with a quiet fallback to OpenAI when convenient."
