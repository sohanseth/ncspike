-- Phase 3.0 agent runtime: 4 tables + claim/release/lifecycle RPCs.
--
-- Spec: docs/16-spec-phase-3.0-runtime.md
-- Decisions: docs/09 §9 and docs/13 §18 (both v1 LOCKED 2026-05-15).
-- Schema correction (lease semantics + timestamp split) per docs/16 §6.1.
--
-- Idempotent per replit.md preferences: enum creates wrapped in `do $$ end`,
-- tables use `if not exists`, policies drop+recreate, function signatures
-- use `create or replace`.
--
-- Tables: agents, agent_runs, agent_findings, agent_state.
-- Functions: claim_due_agents, release_agent_lease, update_agent_lifecycle_state.

-- ────────────────────────────────────────────────────────────────────────────
-- Enums (idempotent)
-- ────────────────────────────────────────────────────────────────────────────

do $$ begin
  if not exists (select 1 from pg_type where typname = 'agent_state_enum') then
    create type public.agent_state_enum as enum (
      'draft',
      'active',
      'paused',
      'degraded',
      'inactive',
      'error',
      'needs_user_attention',
      'archived'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'agent_run_status_enum') then
    create type public.agent_run_status_enum as enum (
      'running',
      'ok',
      'failed',
      'partial_success',
      'skipped_budget_exceeded',
      'skipped_disabled',
      'timeout',
      'cancelled'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'agent_finding_state_enum') then
    create type public.agent_finding_state_enum as enum (
      'new',
      'seen',
      'accepted',
      'dismissed',
      'snoozed',
      'archived'
    );
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- agents — agent definitions, lifecycle state, lease.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.agents (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  template_id           text not null,                -- 'research_digest' (3.0); 'job', 'shopping', 'deal_watcher' (3.1+)
  display_name          text not null,
  config                jsonb not null default '{}'::jsonb,
  badge                 text not null,                -- 'private' | 'flash' | 'pro' | 'genius'
  state                 public.agent_state_enum not null default 'draft',
  cadence_hours         int  not null default 24,
  budget                jsonb not null,               -- AgentBudget; see docs/13 §6
  notify                jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Timestamp + lease columns (docs/16 §6.1 schema correction 2026-05-17):
  --   last_claimed_at  : diagnostic; set by claim_due_agents at claim time
  --   last_completed_at: drives cadence; set by release_agent_lease at finalize
  --   last_useful_at   : drives inactive transition; set when items_kept > 0
  --   claim_expires_at : lease TTL; if set + in future, agent is currently claimed
  last_claimed_at       timestamptz,
  last_completed_at     timestamptz,
  last_useful_at        timestamptz,
  claim_expires_at      timestamptz,

  consecutive_failures  int not null default 0,

  constraint agents_cadence_positive check (cadence_hours > 0),
  constraint agents_cadence_reasonable check (cadence_hours <= 8760),  -- 1 year max
  constraint agents_consecutive_failures_nonneg check (consecutive_failures >= 0)
);

create index if not exists agents_user_state_idx
  on public.agents (user_id, state);

create index if not exists agents_due_idx
  on public.agents (state, last_completed_at)
  where state in ('active', 'degraded', 'inactive');

alter table public.agents enable row level security;

drop policy if exists agents_owner_all on public.agents;
create policy agents_owner_all on public.agents
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- updated_at trigger reuses the existing tg_set_updated_at function
-- (defined in the original schema migration; no need to recreate).
drop trigger if exists agents_set_updated on public.agents;
create trigger agents_set_updated
  before update on public.agents
  for each row execute function public.tg_set_updated_at();

comment on table public.agents is
  'Phase 3.0 — per-user agent definitions. claim_expires_at acts as a DB-backed lease (no Durable Objects needed). See docs/16 §6.1 for the timestamp + lease invariants.';

-- ────────────────────────────────────────────────────────────────────────────
-- agent_runs — per-run history.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references public.agents(id) on delete cascade,
  user_id       uuid not null,                -- denormalized for RLS + per-user retention
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        public.agent_run_status_enum not null default 'running',
  items_fetched int not null default 0,
  items_kept    int not null default 0,
  llm_hops      int not null default 0,
  cost_usd      numeric(10,6) not null default 0,
  error         text                          -- PII-scrubbed, truncated to 500 chars

  -- No FK on user_id (it's denormalized for query efficiency; agents.user_id
  -- is the source of truth + cascades on delete).
);

create index if not exists agent_runs_agent_started_idx
  on public.agent_runs (agent_id, started_at desc);

create index if not exists agent_runs_user_started_idx
  on public.agent_runs (user_id, started_at desc);

-- For the stuck-run sweep query: find 'running' rows older than threshold.
create index if not exists agent_runs_running_started_idx
  on public.agent_runs (started_at)
  where status = 'running';

alter table public.agent_runs enable row level security;

drop policy if exists agent_runs_owner_all on public.agent_runs;
create policy agent_runs_owner_all on public.agent_runs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on table public.agent_runs is
  'Phase 3.0 — durable per-run record. status enum covers all outcomes (ok / failed / partial_success / skipped_* / timeout / cancelled). agent_runs.cost_usd is the per-run total; per-hop costs land in inference_usage with source = ''agent_run''.';

-- ────────────────────────────────────────────────────────────────────────────
-- agent_findings — agent output (research articles, jobs, deals, etc.).
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.agent_findings (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  user_id         uuid not null,
  run_id          uuid not null references public.agent_runs(id) on delete cascade,
  dedupe_key      text not null,                -- template-defined; see docs/13 §8
  title           text not null,
  summary         text,
  source_url      text,
  payload         jsonb not null default '{}'::jsonb,
  score           numeric(4,3) not null,        -- 0..1, template's relevance score
  state           public.agent_finding_state_enum not null default 'new',
  urgency         text not null default 'normal',
  user_feedback   text,
  created_at      timestamptz not null default now(),
  acted_at        timestamptz,

  constraint agent_findings_dedupe_unique unique (agent_id, dedupe_key),
  constraint agent_findings_urgency_check check (urgency in ('normal', 'urgent')),
  constraint agent_findings_score_check check (score >= 0 and score <= 1)
);

create index if not exists agent_findings_user_state_idx
  on public.agent_findings (user_id, state, created_at desc);

create index if not exists agent_findings_agent_created_idx
  on public.agent_findings (agent_id, created_at desc);

alter table public.agent_findings enable row level security;

drop policy if exists agent_findings_owner_all on public.agent_findings;
create policy agent_findings_owner_all on public.agent_findings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on table public.agent_findings is
  'Phase 3.0 — agent output, dedupe-unique per (agent_id, dedupe_key). 3.0 ships read-only; accept/dismiss/snooze ships with 3.1 notification UX per docs/16 §14.';

-- ────────────────────────────────────────────────────────────────────────────
-- agent_state — free-form per-agent KV for cursors, fetched-IDs caches.
-- Siloed: NO direct or implicit promotion to trait_sheet per docs/13 §18.4.
-- Phase 3.5 ships the explicit + suggested-via-approval promotion paths.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.agent_state (
  agent_id   uuid not null references public.agents(id) on delete cascade,
  user_id    uuid not null,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (agent_id, key)
);

create index if not exists agent_state_user_idx
  on public.agent_state (user_id);

alter table public.agent_state enable row level security;

drop policy if exists agent_state_owner_all on public.agent_state;
create policy agent_state_owner_all on public.agent_state
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on table public.agent_state is
  'Phase 3.0 — per-agent KV for cursors / dedupe caches / embeddings. Siloed from trait_sheet (no implicit writes). Promotion paths ship in 3.5.';

-- ────────────────────────────────────────────────────────────────────────────
-- claim_due_agents — atomic claim with lease + cadence check.
--
-- Invariant 1 (no duplicate runs): the UPDATE inside the CTE bumps
--   last_claimed_at + claim_expires_at in the same transaction. A crashed
--   runner still has its claim recorded; the next cron tick treats the
--   agent as leased until claim_expires_at < now().
--
-- Invariant 2 (no unbounded batches): hard limit via p_limit. The function
--   raises on p_limit > 50 to prevent caller mistakes; callers should use
--   BATCH_LIMIT = 10 per docs/16 §10.
--
-- Lease TTL = 30 min (constant in this function; align with cron cadence).
-- ────────────────────────────────────────────────────────────────────────────

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
  )
  update public.agents a
  set
    last_claimed_at  = now(),
    claim_expires_at = now() + (lease_ttl_minutes * interval '1 minute')
  from due
  where a.id = due.id
  returning a.id into claimed_ids;

  return query
    select * from public.agents where id = any(claimed_ids);
end;
$$;

revoke all on function public.claim_due_agents(int) from public;
grant execute on function public.claim_due_agents(int) to service_role;

comment on function public.claim_due_agents(int) is
  'Phase 3.0 — atomically claims up to p_limit due agents with a 30-min DB-backed lease. Bumps last_claimed_at + claim_expires_at in the same transaction (Invariant 1: no duplicate runs across overlapping crons). Caller MUST call release_agent_lease() at finalize. Service-role only.';

-- ────────────────────────────────────────────────────────────────────────────
-- release_agent_lease — called by the runner at finalize().
-- Sets last_completed_at, clears the lease, conditionally bumps
-- last_useful_at when the run produced findings. Idempotent.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.release_agent_lease(
  p_agent_id   uuid,
  p_items_kept int default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.agents
  set
    last_completed_at = now(),
    claim_expires_at  = null,
    last_useful_at    = case when p_items_kept > 0 then now() else last_useful_at end
  where id = p_agent_id;
end;
$$;

revoke all on function public.release_agent_lease(uuid, int) from public;
grant execute on function public.release_agent_lease(uuid, int) to service_role;

comment on function public.release_agent_lease(uuid, int) is
  'Phase 3.0 — called by the runner at finalize. Clears the lease + sets last_completed_at. Bumps last_useful_at when p_items_kept > 0 (drives inactive transition). Idempotent.';

-- ────────────────────────────────────────────────────────────────────────────
-- update_agent_lifecycle_state — state-machine transitions per docs/13 §4.
-- Called by the runner at finalize after release_agent_lease. Idempotent.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.update_agent_lifecycle_state(
  p_agent_id   uuid,
  p_status     text,
  p_items_kept int default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state  public.agent_state_enum;
  v_failures int;
  v_last_useful timestamptz;
begin
  select state, consecutive_failures, last_useful_at
    into v_state, v_failures, v_last_useful
    from public.agents
    where id = p_agent_id;
  if not found then
    return;
  end if;

  if p_status = 'ok' and p_items_kept > 0 then
    -- Successful run with output: reset failures + recover from degraded/inactive.
    update public.agents
    set
      consecutive_failures = 0,
      state = case
        when v_state in ('degraded', 'inactive') then 'active'::public.agent_state_enum
        else v_state
      end
    where id = p_agent_id;

  elsif p_status = 'failed' then
    -- Failed run: increment failure counter; promote to degraded / error.
    update public.agents
    set
      consecutive_failures = consecutive_failures + 1,
      state = case
        when consecutive_failures + 1 >= 20 then 'error'::public.agent_state_enum
        when consecutive_failures + 1 >= 5 then 'degraded'::public.agent_state_enum
        else v_state
      end
    where id = p_agent_id;

  elsif p_status = 'ok' and p_items_kept = 0 then
    -- Successful but useless run: check for inactive transition.
    update public.agents
    set state = case
      when v_state = 'active'
        and (v_last_useful is null or v_last_useful < now() - interval '30 days')
        then 'inactive'::public.agent_state_enum
      else v_state
    end
    where id = p_agent_id;
  end if;

  -- Other statuses (partial_success / skipped_* / timeout / cancelled) do
  -- not auto-transition state in 3.0. They surface in agent_runs for the UI.
end;
$$;

revoke all on function public.update_agent_lifecycle_state(uuid, text, int) from public;
grant execute on function public.update_agent_lifecycle_state(uuid, text, int) to service_role;

comment on function public.update_agent_lifecycle_state(uuid, text, int) is
  'Phase 3.0 — state-machine transitions per docs/13 §4. ok+items>0 resets failures; failed increments; ok+items=0 checks for inactive. Idempotent.';
