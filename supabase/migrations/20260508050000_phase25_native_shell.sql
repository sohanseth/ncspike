-- Phase 2.5: Native shell foundation tables.
--
-- Adds four append-only or low-churn tables required by the Capacitor wrapper:
--   1) device_tokens            — FCM/APNs registration per (user, device) pair
--   2) cron_run                 — observability ledger for both the Worker cron
--                                 and the future native background-fetch path
--   3) push_permission_events   — append-only telemetry for OS-level push opt
--                                 in/out so we can compute OCSR per the spec
--   4) auth_callback_rejections — append-only ledger for deep-link callback
--                                 attempts that failed validation (N7 hardening)
--
-- Also extends cleanup_phase2_retention() to sweep the new tables per spec §5
-- TTLs (30/14/365/30 days respectively).

------------------------------------------------------------------------
-- 1) device_tokens
------------------------------------------------------------------------
-- One row per (user, install). The token itself is the unique identifier
-- that FCM/APNs hands us; if the user reinstalls, we get a new token and a
-- new row. We never need to mutate a token in place — only insert / delete.
create table if not exists public.device_tokens (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  platform        text not null check (platform in ('ios','android')),
  -- The opaque registration token from FCM (Android) or APNs-via-FCM (iOS).
  token           text not null unique,
  -- Free-form identifiers so we can debug "which phone is this".
  device_model    text,
  app_version     text,
  created_at      timestamptz not null default now(),
  -- Updated whenever the client re-registers; lets retention prune dead tokens.
  last_seen_at    timestamptz not null default now()
);

create index if not exists device_tokens_user_idx
  on public.device_tokens (user_id);

alter table public.device_tokens enable row level security;

-- Users can read their own device list (Settings → "Devices receiving push").
create policy "own device_tokens select" on public.device_tokens
  for select using (auth.uid() = user_id);

-- Users can delete one of their own tokens (Settings → "Sign out this device").
create policy "own device_tokens delete" on public.device_tokens
  for delete using (auth.uid() = user_id);

-- Insert/update is service-role only, since the client must go through a
-- server fn that validates the auth context before recording the token.

------------------------------------------------------------------------
-- 2) cron_run
------------------------------------------------------------------------
-- One row per cron firing. `source` distinguishes the Worker scheduled
-- handler (authoritative) from the native BackgroundTasks/WorkManager
-- best-effort path so we can compute "duplicate-suppressed" coverage stats
-- in the Diagnostics screen. `status` includes 'noop' for the case where
-- the cron fired but had no eligible work (per architect feedback).
create table if not exists public.cron_run (
  id            bigserial primary key,
  source        text not null check (source in ('worker','native_ios','native_android','manual')),
  status        text not null check (status in ('ok','noop','error','timeout')),
  user_id       uuid references auth.users(id) on delete set null,
  attempted     int not null default 0,
  succeeded     int not null default 0,
  failed        int not null default 0,
  duration_ms   int,
  error_message text,
  ran_at        timestamptz not null default now()
);

create index if not exists cron_run_ran_at_idx
  on public.cron_run (ran_at desc);
create index if not exists cron_run_user_ran_at_idx
  on public.cron_run (user_id, ran_at desc) where user_id is not null;

alter table public.cron_run enable row level security;

-- Users see their own cron runs (Diagnostics screen). Worker-cron rows with
-- user_id=null are admin-only; service role bypasses RLS for those.
create policy "own cron_run select" on public.cron_run
  for select using (auth.uid() = user_id);

------------------------------------------------------------------------
-- 3) push_permission_events
------------------------------------------------------------------------
-- Append-only telemetry. The OS surfaces a single permission decision per
-- install; we log every attempt at the in-app primer + the eventual OS
-- decision so we can compute OCSR (Opt-in Conversion to System Response)
-- per N4. Never overwritten — a user who toggles in iOS Settings later
-- generates a fresh row from the next launch's permission-state read.
create table if not exists public.push_permission_events (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  platform    text not null check (platform in ('ios','android')),
  event       text not null check (event in (
    'primer_shown',
    'primer_accepted',
    'primer_dismissed',
    'os_granted',
    'os_denied',
    'os_provisional',
    'state_check'
  )),
  -- Snapshot of the OS-reported permission state at the moment of the event,
  -- e.g. 'authorized' / 'denied' / 'notDetermined' / 'provisional'. Stored
  -- as text to avoid coupling our enum to OS API churn.
  os_state    text,
  app_version text,
  created_at  timestamptz not null default now()
);

create index if not exists push_permission_events_user_time_idx
  on public.push_permission_events (user_id, created_at desc);

alter table public.push_permission_events enable row level security;

create policy "own push_permission_events select" on public.push_permission_events
  for select using (auth.uid() = user_id);

------------------------------------------------------------------------
-- 4) auth_callback_rejections
------------------------------------------------------------------------
-- N7 telemetry. Every deep link / OAuth callback that fails the path
-- allowlist, state/nonce check, or expiry test gets a row here. This is the
-- signal source of truth for "are we under attack?" — a sudden spike in
-- rejections from a single user_id (or anon) means our deep-link surface is
-- being probed and we should rotate signing material.
--
-- We deliberately do NOT log the raw URL (could contain a real OAuth code
-- on the legitimate-but-misrouted path); we log the host+path+reason only.
create table if not exists public.auth_callback_rejections (
  id          bigserial primary key,
  -- Nullable: pre-auth callbacks have no user yet.
  user_id     uuid references auth.users(id) on delete set null,
  reason      text not null check (reason in (
    'path_not_allowed',
    'host_not_allowed',
    'state_missing',
    'state_mismatch',
    'state_expired',
    'state_replayed',
    'nonce_missing',
    'nonce_mismatch',
    'malformed_url'
  )),
  url_host    text,
  url_path    text,
  client_info text,
  created_at  timestamptz not null default now()
);

create index if not exists auth_callback_rejections_time_idx
  on public.auth_callback_rejections (created_at desc);
create index if not exists auth_callback_rejections_user_idx
  on public.auth_callback_rejections (user_id, created_at desc) where user_id is not null;

alter table public.auth_callback_rejections enable row level security;

-- Users can see their own rejections (Diagnostics → "Recent auth issues").
-- Anonymous rejections are admin-only; service role bypasses RLS.
create policy "own auth_callback_rejections select" on public.auth_callback_rejections
  for select using (auth.uid() = user_id);

------------------------------------------------------------------------
-- 5) Extend cleanup_phase2_retention to cover the new tables
------------------------------------------------------------------------
-- Spec §5 TTLs:
--   device_tokens:            prune rows whose last_seen_at < now() - 30 days
--                             (a stale token returns "Unregistered" from FCM
--                             on next send anyway; this just preempts that)
--   cron_run:                 14 days (observability, not audit)
--   push_permission_events:   365 days (need a year for OCSR cohort math)
--   auth_callback_rejections: 30 days (security signal, not long-term audit)
--
-- Postgres won't let CREATE OR REPLACE change a function's return type, and
-- the prior version of this fn returned 2 columns. Drop first, recreate
-- with the new 6-column shape. Caller in src/server/research-cron.ts already
-- reads the row dynamically (row?.research_tasks_deleted etc.), so the
-- expanded return is backward-compatible at the call site.
drop function if exists public.cleanup_phase2_retention();

create or replace function public.cleanup_phase2_retention()
returns table (
  research_tasks_deleted          int,
  tool_invocations_deleted        int,
  device_tokens_deleted           int,
  cron_run_deleted                int,
  push_permission_events_deleted  int,
  auth_callback_rejections_deleted int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r_count   int;
  t_count   int;
  d_count   int;
  c_count   int;
  p_count   int;
  a_count   int;
begin
  delete from public.research_tasks
   where status in ('done','error','cancelled')
     and completed_at is not null
     and completed_at < now() - interval '30 days';
  get diagnostics r_count = row_count;

  delete from public.tool_invocations
   where created_at < now() - interval '7 days';
  get diagnostics t_count = row_count;

  delete from public.device_tokens
   where last_seen_at < now() - interval '30 days';
  get diagnostics d_count = row_count;

  delete from public.cron_run
   where ran_at < now() - interval '14 days';
  get diagnostics c_count = row_count;

  delete from public.push_permission_events
   where created_at < now() - interval '365 days';
  get diagnostics p_count = row_count;

  delete from public.auth_callback_rejections
   where created_at < now() - interval '30 days';
  get diagnostics a_count = row_count;

  return query select r_count, t_count, d_count, c_count, p_count, a_count;
end;
$$;

revoke all on function public.cleanup_phase2_retention() from public;
grant execute on function public.cleanup_phase2_retention() to service_role;
