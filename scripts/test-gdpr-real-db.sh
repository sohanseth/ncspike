#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Spin up an ephemeral local Postgres, apply every supabase/migrations/*.sql
# (after seeding the auth-schema shim), point the GDPR real-DB regression at
# it, and tear the cluster down on exit.
#
# Used by:
#   - .github/workflows/gdpr-real-db.yml (CI)
#   - local development (`bun run test:gdpr:realdb`)
#
# Requirements: `initdb`, `pg_ctl`, `psql` on PATH (PostgreSQL 14+).
# In CI we install the postgresql-client + server packages; on Replit they
# come from the Nix runtime path.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGDATA="$(mktemp -d -t nc-gdpr-pg-XXXXXX)"
SOCKDIR="$(mktemp -d -t nc-gdpr-sock-XXXXXX)"
LOG="$PGDATA/postgres.log"
DBNAME="gdpr_test"

cleanup() {
  set +e
  if [ -f "$PGDATA/postmaster.pid" ]; then
    pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  fi
  rm -rf "$PGDATA" "$SOCKDIR"
}
trap cleanup EXIT

echo "[gdpr-real-db] initdb in $PGDATA"
initdb -D "$PGDATA" -U postgres -A trust --no-locale --encoding=UTF8 >/dev/null

echo "[gdpr-real-db] starting postgres on unix socket $SOCKDIR"
pg_ctl -D "$PGDATA" -l "$LOG" \
  -o "-c listen_addresses='' -c unix_socket_directories='$SOCKDIR' -c fsync=off -c synchronous_commit=off" \
  start >/dev/null

# Wait for ready (initdb defaults to a fast start, but be safe).
for i in 1 2 3 4 5 6 7 8 9 10; do
  if psql -h "$SOCKDIR" -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

psql -h "$SOCKDIR" -U postgres -d postgres -c "create database $DBNAME" >/dev/null

PSQL=(psql -h "$SOCKDIR" -U postgres -d "$DBNAME" -v ON_ERROR_STOP=1 --quiet)

echo "[gdpr-real-db] applying auth-schema shim"
"${PSQL[@]}" -f "$ROOT/tests/leak-suite/fixtures/auth-shim.sql"

echo "[gdpr-real-db] applying storage-schema shim"
"${PSQL[@]}" -f "$ROOT/tests/leak-suite/fixtures/storage-shim.sql"

echo "[gdpr-real-db] applying $(ls "$ROOT/supabase/migrations/" | wc -l) migrations under ON_ERROR_STOP=1"
# Migrations are applied with strict ON_ERROR_STOP so a real regression in
# delete_user_data() or any per-user table fails loudly. Migrations are
# expected to be idempotent on a fresh database (tables/indexes use
# `if not exists`, duplicate policies are guarded by `drop policy if exists`).
for f in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -f "$f" >/dev/null
done

echo "[gdpr-real-db] verifying delete_user_data() exists with the latest signature"
# Sanity beyond "the function name resolves": confirm every column the TS
# code expects in RPC_COLUMN_TO_TABLE is actually in the function's return
# table. If a future migration drops a column, this trips before the test
# even seeds anything.
EXPECTED_COLS="chat_messages_deleted chat_threads_deleted chat_context_log_deleted pii_scrub_events_deleted extraction_failures_deleted user_trait_blocks_deleted user_provider_category_blocks_del user_known_names_deleted user_traits_deleted memory_edges_deleted memory_nodes_deleted inference_usage_deleted inference_usage_daily_deleted user_settings_deleted relay_cards_deleted relay_devices_deleted relay_pairing_codes_deleted"
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
      echo "[gdpr-real-db] FATAL: delete_user_data() is missing return column \"$col\"" >&2
      echo "[gdpr-real-db]   actual return columns: $ACTUAL_COLS" >&2
      exit 1
      ;;
  esac
done

# Build a libpq URL that uses the unix socket. host= encoded as the path.
ENC_SOCK="$(printf '%s' "$SOCKDIR" | sed 's|/|%2F|g')"
export GDPR_REAL_DB_URL="postgresql://postgres@/$DBNAME?host=$ENC_SOCK"

echo "[gdpr-real-db] running vitest (gdpr-roundtrip-realdb + cap-race-realdb)"
cd "$ROOT"
# Both real-DB suites are gated on GDPR_REAL_DB_URL and share the same
# ephemeral cluster: gdpr-roundtrip-realdb pins delete_user_data() per-table
# coverage (task #11), cap-race-realdb pins the SQL trio that backs the
# per-day cap (task #15: reserve_inference_slot / finalize_inference_usage /
# release_inference_slot). Running them in the same vitest invocation keeps
# the cluster spin-up cost amortized across both.
exec npx vitest run \
  tests/leak-suite/gdpr-roundtrip-realdb.test.ts \
  tests/leak-suite/cap-race-realdb.test.ts \
  "$@"
