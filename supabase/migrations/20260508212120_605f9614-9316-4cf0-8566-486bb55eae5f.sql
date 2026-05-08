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
  if to_regclass('public.research_tasks') is not null then
    execute 'delete from public.research_tasks where status in (''done'',''error'',''cancelled'') and completed_at is not null and completed_at < now() - interval ''30 days''';
    get diagnostics r_count = row_count;
  end if;
  if to_regclass('public.tool_invocations') is not null then
    execute 'delete from public.tool_invocations where created_at < now() - interval ''7 days''';
    get diagnostics t_count = row_count;
  end if;
  if to_regclass('public.device_tokens') is not null then
    execute 'delete from public.device_tokens where last_seen_at < now() - interval ''30 days''';
    get diagnostics d_count = row_count;
  end if;
  if to_regclass('public.cron_run') is not null then
    execute 'delete from public.cron_run where ran_at < now() - interval ''14 days''';
    get diagnostics c_count = row_count;
  end if;
  if to_regclass('public.push_permission_events') is not null then
    execute 'delete from public.push_permission_events where created_at < now() - interval ''365 days''';
    get diagnostics p_count = row_count;
  end if;
  if to_regclass('public.auth_callback_rejections') is not null then
    execute 'delete from public.auth_callback_rejections where created_at < now() - interval ''30 days''';
    get diagnostics a_count = row_count;
  end if;

  delete from public.chat_context_log where created_at < now() - interval '90 days';
  get diagnostics ccl_count = row_count;
  delete from public.pii_scrub_events where created_at < now() - interval '365 days';
  get diagnostics pse_count = row_count;
  delete from public.extraction_failures where created_at < now() - interval '90 days';
  get diagnostics ef_count = row_count;

  return query select
    r_count, t_count, d_count, c_count, p_count, a_count,
    iu_count, iud_count,
    ccl_count, pse_count, ef_count;
end;
$$;

revoke all on function public.cleanup_phase2_retention() from public;
grant execute on function public.cleanup_phase2_retention() to service_role;