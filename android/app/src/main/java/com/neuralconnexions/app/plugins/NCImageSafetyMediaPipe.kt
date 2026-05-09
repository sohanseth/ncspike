/*
 * NCImageSafetyMediaPipe.kt
 * NeuralConnexions — Phase 2.9b output-side safety gate (Android native).
 *
 * Bridged from `src/lib/imagegen-safety.ts` (`tryLoadNativeClassifier`).
 * See `docs/12-spec-image-gen-private.md` §15.4 for the locked NSFW
 * pipeline contract this plugin implements.
 *
 * Contract (must match the JS bridge exactly):
 *
 *   isAvailable() -> { available: Boolean }
 *       True iff the bundled MediaPipe Image Classifier `.tflite`
 *       model is present in the APK assets at
 *       `assets/nsfw_image_classifier.tflite`. The model is shipped
 *       in the APK so the gate works WITHOUT a download (per task
 *       acceptance: "a flagged image is denied without a model
 *       download").
 *
 *   classify({ pngBase64, mime }) -> { nsfw: Boolean, topLabel: String?, score: Number? }
 *       Decodes the base64 image bytes, runs the MediaPipe Image
 *       Classifier task on-device, and maps the top categories to a
 *       single NSFW verdict. Any decode / inference failure rejects
 *       the call so the JS bridge fail-CLOSES the user's turn.
 *
 * Drop this file into
 * `android/app/src/main/java/com/neuralconnexions/app/plugins/`
 * after running `npx cap add android`. Register in `MainActivity.java`
 * via `registerPlugin(NCImageSafetyMediaPipe.class)`. The MediaPipe
 * dependency must be added to `app/build.gradle`:
 *
 *     implementation "com.google.mediapipe:tasks-vision:0.10.14"
 *
 * The `nsfw_image_classifier.tflite` model file (Google's MediaPipe
 * model zoo NSFW classifier, ~5 MB INT8) must be placed in
 * `app/src/main/assets/` so it's packaged into the APK.
 */
package com.neuralconnexions.app.plugins

import android.graphics.BitmapFactory
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.imageclassifier.ImageClassifier
import com.google.mediapipe.tasks.vision.imageclassifier.ImageClassifier.ImageClassifierOptions
import java.io.IOException
import java.util.Base64

@CapacitorPlugin(name = "NCImageSafetyMediaPipe")
class NCImageSafetyMediaPipe : Plugin() {

    companion object {
        // Bundled in `app/src/main/assets/`. MediaPipe's BaseOptions
        // accepts an asset-relative path via `setModelAssetPath`.
        private const val MODEL_ASSET_PATH = "nsfw_image_classifier.tflite"

        // Substrings of MediaPipe category labels treated as unsafe.
        // The MediaPipe NSFW image classifier labels are
        // {drawings, hentai, neutral, porn, sexy} (NSFWJS-derived
        // taxonomy), so we match the same family of needles as the
        // JS bridge for forward compatibility with retrained variants.
        private val UNSAFE_NEEDLES = listOf(
            "nsfw", "porn", "hentai", "explicit", "nudity", "sexy",
            "adult", "erotic"
        )

        // Mirror of `UNSAFE_THRESHOLD` in `imagegen-safety.ts`.
        private const val UNSAFE_THRESHOLD = 0.6f

        // Top-K — read enough categories to confidently see whether
        // any unsafe label crossed the threshold.
        private const val MAX_RESULTS = 5
    }

    @Volatile private var classifier: ImageClassifier? = null

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val ret = JSObject()
        ret.put("available", modelAssetExists())
        call.resolve(ret)
    }

    @PluginMethod
    fun classify(call: PluginCall) {
        val pngBase64 = call.getString("pngBase64")
        if (pngBase64.isNullOrEmpty()) {
            call.reject("Missing 'pngBase64'"); return
        }
        if (!modelAssetExists()) {
            call.reject("NSFW classifier model not bundled in assets"); return
        }

        val bytes = try {
            Base64.getDecoder().decode(pngBase64)
        } catch (t: Throwable) {
            call.reject("Invalid base64 payload"); return
        }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: run {
                call.reject("Could not decode image bytes into a Bitmap"); return
            }

        try {
            val active = ensureClassifier()
            val mpImage = BitmapImageBuilder(bitmap).build()
            val result = active.classify(mpImage)

            var topLabel: String? = null
            var topScore: Float = 0f
            var flagged = false

            val classifications = result.classificationResult().classifications()
            for (c in classifications) {
                for (cat in c.categories()) {
                    val label = cat.categoryName() ?: continue
                    val score = cat.score()
                    if (score > topScore) {
                        topScore = score
                        topLabel = label
                    }
                    if (score >= UNSAFE_THRESHOLD) {
                        val lower = label.lowercase()
                        if (UNSAFE_NEEDLES.any { lower.contains(it) }) {
                            flagged = true
                        }
                    }
                }
            }

            val ret = JSObject().apply {
                put("nsfw", flagged)
                topLabel?.let { put("topLabel", it) }
                if (topScore > 0f) put("score", topScore.toDouble())
            }
            call.resolve(ret)
        } catch (t: Throwable) {
            call.reject("MediaPipe classify failed: ${t.message ?: t.javaClass.simpleName}")
        } finally {
            // Bitmap is now safe to release; the MediaPipe Image holds
            // its own copy internally for the duration of `classify`.
            if (!bitmap.isRecycled) bitmap.recycle()
        }
    }

    @Synchronized
    private fun ensureClassifier(): ImageClassifier {
        classifier?.let { return it }
        val baseOptions = BaseOptions.builder()
            .setModelAssetPath(MODEL_ASSET_PATH)
            .build()
        val options = ImageClassifierOptions.builder()
            .setBaseOptions(baseOptions)
            .setMaxResults(MAX_RESULTS)
            .setScoreThreshold(0f) // we apply our own threshold above
            .build()
        val created = ImageClassifier.createFromOptions(context, options)
        classifier = created
        return created
    }

    private fun modelAssetExists(): Boolean {
        return try {
            context.assets.open(MODEL_ASSET_PATH).use { true }
        } catch (e: IOException) {
            false
        }
    }

    override fun handleOnDestroy() {
        try {
            classifier?.close()
        } catch (_: Throwable) {
            // Best-effort cleanup on plugin teardown.
        } finally {
            classifier = null
        }
        super.handleOnDestroy()
    }
}
