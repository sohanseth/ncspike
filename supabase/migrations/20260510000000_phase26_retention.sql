-- Phase 2.6 Day 4 — inference_usage retention rollup.
--
-- Spec docs/05-spec-phase-2.6-chat-providers.md §C5 line 179:
--   "Retention: chat_messages kept indefinitely until user-initiated delete.
--    inference_usage aggregated to daily rollups after 90 days via an extension
--    of cleanup_phase2_retention() (decision: keep raw rows for 30 days, then
--    per-user-per-day aggregates only for the next 60 days, then delete)."
--
-- This migration:
--   1. Creates public.inference_usage_daily for the per-user-per-day rollup.
--   2. Drops + recreates cleanup_phase2_retention() with an extra return column
--      `inference_usage_rolled_up` capturing the count of raw rows folded into
--      the rollup table on this run.
--   3. Adds the rollup step (raw rows older than 30d → daily aggregate, then
--      delete raw rows; daily rollups older than 90d → delete).
--
-- Backward-compat: research-cron caller reads result row dynamically by name,
-- so adding a 7th column is safe.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Daily rollup table.
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.inference_usage_daily (
  user_id            uuid not null references auth.users(id) on delete cascade,
  day                date not null,
  badge              text not null check (badge in ('flash','pro','genius','private')),
  provider_used      text not null,
  request_count      int  not null default 0,
  ok_count           int  not null default 0,
  error_count        int  not null default 0,
  cap_exceeded_count int  not null default 0,
  user_abort_count   int  not null default 0,
  rate_limited_count int  not null default 0,
  input_tokens_sum   bigint not null default 0,
  output_tokens_sum  bigint not null default 0,
  cost_micro_usd_sum bigint not null default 0,
  fallback_depth_sum bigint not null default 0,
  primary key (user_id, day, badge, provider_used)
);

create index if not exists inference_usage_daily_user_day_idx
  on public.inference_usage_daily(user_id, day);

alter table public.inference_usage_daily enable row level security;

-- Own-rows select. No insert/update/delete policies → service-role-only writes.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='inference_usage_daily'
      and policyname='own usage_daily select'
  ) then
    create policy "own usage_daily select" on public.inference_usage_daily
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2) Recreate cleanup_phase2_retention() with the extra return column +
--    inference_usage rollup logic.
-- ──────────────────────────────────────────────────────────────────────────────
drop function if exists public.cleanup_phase2_retention();

create or replace function public.cleanup_phase2_retention()
returns table (
  research_tasks_deleted           int,
  tool_invocations_deleted         int,
  device_tokens_deleted            int,
  cron_run_deleted                 int,
  push_permission_events_deleted   int,
  auth_callback_rejections_deleted int,
  inference_usage_rolled_up        int,
  inference_usage_daily_deleted    int
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
  iu_count  int;
  iud_count int;
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

  -- Rollup raw inference_usage rows older than 30 days into the daily table,
  -- then delete the raw rows. UPSERT is per (user, day, badge, provider).
  with to_roll as (
    select
      user_id,
      (started_at at time zone 'UTC')::date as day,
      badge,
      provider_used,
      count(*)::int                                              as request_count,
      count(*) filter (where status='ok')::int                   as ok_count,
      count(*) filter (where status='error')::int                as error_count,
      count(*) filter (where status='cap_exceeded')::int         as cap_exceeded_count,
      count(*) filter (where status='user_abort')::int           as user_abort_count,
      count(*) filter (where status='rate_limited')::int         as rate_limited_count,
      coalesce(sum(input_tokens), 0)::bigint                     as input_tokens_sum,
      coalesce(sum(output_tokens), 0)::bigint                    as output_tokens_sum,
      coalesce(sum(cost_micro_usd), 0)::bigint                   as cost_micro_usd_sum,
      coalesce(sum(fallback_depth), 0)::bigint                   as fallback_depth_sum
    from public.inference_usage
    where started_at < now() - interval '30 days'
    group by user_id, (started_at at time zone 'UTC')::date, badge, provider_used
  ),
  upserted as (
    insert into public.inference_usage_daily as d (
      user_id, day, badge, provider_used,
      request_count, ok_count, error_count, cap_exceeded_count,
      user_abort_count, rate_limited_count,
      input_tokens_sum, output_tokens_sum, cost_micro_usd_sum, fallback_depth_sum
    )
    select
      user_id, day, badge, provider_used,
      request_count, ok_count, error_count, cap_exceeded_count,
      user_abort_count, rate_limited_count,
      input_tokens_sum, output_tokens_sum, cost_micro_usd_sum, fallback_depth_sum
    from to_roll
    on conflict (user_id, day, badge, provider_used) do update set
      request_count       = d.request_count       + excluded.request_count,
      ok_count            = d.ok_count            + excluded.ok_count,
      error_count         = d.error_count         + excluded.error_count,
      cap_exceeded_count  = d.cap_exceeded_count  + excluded.cap_exceeded_count,
      user_abort_count    = d.user_abort_count    + excluded.user_abort_count,
      rate_limited_count  = d.rate_limited_count  + excluded.rate_limited_count,
      input_tokens_sum    = d.input_tokens_sum    + excluded.input_tokens_sum,
      output_tokens_sum   = d.output_tokens_sum   + excluded.output_tokens_sum,
      cost_micro_usd_sum  = d.cost_micro_usd_sum  + excluded.cost_micro_usd_sum,
      fallback_depth_sum  = d.fallback_depth_sum  + excluded.fallback_depth_sum
    returning 1
  )
  select coalesce(sum(request_count), 0)::int into iu_count from to_roll;

  -- Now delete the raw rows we just folded in.
  delete from public.inference_usage
   where started_at < now() - interval '30 days';

  -- Drop daily aggregates older than 90 days entirely.
  delete from public.inference_usage_daily
   where day < (now() - interval '90 days')::date;
  get diagnostics iud_count = row_count;

  return query select r_count, t_count, d_count, c_count, p_count, a_count, iu_count, iud_count;
end;
$$;

revoke all on function public.cleanup_phase2_retention() from public;
grant execute on function public.cleanup_phase2_retention() to service_role;
