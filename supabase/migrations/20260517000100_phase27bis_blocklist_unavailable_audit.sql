-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2.7-bis hardening — widen pii_scrub_events.pattern_class to include
-- 'blocklist_unavailable'. The broker now fails closed when it cannot load
-- the user's per-trait or per-provider-tier blocklists from
-- user_trait_blocks / user_provider_category_blocks (architect B2 finding,
-- 2026-05-09: silent fail-open let blocked categories slip through during
-- a Supabase hiccup). The new audit class lets ops distinguish a real PII
-- match from a "we couldn't verify exclusions" event without inspecting
-- code paths.
--
-- Idempotent: drops + re-adds the named constraint guarded by `if exists`.
-- Safe on a fresh DB and on the user's existing DB.
-- Predecessor: 20260517000000_phase29_audit_widen_tier.sql added
-- 'fragment_oversize' to the same constraint; this extends that list.
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
        'fragment_oversize',
        'blocklist_unavailable'
      ));
  end if;
end $$;
