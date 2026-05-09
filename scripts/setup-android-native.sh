#!/usr/bin/env bash
#
# setup-android-native.sh
#
# Idempotent reconciliation of the Android native shell with the pieces
# this repo owns:
#
#   1. The MediaPipe tasks-vision dependency in `android/app/build.gradle`
#      (required by `NCImageSafetyMediaPipe.kt`).
#   2. `aaptOptions { noCompress "tflite" }` so MediaPipe can mmap the
#      classifier asset directly.
#   3. `registerPlugin(NCImageSafetyMediaPipe.class)` in
#      `android/app/src/main/java/com/neuralconnexions/app/MainActivity.java`.
#   4. An optional fetch of `nsfw_image_classifier.tflite` into APK assets
#      via `scripts/fetch-android-nsfw-model.sh` (only when
#      NSFW_MODEL_URL + NSFW_MODEL_SHA256 are set).
#   5. A fail-closed guard: if the gradle file is present (i.e. the
#      Android project has been generated) and the model asset is missing,
#      print a loud error and exit non-zero so a build doesn't silently
#      ship an inert APK whose safety gate falls back to WebGPU on every
#      device.
#
# This script is a no-op until `npx cap add android` has been run on a
# Mac and the generated `android/` project has been committed back; until
# then `android/app/build.gradle` and `MainActivity.java` don't exist and
# the script exits 0 cleanly. That is what lets `scripts/post-merge.sh`
# call this unconditionally.
#
# Re-running the script with everything already in place is a no-op
# (each patch checks before editing).
set -euo pipefail

GRADLE_FILE="android/app/build.gradle"
MAIN_ACTIVITY="android/app/src/main/java/com/neuralconnexions/app/MainActivity.java"
ASSET_DIR="android/app/src/main/assets"
ASSET_FILE="${ASSET_DIR}/nsfw_image_classifier.tflite"

MEDIAPIPE_DEP='implementation "com.google.mediapipe:tasks-vision:0.10.14"'
NO_COMPRESS_LINE='        noCompress "tflite"'

if [[ ! -f "${GRADLE_FILE}" ]]; then
  echo "setup-android-native: ${GRADLE_FILE} not present yet — skipping"
  echo "  (run \`npx cap add android\` on a Mac first; see docs/04-native-shell-runbook.md)"
  exit 0
fi

# ---- 1. MediaPipe dependency ---------------------------------------------
if grep -qF 'com.google.mediapipe:tasks-vision' "${GRADLE_FILE}"; then
  echo "setup-android-native: MediaPipe dep already present in ${GRADLE_FILE}"
else
  # Insert just before the closing brace of the LAST `dependencies {` block.
  python3 - "${GRADLE_FILE}" "${MEDIAPIPE_DEP}" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
dep = sys.argv[2]
src = path.read_text()
m = list(re.finditer(r'dependencies\s*\{', src))
if not m:
    sys.stderr.write("setup-android-native: no `dependencies {` block in build.gradle — refusing to patch blindly\n")
    sys.exit(2)
start = m[-1].end()
depth = 1
i = start
while i < len(src) and depth > 0:
    c = src[i]
    if c == '{': depth += 1
    elif c == '}': depth -= 1
    i += 1
close = i - 1
patched = src[:close] + f"    {dep}\n" + src[close:]
path.write_text(patched)
print(f"setup-android-native: inserted MediaPipe dep into {path}")
PY
fi

# ---- 2. aaptOptions noCompress "tflite" ----------------------------------
if grep -qE 'noCompress[[:space:]]+"tflite"' "${GRADLE_FILE}"; then
  echo "setup-android-native: aaptOptions noCompress \"tflite\" already present"
else
  python3 - "${GRADLE_FILE}" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
src = path.read_text()
m = re.search(r'(^|\n)(android\s*\{)', src)
if not m:
    sys.stderr.write("setup-android-native: no `android {` block in build.gradle — refusing to patch\n")
    sys.exit(2)
insert_at = m.end()
block = '\n    aaptOptions {\n        noCompress "tflite"\n    }\n'
patched = src[:insert_at] + block + src[insert_at:]
path.write_text(patched)
print(f"setup-android-native: inserted aaptOptions noCompress block into {path}")
PY
fi

# ---- 3. MainActivity registerPlugin --------------------------------------
if [[ -f "${MAIN_ACTIVITY}" ]]; then
  if grep -qF 'NCImageSafetyMediaPipe.class' "${MAIN_ACTIVITY}"; then
    echo "setup-android-native: MainActivity already registers NCImageSafetyMediaPipe"
  else
    python3 - "${MAIN_ACTIVITY}" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
src = path.read_text()

import_line = "import com.neuralconnexions.app.plugins.NCImageSafetyMediaPipe;"
if import_line not in src:
    # Add after the package line (Capacitor template puts package at top).
    src = re.sub(r'(package [^\n]*;\n)', r'\1\n' + import_line + '\n', src, count=1)

# Look for an existing onCreate; if found, inject registerPlugin BEFORE
# super.onCreate so the bridge knows about it on first init.
if 'registerPlugin(' in src:
    # add a new line near other registerPlugin calls
    src = re.sub(
        r'(registerPlugin\([^)]*\);\s*\n)',
        r'\1        registerPlugin(NCImageSafetyMediaPipe.class);\n',
        src, count=1,
    )
elif re.search(r'protected\s+void\s+onCreate\s*\([^)]*\)\s*\{', src):
    src = re.sub(
        r'(protected\s+void\s+onCreate\s*\([^)]*\)\s*\{\s*\n)',
        r'\1        registerPlugin(NCImageSafetyMediaPipe.class);\n',
        src, count=1,
    )
else:
    # The cap-add template ships a MainActivity with no body. Inject one.
    src = re.sub(
        r'(public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\n)',
        r'''\1    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NCImageSafetyMediaPipe.class);
        super.onCreate(savedInstanceState);
    }
''',
        src, count=1,
    )

path.write_text(src)
print(f"setup-android-native: registered NCImageSafetyMediaPipe in {path}")
PY
  fi
else
  echo "setup-android-native: ${MAIN_ACTIVITY} not present yet — skipping plugin registration"
fi

# ---- 4. Optional model fetch --------------------------------------------
mkdir -p "${ASSET_DIR}"
if [[ -n "${NSFW_MODEL_URL:-}" && -n "${NSFW_MODEL_SHA256:-}" ]]; then
  bash scripts/fetch-android-nsfw-model.sh
fi

# ---- 5. Asset presence + integrity check --------------------------------
#
# Two failure modes to guard against:
#   (a) APK is built without the model. Compile succeeds, isAvailable()
#       returns false on every device, JS bridge silently falls back to
#       WebGPU/WASM. Bad UX, but not a safety regression — the WebGPU
#       fallback still gates output. We WARN (loudly) here on every
#       merge so it's noticed, but we do NOT fail the dev workflow.
#       The Mac dev who is actually about to ship the APK is the one
#       who must re-run with NSFW_MODEL_URL/SHA set.
#   (b) Someone drops a file at the asset path that is not a valid
#       TFLite v3 model (wrong format, HTML error page, half a
#       download). MediaPipe will throw at classifier init, the JS
#       bridge will reject the call, and the user's image generation
#       turn will fail closed (per docs/12 §15.4). We FAIL here so the
#       broken artefact is caught at merge time, not at runtime on the
#       user's device.
if [[ ! -f "${ASSET_FILE}" ]]; then
  cat >&2 <<EOF

setup-android-native: WARNING — ${ASSET_FILE} is missing.

  The Android project is generated and the MediaPipe dep is wired in,
  but the on-device NSFW classifier model is not bundled. An APK built
  in this state will fall back to the WebGPU/WASM classifier on every
  Android device (slower, more battery; still safe, see
  src/lib/imagegen-safety.ts).

  Before shipping the APK, fetch a vetted model:

    NSFW_MODEL_URL="https://…/nsfw_image_classifier.tflite" \\
    NSFW_MODEL_SHA256="<expected-sha256>" \\
    bash scripts/setup-android-native.sh

  See android/app/src/main/assets/README.md for guidance on choosing
  one.

EOF
  echo "setup-android-native: OK (with model-missing warning)"
  exit 0
fi

# TFLite v3 magic: bytes 4..8 are "TFL3". Reject anything else (HTML
# error page, half a download, stub file, wrong format) so it's caught
# at merge time, not at runtime on the user's device.
magic=$(dd if="${ASSET_FILE}" bs=1 skip=4 count=4 status=none 2>/dev/null || true)
if [[ "${magic}" != "TFL3" ]]; then
  echo "setup-android-native: ERROR — ${ASSET_FILE} is not a valid TFLite v3 file (magic=${magic@Q})." >&2
  echo "  Refusing to ship a broken model artefact. Re-run scripts/fetch-android-nsfw-model.sh with the correct URL+sha256." >&2
  exit 1
fi

echo "setup-android-native: OK (model present, TFL3 magic verified)"
