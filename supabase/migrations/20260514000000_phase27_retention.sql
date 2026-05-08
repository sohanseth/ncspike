-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2.7 D8 Day 7 — extend cleanup_phase2_retention() to sweep the three
-- new context-broker tables introduced in 20260513000000_phase27_traits.sql.
--
-- Retention windows (spec §14.3):
--   chat_context_log     90 days   (per-message provenance; user can still
--                                   view in ContextFooter for 90 days)
--   pii_scrub_events    365 days   (audit trail — leaks are rare; keep long
--                                   enough for security review cycles)
--   extraction_failures  90 days   (debugging window for the trait extractor)
--
-- We DROP + RECREATE the function so the return signature can grow without
-- the "cannot change return type" error. Same pattern as the Phase 2.6
-- retention migration.
-- ─────────────────────────────────────────────────────────────────────────────

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
  inference_usage_daily_deleted    int,
  chat_context_log_deleted         int,
  pii_scrub_events_deleted         int,
  extraction_failures_deleted      int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r_count    int;
  t_count    int;
  d_count    int;
  c_count    int;
  p_count    int;
  a_count    int;
  iu_count   int;
  iud_count  int;
  ccl_count  int;
  pse_count  int;
  ef_count   int;
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

  -- Inference usage rollup (unchanged from Phase 2.6)
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

  delete from public.inference_usage
   where started_at < now() - interval '30 days';

  delete from public.inference_usage_daily
   where day < (now() - interval '90 days')::date;
  get diagnostics iud_count = row_count;

  -- ── Phase 2.7 additions ────────────────────────────────────────────────
  delete from public.chat_context_log
   where created_at < now() - interval '90 days';
  get diagnostics ccl_count = row_count;

  delete from public.pii_scrub_events
   where created_at < now() - interval '365 days';
  get diagnostics pse_count = row_count;

  delete from public.extraction_failures
   where created_at < now() - interval '90 days';
  get diagnostics ef_count = row_count;

  return query select
    r_count, t_count, d_count, c_count, p_count, a_count,
    iu_count, iud_count,
    ccl_count, pse_count, ef_count;
end;
$$;

revoke all on function public.cleanup_phase2_retention() from public;
grant execute on function public.cleanup_phase2_retention() to service_role;
