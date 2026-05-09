# Android app assets

Files dropped in this directory are packaged into the APK and reachable
from native code via `context.assets.open(...)`.

## `nsfw_image_classifier.tflite` (required for the safety gate)

The Android output-side NSFW gate
(`android/app/src/main/java/com/neuralconnexions/app/plugins/NCImageSafetyMediaPipe.kt`)
loads `nsfw_image_classifier.tflite` from this directory via
`BaseOptions.setModelAssetPath("nsfw_image_classifier.tflite")`. Without
the file in place, `isAvailable()` returns `false` and the JS bridge in
`src/lib/imagegen-safety.ts` falls back to the heavier WebGPU/WASM
classifier — which is allowed but slower and uses more battery.

The model file is **not committed to git** (it is a binary, may be
license-encumbered, and is swappable for retrained variants). It is
fetched at build time on the Mac that runs `npx cap sync`. Do this once
per checkout, before opening Android Studio:

```bash
NSFW_MODEL_URL="https://…/nsfw_image_classifier.tflite" \
NSFW_MODEL_SHA256="<expected-sha256>" \
bash scripts/setup-android-native.sh
```

`setup-android-native.sh` is the single entry point: it patches
`android/app/build.gradle` (MediaPipe dep + `noCompress "tflite"`),
registers the plugin in `MainActivity.java`, calls
`scripts/fetch-android-nsfw-model.sh` if the env vars above are set,
and **fails closed** if the gradle file is present but this asset is
missing — so a broken build aborts loudly instead of silently shipping
an APK whose safety gate falls back to WebGPU on every device.

`scripts/post-merge.sh` calls `setup-android-native.sh` automatically
on every merge, so once `npx cap add android` has been run on a Mac
and the generated `android/` project is committed, the gradle patches
re-apply themselves on every checkout. The fetch step still requires
the env vars to be set (no silent fallback per `replit.md`).

### What model to point at

The plugin's `UNSAFE_NEEDLES` list (`nsfw`, `porn`, `hentai`, `explicit`,
`nudity`, `sexy`, `adult`, `erotic`) matches the NSFWJS / GantMan label
taxonomy (`drawings`, `hentai`, `neutral`, `porn`, `sexy`). Any TFLite
image classifier with embedded MediaPipe-compatible metadata and a
similar label set will work. The current suggested source is the
`GantMan/nsfw_model` TFLite release (~5 MB INT8). Verify the license and
MediaPipe metadata before shipping.

If you swap to a retrained model with a different label set, update
`UNSAFE_NEEDLES` and the leak-suite fixtures together — the JS-side
threshold (`UNSAFE_THRESHOLD = 0.6`) and the Kotlin one must stay in
sync.

### Verifying the gate is selected on a real build

After installing the debug APK on a device:

1. Open the app, go to a chat that triggers an `image_out` turn.
2. Watch `adb logcat | grep -i mediapipe` while you generate an image.
   You should see MediaPipe init logs the first time `classify` runs.
3. Submit a known-bad fixture (the leak suite ships some under
   `tests/leak-suite/fixtures/`). The chat should show the blocked-image
   placeholder (docs/12 §15.4) with **no** outbound network request to
   any model provider during the classify step (verify with Charles or
   `adb shell tcpdump`).

If the WebGPU fallback is being selected instead, the most common cause
is that this asset file is missing — check
`adb shell run-as com.neuralconnexions.app ls /data/data/com.neuralconnexions.app/`
or unzip the APK and look under `assets/`.
