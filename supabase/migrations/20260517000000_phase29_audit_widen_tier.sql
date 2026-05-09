-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2.7-bis hardening — widen chat_context_log.strictest_tier to allow -1.
--
-- The original migration (20260513000000_phase27_traits.sql) constrained
-- strictest_tier to `between 0 and 3`. Phase 2.8 added the on-device tier
-- (-1, see provider-tiers.ts), and finalizeOnDeviceTurn writes
-- `strictest_tier = -1` to chat_context_log. Without this widen the insert
-- silently fails the CHECK constraint and (because logContextDecision
-- swallows insert errors as "best-effort") the on-device audit trail is
-- empty — which violates the spec's "every assisted reply has an audit row"
-- invariant.
--
-- Idempotent: drops + re-adds the named constraint guarded by `if exists`.
-- Safe on a fresh DB (no constraint yet, drop is a no-op) and on the user's
-- existing DB (rebuilds the constraint with the wider range).
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.chat_context_log') is not null then
    alter table public.chat_context_log
      drop constraint if exists chat_context_log_strictest_tier_check;
    alter table public.chat_context_log
      add  constraint chat_context_log_strictest_tier_check
      check (strictest_tier between -1 and 3);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Widen pii_scrub_events.pattern_class to include 'fragment_oversize' — the
-- new audit class emitted when the broker rejects an over-cap assembled
-- fragment. See src/server/context-broker.ts step 7-bis.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if to_regclass('public.pii_scrub_events') is not null then
    alter table public.pii_scrub_events
      drop constraint if exists pii_scrub_events_pattern_class_check;
    alter table public.pii_scrub_events
      add  constraint pii_scrub_events_pattern_class_check
      check (pattern_class in (
        'email','phone','postal','credit_card','name_match',
        'exact_age','gov_id','employer_heuristic','injection_sentinel',
        'fragment_oversize'
      ));
  end if;
end $$;
