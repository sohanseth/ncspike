-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2.7 D8 Day 7 — extend delete_user_data() to also wipe the per-user
-- inference_usage_daily rollup (created in 20260510000000_phase26_retention).
--
-- Drop+recreate to grow the return signature (Postgres won't ALTER it). All
-- deletes still run inside one transaction.
-- ─────────────────────────────────────────────────────────────────────────────

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
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'forbidden: caller cannot delete another user''s data';
  end if;

  delete from public.chat_messages where user_id = target_user_id;
  get diagnostics cm_count = row_count;

  delete from public.chat_threads where user_id = target_user_id;
  get diagnostics ct_count = row_count;

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

  delete from public.memory_edges where user_id = target_user_id;
  get diagnostics me_count = row_count;

  delete from public.memory_nodes where user_id = target_user_id;
  get diagnostics mn_count = row_count;

  delete from public.inference_usage where user_id = target_user_id;
  get diagnostics iu_count = row_count;

  delete from public.inference_usage_daily where user_id = target_user_id;
  get diagnostics iud_count = row_count;

  delete from public.user_settings where user_id = target_user_id;
  get diagnostics us_count = row_count;

  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count,
    utb_count, upcb_count, ukn_count, ut_count,
    me_count, mn_count, iu_count, iud_count, us_count;
end;
$$;

revoke all on function public.delete_user_data(uuid) from public;
grant execute on function public.delete_user_data(uuid) to authenticated, service_role;
