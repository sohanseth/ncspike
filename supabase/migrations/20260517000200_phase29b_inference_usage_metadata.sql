-- Phase 2.9b — `inference_usage.metadata` jsonb column.
--
-- Task #32 (docs/12 §15.4): when an on-device image generation is flagged
-- by the safety classifier we (a) write a placeholder assistant chat row
-- so the user can see what happened on a scroll-back, and (b) tag the
-- corresponding telemetry row with `{ image_blocked: true }` so dashboards
-- and the GDPR retention sweep can distinguish a blocked turn from a
-- normal `error` row. The placeholder is written via
-- `finalizeOnDeviceImageGenBlockedTurn` in src/lib/chat.functions.ts;
-- this migration only widens the schema.
--
-- Idempotent per replit.md migration policy:
--   * `to_regclass` guard so the column add is skipped on a DB where the
--     table was dropped (partial wipe / fresh re-init).
--   * `add column if not exists` so re-running on a DB that already has
--     the column is a no-op.
--   * No backfill needed — the default `'{}'::jsonb` covers existing rows
--     and `null` is a valid "no metadata" sentinel for older paths.
--
-- Does NOT touch:
--   * The `finalize_inference_usage` RPC signature — the blocked-turn
--     server-fn writes the metadata via a direct `update` against
--     `inference_usage` (gated on `user_id` + `status='error'`), so the
--     RPC contract stays stable for the hosted-tier callers.
--   * RLS on `inference_usage` (the existing "own usage select" policy
--     already gates by `user_id`; metadata is just another column under
--     the same access rules).

do $$
begin
  if to_regclass('public.inference_usage') is not null then
    alter table public.inference_usage
      add column if not exists metadata jsonb not null default '{}'::jsonb;
  end if;
end$$;
