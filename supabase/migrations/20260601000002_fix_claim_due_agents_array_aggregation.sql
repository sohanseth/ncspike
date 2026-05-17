-- ────────────────────────────────────────────────────────────────────────────
-- Phase 3.0 — claim_due_agents bugfix: array aggregation pattern
-- ────────────────────────────────────────────────────────────────────────────
--
-- Bug:
--   The original `claim_due_agents` (see 20260601000000_phase30_agent_runtime.sql)
--   does `update … from due where … returning a.id into claimed_ids`. Postgres'
--   `RETURNING ... INTO target` in plpgsql is NOT a multi-row aggregator: it
--   tries to coerce the returned `uuid` into the `uuid[]` target type and
--   fails with `malformed array literal: "<uuid>"` even on a single returned
--   row. This means the fn errored the moment ANY agent was due — i.e., the
--   cron path was broken in prod from PR #1.
--
--   Caught during deploy verification on 2026-05-18 by invoking
--   runAgentBatch() against real Supabase via a throwaway script. The
--   existing `phase30-claim-due-agents-realdb.test.ts` would have caught it
--   but is gated on `GDPR_REAL_DB_URL`, which CI didn't set.
--
-- Fix:
--   Wrap the `UPDATE ... RETURNING a.id` in a `claimed` CTE and do
--   `SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO claimed_ids FROM claimed`
--   — the canonical Postgres pattern for capturing multi-row RETURNING into
--   an array variable. The `coalesce` keeps `claimed_ids` as `'{}'` (empty
--   array) rather than NULL when zero rows update, so the subsequent
--   `id = any(claimed_ids)` returns an empty set cleanly.
--
-- Behavior change at the API surface: NONE. Same inputs, same row shape
-- returned. The fn now actually succeeds where it used to error.
--
-- This migration is the smallest possible fix — just a CREATE OR REPLACE of
-- one function. No schema changes, no RLS changes, no other touches.

create or replace function public.claim_due_agents(p_limit int)
returns setof public.agents
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_ids uuid[];
  lease_ttl_minutes constant int := 30;
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'claim_due_agents: p_limit must be > 0, got %', p_limit;
  end if;
  if p_limit > 50 then
    raise exception 'claim_due_agents: p_limit must be <= 50 (hard safety cap), got %', p_limit;
  end if;

  with due as (
    select id
    from public.agents
    where state in ('active', 'degraded', 'inactive')
      -- Not currently leased (or lease expired = treat as unleased)
      and (claim_expires_at is null or claim_expires_at < now())
      -- Cadence check based on last_completed_at, not last_claimed_at:
      --   last_completed_at NULL  -> never completed -> always due
      --   last_completed_at recent -> wait until cadence_hours have passed
      and (
        last_completed_at is null
        or last_completed_at < now() - (cadence_hours * interval '1 hour')
      )
      -- Inactive agents run at half cadence per docs/13 §4
      and (
        state <> 'inactive'
        or last_completed_at is null
        or last_completed_at < now() - (cadence_hours * 2 * interval '1 hour')
      )
    order by last_completed_at nulls first
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.agents a
    set
      last_claimed_at  = now(),
      claim_expires_at = now() + (lease_ttl_minutes * interval '1 minute')
    from due
    where a.id = due.id
    returning a.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into claimed_ids from claimed;

  return query
    select * from public.agents where id = any(claimed_ids);
end;
$$;

revoke all on function public.claim_due_agents(int) from public;
grant execute on function public.claim_due_agents(int) to service_role;

comment on function public.claim_due_agents(int) is
  'Phase 3.0 — atomically claims up to p_limit due agents with a 30-min DB-backed lease. Bumps last_claimed_at + claim_expires_at in the same transaction (Invariant 1: no duplicate runs across overlapping crons). Caller MUST call release_agent_lease() at finalize. Service-role only. (Fixed 2026-05-18: array aggregation via CTE + array_agg per migration 20260601000002.)';
