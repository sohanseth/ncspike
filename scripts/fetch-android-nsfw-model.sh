#!/usr/bin/env bash
#
# fetch-android-nsfw-model.sh
#
# Downloads the on-device NSFW image classifier .tflite model that the
# Android safety plugin (`NCImageSafetyMediaPipe`) loads from APK assets
# at `android/app/src/main/assets/nsfw_image_classifier.tflite`.
#
# Per docs/12 §15.4 the gate must work with NO network at runtime, so
# this fetch happens at build time on the Mac (or in CI) BEFORE
# `npx cap sync` / Android Studio packages the APK. The model is not
# committed to git (binary, license-encumbered, swappable).
#
# Idempotent:
#   - Re-running with the model already in place is a no-op (sha256 match).
#   - A stale / wrong-sha model is replaced.
#   - Missing env vars fail loudly — no silent fallback (per replit.md).
#
# Required env (export before running, or supply inline):
#   NSFW_MODEL_URL    — HTTPS url to a MediaPipe-compatible .tflite image
#                       classifier whose label set matches the
#                       UNSAFE_NEEDLES list in NCImageSafetyMediaPipe.kt
#                       (drawings, hentai, neutral, porn, sexy — i.e. the
#                       NSFWJS / GantMan taxonomy).
#   NSFW_MODEL_SHA256 — Expected lowercase hex sha256 of the file at
#                       NSFW_MODEL_URL. The script refuses to install a
#                       file whose digest does not match — protects
#                       against an upstream re-host swapping the bytes.
#
# Suggested source (verify license + MediaPipe metadata yourself before
# using in production): GantMan/nsfw_model TFLite release, INT8 ~5 MB.
# See: https://github.com/GantMan/nsfw_model/releases
#
# Usage:
#   NSFW_MODEL_URL="https://…/nsfw.tflite" \
#   NSFW_MODEL_SHA256="abc123…" \
#   bash scripts/fetch-android-nsfw-model.sh
set -euo pipefail

DEST_DIR="android/app/src/main/assets"
DEST_FILE="${DEST_DIR}/nsfw_image_classifier.tflite"

if [[ -z "${NSFW_MODEL_URL:-}" || -z "${NSFW_MODEL_SHA256:-}" ]]; then
  echo "fetch-android-nsfw-model: NSFW_MODEL_URL and NSFW_MODEL_SHA256 must both be set." >&2
  echo "  No silent fallback — refusing to ship an unverified model." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [[ -f "${DEST_FILE}" ]]; then
  existing="$(sha_of "${DEST_FILE}")"
  if [[ "${existing}" == "${NSFW_MODEL_SHA256}" ]]; then
    echo "fetch-android-nsfw-model: ${DEST_FILE} already up to date (sha256 match)."
    exit 0
  fi
  echo "fetch-android-nsfw-model: existing model has stale sha256 (${existing}); replacing."
  rm -f "${DEST_FILE}"
fi

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT

echo "fetch-android-nsfw-model: downloading ${NSFW_MODEL_URL}"
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --silent --show-error --output "${tmp}" "${NSFW_MODEL_URL}"
elif command -v wget >/dev/null 2>&1; then
  wget --quiet --output-document="${tmp}" "${NSFW_MODEL_URL}"
else
  echo "fetch-android-nsfw-model: neither curl nor wget is installed." >&2
  exit 1
fi

got="$(sha_of "${tmp}")"
if [[ "${got}" != "${NSFW_MODEL_SHA256}" ]]; then
  echo "fetch-android-nsfw-model: sha256 mismatch." >&2
  echo "  expected: ${NSFW_MODEL_SHA256}" >&2
  echo "  got:      ${got}" >&2
  echo "  Refusing to install — fail closed." >&2
  exit 1
fi

mv "${tmp}" "${DEST_FILE}"
echo "fetch-android-nsfw-model: installed ${DEST_FILE} (sha256 ${got})."
