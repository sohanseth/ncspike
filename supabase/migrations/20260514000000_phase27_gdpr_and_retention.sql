-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2.7 D8 Day 7 — GDPR transactional wipe + retention extension.
--
-- Consolidated and made fully idempotent: replays cleanly on a DB that has
-- already received an earlier draft of these functions, AND tolerates a DB
-- that's missing the Phase 2.5/2.6 operational tables (tool_invocations,
-- device_tokens, cron_run, push_permission_events, auth_callback_rejections,
-- inference_usage_daily) that some earlier plan introduced but this DB never
-- received. Each per-table sweep is gated on `to_regclass(...)` so missing
-- tables are silently skipped instead of aborting the function.
--
-- This file replaces three drafts that were stranded on a side-branch:
--   20260514000000_phase27_retention.sql
--   20260514000010_phase27_account_delete.sql
--   20260514000020_phase27_account_delete_v2.sql
-- and is the single canonical Day-7 SQL to apply.
--
-- Two surfaces:
--   1) public.delete_user_data(uuid)      — single-transaction "delete my
--      data" wipe across every per-user table the broker, memory, and
--      chat pipeline touch. SECURITY DEFINER + auth.uid() guard so a
--      caller can only wipe themselves (service_role bypasses, since
--      auth.uid() is null on service-role calls).
--
--   2) public.cleanup_phase2_retention()  — extends the existing nightly
--      sweep with the three Phase 2.7 tables (chat_context_log 90d,
--      pii_scrub_events 365d, extraction_failures 90d). Pre-existing
--      sweeps for Phase 2.5/2.6 tables are preserved but each is now
--      guarded by to_regclass so a leaner DB doesn't fail.
--
-- Section ORDER MATTERS: the offline GDPR-roundtrip test parses the FIRST
-- function-return-signature block in this file as the delete-RPC's column
-- list, so delete_user_data() must appear before cleanup_phase2_retention().
-- (Do not write the literal phrase r-e-t-u-r-n-s + table + paren in this
-- header — the test's regex would match it before the real function body.)
--
-- Spec: docs/06-spec-phase-2.7-context-broker.md §14 + §15.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Single-transaction "delete my data" RPC ──────────────────────────────

drop function if exists public.delete_user_data(uuid);

create or replace function public.delete_user_data(target_user_id uuid)
returns table (
  chat_messages_deleted              int,
  chat_threads_deleted               int,
  chat_context_log_deleted           int,
  pii_scrub_events_deleted           int,
  extraction_failures_deleted        int,
  user_trait_blocks_deleted          int,
  user_provider_category_blocks_del  int,
  user_known_names_deleted           int,
  user_traits_deleted                int,
  memory_edges_deleted               int,
  memory_nodes_deleted               int,
  inference_usage_deleted            int,
  inference_usage_daily_deleted      int,
  user_settings_deleted              int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cm_count   int := 0;
  ct_count   int := 0;
  ccl_count  int := 0;
  pse_count  int := 0;
  ef_count   int := 0;
  utb_count  int := 0;
  upcb_count int := 0;
  ukn_count  int := 0;
  ut_count   int := 0;
  me_count   int := 0;
  mn_count   int := 0;
  iu_count   int := 0;
  iud_count  int := 0;
  us_count   int := 0;
begin
  -- AuthZ: only the user themselves (or service_role bypass) may delete.
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'forbidden: caller cannot delete another user''s data';
  end if;

  -- Children-first to keep FK constraints happy. Each guarded by
  -- to_regclass so a missing operational table doesn't abort the wipe.
  -- IMPORTANT: every guarded `delete from public.X where user_id =
  -- target_user_id;` here MUST appear in the same row order as the
  -- corresponding column in `returns table (...)` above — the offline
  -- gdpr-roundtrip test enforces a 1:1 pairing on parse.
  if to_regclass('public.chat_messages') is not null then
    delete from public.chat_messages where user_id = target_user_id;
    get diagnostics cm_count = row_count;
  end if;

  if to_regclass('public.chat_threads') is not null then
    delete from public.chat_threads where user_id = target_user_id;
    get diagnostics ct_count = row_count;
  end if;

  delete from public.chat_context_log where user_id = target_user_id;
  get diagnostics ccl_count = row_count;

  delete from public.pii_scrub_events where user_id = target_user_id;
  get diagnostics pse_count = row_count;

  delete from public.extraction_failures where user_id = target_user_id;
  get diagnostics ef_count = row_count;

  delete from public.user_trait_blocks where user_id = target_user_id;
  get diagnostics utb_count = row_count;

  delete from public.user_provider_category_blocks where user_id = target_user_id;
  get diagnostics upcb_count = row_count;

  delete from public.user_known_names where user_id = target_user_id;
  get diagnostics ukn_count = row_count;

  delete from public.user_traits where user_id = target_user_id;
  get diagnostics ut_count = row_count;

  if to_regclass('public.memory_edges') is not null then
    delete from public.memory_edges where user_id = target_user_id;
    get diagnostics me_count = row_count;
  end if;

  if to_regclass('public.memory_nodes') is not null then
    delete from public.memory_nodes where user_id = target_user_id;
    get diagnostics mn_count = row_count;
  end if;

  if to_regclass('public.inference_usage') is not null then
    delete from public.inference_usage where user_id = target_user_id;
    get diagnostics iu_count = row_count;
  end if;

  if to_regclass('public.inference_usage_daily') is not null then
    delete from public.inference_usage_daily where user_id = target_user_id;
    get diagnostics iud_count = row_count;
  end if;

  if to_regclass('public.user_settings') is not null then
    delete from public.user_settings where user_id = target_user_id;
    get diagnostics us_count = row_count;
  end if;

  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count,
    utb_count, upcb_count, ukn_count, ut_count,
    me_count, mn_count, iu_count, iud_count, us_count;
end;
$$;

revoke all on function public.delete_user_data(uuid) from public;
grant execute on function public.delete_user_data(uuid) to authenticated, service_role;


-- ── 2. Retention sweep ──────────────────────────────────────────────────────

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
  r_count    int := 0;
  t_count    int := 0;
  d_count    int := 0;
  c_count    int := 0;
  p_count    int := 0;
  a_count    int := 0;
  iu_count   int := 0;
  iud_count  int := 0;
  ccl_count  int := 0;
  pse_count  int := 0;
  ef_count   int := 0;
begin
  -- Phase 2.5/2.6 operational sweeps — gated so this works on DBs that
  -- never received the earlier plan that introduced these tables.
  if to_regclass('public.research_tasks') is not null then
    execute $sql$
      delete from public.research_tasks
       where status in ('done','error','cancelled')
         and completed_at is not null
         and completed_at < now() - interval '30 days'
    $sql$;
    get diagnostics r_count = row_count;
  end if;

  if to_regclass('public.tool_invocations') is not null then
    execute $sql$
      delete from public.tool_invocations
       where created_at < now() - interval '7 days'
    $sql$;
    get diagnostics t_count = row_count;
  end if;

  if to_regclass('public.device_tokens') is not null then
    execute $sql$
      delete from public.device_tokens
       where last_seen_at < now() - interval '30 days'
    $sql$;
    get diagnostics d_count = row_count;
  end if;

  if to_regclass('public.cron_run') is not null then
    execute $sql$
      delete from public.cron_run
       where ran_at < now() - interval '14 days'
    $sql$;
    get diagnostics c_count = row_count;
  end if;

  if to_regclass('public.push_permission_events') is not null then
    execute $sql$
      delete from public.push_permission_events
       where created_at < now() - interval '365 days'
    $sql$;
    get diagnostics p_count = row_count;
  end if;

  if to_regclass('public.auth_callback_rejections') is not null then
    execute $sql$
      delete from public.auth_callback_rejections
       where created_at < now() - interval '30 days'
    $sql$;
    get diagnostics a_count = row_count;
  end if;

  -- Inference usage rollup — also gated. The rollup target table only
  -- exists when 20260510000000_phase26_retention.sql was applied.
  if to_regclass('public.inference_usage')       is not null
 and to_regclass('public.inference_usage_daily') is not null then
    execute $sql$
      with to_roll as (
        select
          user_id,
          (started_at at time zone 'UTC')::date as day,
          badge,
          provider_used,
          count(*)::int                                         as request_count,
          count(*) filter (where status='ok')::int              as ok_count,
          count(*) filter (where status='error')::int           as error_count,
          count(*) filter (where status='cap_exceeded')::int    as cap_exceeded_count,
          count(*) filter (where status='user_abort')::int      as user_abort_count,
          count(*) filter (where status='rate_limited')::int    as rate_limited_count,
          coalesce(sum(input_tokens), 0)::bigint                as input_tokens_sum,
          coalesce(sum(output_tokens), 0)::bigint               as output_tokens_sum,
          coalesce(sum(cost_micro_usd), 0)::bigint              as cost_micro_usd_sum,
          coalesce(sum(fallback_depth), 0)::bigint              as fallback_depth_sum
        from public.inference_usage
        where started_at < now() - interval '30 days'
        group by user_id, (started_at at time zone 'UTC')::date, badge, provider_used
      )
      insert into public.inference_usage_daily as d (
        user_id, day, badge, provider_used,
        request_count, ok_count, error_count, cap_exceeded_count,
        user_abort_count, rate_limited_count,
        input_tokens_sum, output_tokens_sum, cost_micro_usd_sum, fallback_depth_sum
      )
      select * from to_roll
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
    $sql$;
    get diagnostics iu_count = row_count;

    execute $sql$
      delete from public.inference_usage
       where started_at < now() - interval '30 days'
    $sql$;

    execute $sql$
      delete from public.inference_usage_daily
       where day < (now() - interval '90 days')::date
    $sql$;
    get diagnostics iud_count = row_count;
  end if;

  -- ── Phase 2.7 additions (these tables ARE on this DB) ────────────────
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
