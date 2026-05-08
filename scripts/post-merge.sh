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
