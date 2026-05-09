#!/bin/bash
# Post-merge setup for NeuralConnexions.
#
# Runs after every task merge. Keep idempotent, non-interactive, fast.
#
# Notes:
# - Supabase migrations under supabase/migrations/ are applied manually via
#   the Supabase Dashboard SQL Editor (the bundled .local/phase27_apply.sql.txt
#   etc.). Direct psql connection is IPv6-only here, so we do NOT try to push
#   migrations from this script.
# - We only sync npm deps so any newly-added packages from the merged branch
#   are present before workflow reconciliation restarts the dev server.
set -euo pipefail

if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --prefer-offline
else
  npm install --no-audit --no-fund --prefer-offline
fi

# Reconcile Android native pieces this repo owns: MediaPipe gradle dep,
# noCompress tflite, MainActivity plugin registration, and the on-device
# NSFW model in APK assets. This is a no-op until `npx cap add android`
# has been run on a Mac and the generated `android/` project committed
# back. The script fails closed if the project IS generated but the
# model asset is missing, so we never silently ship an APK whose safety
# gate falls back to WebGPU on every device.
if [ -f scripts/setup-android-native.sh ]; then
  bash scripts/setup-android-native.sh
fi
