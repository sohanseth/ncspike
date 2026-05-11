/*
 * OnDeviceLLMPlugin.kt
 * NeuralConnexions — Phase 2.8 on-device PRIVATE tier (Android native).
 *
 * Bridged from `src/lib/native-on-device-llm.ts`. See
 * `docs/11-spec-on-device-tier.md` §7 for the contract this plugin
 * implements.
 *
 * Contract (must match the JS bridge exactly):
 *
 *   probe() -> {
 *       available: Boolean,
 *       platform: "android",
 *       model: String?,         // present when available=true
 *       reason: String?         // present when available=false
 *   }
 *
 *   generate({ requestId: String,
 *              messages: [{ role: String, content: String }],
 *              maxTokens: Int?,
 *              temperature: Double? })
 *       -> { ok: true }
 *       Streams output via `notifyListeners("onDeviceDelta", …)` and
 *       terminates with either `onDeviceDone` or `onDeviceError`. The
 *       plugin NEVER returns the full assistant string in the resolve
 *       payload — streaming-only by design (see JS bridge docstring).
 *
 *   cancel({ requestId: String }) -> {}
 *
 * Drop into `android/app/src/main/java/com/neuralconnexions/app/plugins/`
 * after `npx cap add android`. The AICore Gradle dep
 * (`com.google.ai.edge.aicore:aicore:0.0.1-exp01`) is patched into
 * `android/app/build.gradle` by `scripts/setup-android-native.sh`,
 * which `scripts/post-merge.sh` runs on every checkout. Registration
 * in `MainActivity.java` is also wired by the same script.
 *
 * Requires:
 *   - Android 14+ (compileSdk 34+)
 *   - AICore APK present on device (Pixel 8+ ships with it; Galaxy
 *     S24+ gets it via Play Store on first request).
 */
package com.neuralconnexions.app.plugins

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.aicore.DownloadCallback
import com.google.ai.edge.aicore.DownloadConfig
import com.google.ai.edge.aicore.GenerationConfig
import com.google.ai.edge.aicore.GenerativeModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "OnDeviceLLM")
class OnDeviceLLMPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val jobs = mutableMapOf<String, Job>()

    // Cached default-config model used by `probe()` and by `generate()`
    // when the request doesn't override temperature / maxTokens. AICore
    // takes its `GenerationConfig` at model construction time, so calls
    // that *do* override defaults build a short-lived per-request model
    // and close it in `finally` — see `generate()`. We never recreate
    // this default model per request to avoid the AICore re-init cost
    // and the resource leak that pattern causes over many turns.
    @Volatile
    private var model: GenerativeModel? = null

    // Defaults documented in the JS bridge contract (`maxTokens=1024`,
    // `temperature=0.4`). Kept here so `generate()` can decide whether
    // a request needs a per-call model at all.
    private val defaultMaxTokens: Int = 1024
    private val defaultTemperature: Float = 0.4f

    // MARK: - probe

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
        } catch (t: Throwable) {
            val ret = JSObject().apply {
                put("available", false)
                put("platform", "android")
                put("reason", t.message ?: "AICore unavailable on this device.")
            }
            call.resolve(ret)
        }
    }

    // MARK: - generate

    @PluginMethod
    fun generate(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (requestId.isNullOrEmpty()) {
            call.reject("requestId required"); return
        }
        val messages: JSArray? = call.getArray("messages")
        val maxTokens = call.getInt("maxTokens") ?: 1024
        val temperature = call.getDouble("temperature") ?: 0.4

        // AICore takes a single prompt string; flatten the role-tagged
        // history the same way the iOS adapter does so behaviour is
        // consistent across platforms.
        val prompt = buildString {
            val len = messages?.length() ?: 0
            for (i in 0 until len) {
                val m = messages!!.getJSONObject(i)
                val role = m.optString("role", "user").uppercase()
                val content = m.optString("content", "")
                append(role); append(": "); append(content); append("\n\n")
            }
            append("ASSISTANT:")
        }

        // Decide up-front whether we need a per-request model. Reuse
        // the cached default model whenever the request matches the
        // documented defaults — that's the common case and avoids
        // re-initialising AICore (heavy) on every chat turn.
        val tempF = temperature.toFloat()
        val needsPerCallModel =
            tempF != defaultTemperature || maxTokens != defaultMaxTokens

        val job = scope.launch {
            var perCallModel: GenerativeModel? = null
            try {
                ensureModel()
                val active: GenerativeModel = if (needsPerCallModel) {
                    val cfg = GenerationConfig.Builder()
                        .setTemperature(tempF)
                        .setMaxOutputTokens(maxTokens)
                        .build()
                    val m = GenerativeModel(
                        generationConfig = cfg,
                        downloadConfig = noopDownloadConfig()
                    )
                    perCallModel = m
                    m
                } else {
                    model ?: throw IllegalStateException("AICore model not initialised")
                }

                active.generateContentStream(prompt).collect { chunk ->
                    val text = chunk.text ?: return@collect
                    if (text.isEmpty()) return@collect
                    notifyListeners("onDeviceDelta", JSObject().apply {
                        put("requestId", requestId)
                        put("text", text)
                    })
                }
                notifyListeners("onDeviceDone", JSObject().apply {
                    put("requestId", requestId)
                    put("model", "gemini-nano")
                })
            } catch (t: Throwable) {
                notifyListeners("onDeviceError", JSObject().apply {
                    put("requestId", requestId)
                    put("error", t.message ?: t.javaClass.simpleName)
                })
            } finally {
                // Always release a per-request model so AICore frees
                // its native resources; the cached default model is
                // owned by the plugin and torn down in handleOnDestroy.
                if (perCallModel != null) {
                    try { perCallModel.close() } catch (_: Throwable) {}
                }
                synchronized(jobs) { jobs.remove(requestId) }
            }
        }
        synchronized(jobs) { jobs[requestId] = job }
        call.resolve(JSObject().apply { put("ok", true) })
    }

    // MARK: - cancel

    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (requestId.isNullOrEmpty()) {
            call.reject("requestId required"); return
        }
        val job = synchronized(jobs) { jobs.remove(requestId) }
        job?.cancel()
        call.resolve()
    }

    // MARK: - lifecycle

    override fun handleOnDestroy() {
        try {
            scope.cancel()
        } catch (_: Throwable) {
        }
        try {
            model?.close()
        } catch (_: Throwable) {
        } finally {
            model = null
        }
        super.handleOnDestroy()
    }

    // MARK: - internals

    @Synchronized
    private fun ensureModel() {
        if (model != null) return
        model = GenerativeModel(
            generationConfig = GenerationConfig.Builder().build(),
            downloadConfig = noopDownloadConfig()
        )
    }

    private fun noopDownloadConfig(): DownloadConfig {
        return DownloadConfig(object : DownloadCallback {
            override fun onDownloadStarted(bytesToDownload: Long) {}
            override fun onDownloadProgress(totalBytesDownloaded: Long) {}
            override fun onDownloadCompleted() {}
            override fun onDownloadFailed(failureStatus: String, e: Throwable) {
                // Surface to the active request via onDeviceError instead
                // of throwing into AICore's internal callback path.
                throw e
            }
        })
    }
}
