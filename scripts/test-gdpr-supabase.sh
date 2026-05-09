#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run the GDPR delete_user_data() round-trip against a REAL Supabase project
# (staging clone) reached via $SUPABASE_STAGING_DB_URL.
#
# This is the Supabase-specific counterpart to scripts/test-gdpr-real-db.sh,
# which runs against an ephemeral local Postgres. The local script catches
# SQL syntax + idempotency regressions; this one additionally exercises:
#
#   * the real `auth.users` table, its trigger surface, and the
#     on_auth_user_created → public.profiles + public.user_settings cascade,
#   * RLS interaction with the service_role caller,
#   * extension availability (pgcrypto / uuid-ossp / etc.) on the actual
#     Supabase Postgres image,
#   * any FK cascade that differs between vanilla Postgres and Supabase.
#
# WARNING — DESTRUCTIVE. The vitest fixture wipes auth.users and every
# per-user public table in beforeEach(). This script MUST point at a
# dedicated staging-clone project, never at the production database.
# We refuse to run if the URL looks like production (see guards below) or
# if the operator did not opt in via I_UNDERSTAND_THIS_WIPES_DATA=yes.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${SUPABASE_STAGING_DB_URL:?SUPABASE_STAGING_DB_URL must be set to a dedicated staging-clone connection string}"
: "${I_UNDERSTAND_THIS_WIPES_DATA:?Refusing to run without I_UNDERSTAND_THIS_WIPES_DATA=yes — this test wipes auth.users}"

if [ "$I_UNDERSTAND_THIS_WIPES_DATA" != "yes" ]; then
  echo "[gdpr-supabase] FATAL: I_UNDERSTAND_THIS_WIPES_DATA must be exactly 'yes'" >&2
  exit 1
fi

# Heuristic safety net — refuse anything that looks like a production URL.
# This is belt-and-braces; the real defence is using a different secret name.
case "$SUPABASE_STAGING_DB_URL" in
  *prod*|*production*|*PROD*)
    echo "[gdpr-supabase] FATAL: refusing — URL contains 'prod'/'production'." >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql "$SUPABASE_STAGING_DB_URL" -v ON_ERROR_STOP=1 --quiet)

echo "[gdpr-supabase] applying $(ls "$ROOT/supabase/migrations/" | wc -l) migrations to staging clone"
# Migrations are required to be idempotent (see replit.md "User preferences"),
# so applying the full set on every CI run is safe and keeps the staging
# schema in lock-step with main.
for f in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -f "$f" >/dev/null
done

echo "[gdpr-supabase] verifying delete_user_data() exists with the latest signature"
EXPECTED_COLS="chat_messages_deleted chat_threads_deleted chat_context_log_deleted pii_scrub_events_deleted extraction_failures_deleted user_trait_blocks_deleted user_provider_category_blocks_del user_known_names_deleted user_traits_deleted memory_edges_deleted memory_nodes_deleted inference_usage_deleted inference_usage_daily_deleted user_settings_deleted"
ACTUAL_COLS="$("${PSQL[@]}" -tAc "
  select string_agg(p.proargnames[i], ' ' order by i)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral generate_subscripts(p.proargnames, 1) as i
  where n.nspname = 'public' and p.proname = 'delete_user_data'
    and p.proargmodes[i] = 't'")"
for col in $EXPECTED_COLS; do
  case " $ACTUAL_COLS " in
    *" $col "*) ;;
    *)
      echo "[gdpr-supabase] FATAL: delete_user_data() is missing return column \"$col\"" >&2
      echo "[gdpr-supabase]   actual return columns: $ACTUAL_COLS" >&2
      exit 1
      ;;
  esac
done

export GDPR_REAL_DB_URL="$SUPABASE_STAGING_DB_URL"

echo "[gdpr-supabase] running vitest (gdpr-roundtrip-realdb + cap-race-realdb) against staging Supabase"
cd "$ROOT"
# Both real-DB suites are gated on GDPR_REAL_DB_URL. Running them against the
# staging clone (in addition to the ephemeral cluster used by
# scripts/test-gdpr-real-db.sh) catches Supabase-specific drift in either
# delete_user_data() (per-table coverage) or the cap SQL trio
# (reserve_inference_slot / finalize_inference_usage / release_inference_slot)
# — e.g. a missing extension, an RLS policy that blocks service_role, or an
# advisory-lock collision with another Supabase-managed function.
exec npx vitest run \
  tests/leak-suite/gdpr-roundtrip-realdb.test.ts \
  tests/leak-suite/cap-race-realdb.test.ts \
  "$@"
