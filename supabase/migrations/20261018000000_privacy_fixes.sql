drop function if exists public.delete_user_data(uuid);

create function public.delete_user_data(target_user_id uuid)
returns table(
  chat_messages_deleted integer,
  chat_threads_deleted integer,
  chat_context_log_deleted integer,
  pii_scrub_events_deleted integer,
  extraction_failures_deleted integer,
  user_trait_blocks_deleted integer,
  user_provider_category_blocks_del integer,
  user_known_names_deleted integer,
  user_traits_deleted integer,
  memory_edges_deleted integer,
  memory_nodes_deleted integer,
  inference_usage_deleted integer,
  inference_usage_daily_deleted integer,
  user_settings_deleted integer,
  chat_message_attachments_deleted integer,
  search_queries_deleted integer,
  agent_findings_deleted integer,
  agent_state_deleted integer,
  agent_runs_deleted integer,
  agents_deleted integer,
  relay_cards_deleted integer,
  relay_devices_deleted integer,
  relay_pairing_codes_deleted integer,
  connections_deleted integer,
  drafts_deleted integer,
  voice_profiles_deleted integer,
  research_tasks_deleted integer,
  user_endpoints_deleted integer,
  watchers_deleted integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  cm_count int := 0; ct_count int := 0; ccl_count int := 0; pse_count int := 0;
  ef_count int := 0; utb_count int := 0; upcb_count int := 0; ukn_count int := 0;
  ut_count int := 0; me_count int := 0; mn_count int := 0; iu_count int := 0;
  iud_count int := 0; us_count int := 0; cma_count int := 0; sq_count int := 0;
  af_count int := 0; ast_count int := 0; ar_count int := 0; ag_count int := 0;
  rc_count int := 0; rd_count int := 0; rp_count int := 0;
  conn_count int := 0; dr_count int := 0; vp_count int := 0; rt_count int := 0;
  ue_count int := 0; w_count int := 0;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'forbidden: caller cannot delete another user''s data';
  end if;

  if to_regclass('public.drafts') is not null then
    delete from public.drafts where user_id = target_user_id;
    get diagnostics dr_count = row_count;
  end if;
  if to_regclass('public.chat_message_attachments') is not null then
    delete from public.chat_message_attachments where user_id = target_user_id;
    get diagnostics cma_count = row_count;
  end if;
  if to_regclass('public.chat_messages') is not null then
    delete from public.chat_messages where user_id = target_user_id;
    get diagnostics cm_count = row_count;
  end if;
  if to_regclass('public.chat_threads') is not null then
    delete from public.chat_threads where user_id = target_user_id;
    get diagnostics ct_count = row_count;
  end if;
  if to_regclass('public.chat_context_log') is not null then
    delete from public.chat_context_log where user_id = target_user_id;
    get diagnostics ccl_count = row_count;
  end if;
  if to_regclass('public.pii_scrub_events') is not null then
    delete from public.pii_scrub_events where user_id = target_user_id;
    get diagnostics pse_count = row_count;
  end if;
  if to_regclass('public.extraction_failures') is not null then
    delete from public.extraction_failures where user_id = target_user_id;
    get diagnostics ef_count = row_count;
  end if;
  if to_regclass('public.user_trait_blocks') is not null then
    delete from public.user_trait_blocks where user_id = target_user_id;
    get diagnostics utb_count = row_count;
  end if;
  if to_regclass('public.user_provider_category_blocks') is not null then
    delete from public.user_provider_category_blocks where user_id = target_user_id;
    get diagnostics upcb_count = row_count;
  end if;
  if to_regclass('public.user_known_names') is not null then
    delete from public.user_known_names where user_id = target_user_id;
    get diagnostics ukn_count = row_count;
  end if;
  if to_regclass('public.user_traits') is not null then
    delete from public.user_traits where user_id = target_user_id;
    get diagnostics ut_count = row_count;
  end if;
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
  if to_regclass('public.search_queries') is not null then
    delete from public.search_queries where user_id = target_user_id;
    get diagnostics sq_count = row_count;
  end if;
  if to_regclass('public.agent_findings') is not null then
    delete from public.agent_findings where user_id = target_user_id;
    get diagnostics af_count = row_count;
  end if;
  if to_regclass('public.agent_state') is not null then
    delete from public.agent_state where user_id = target_user_id;
    get diagnostics ast_count = row_count;
  end if;
  if to_regclass('public.agent_runs') is not null then
    delete from public.agent_runs where user_id = target_user_id;
    get diagnostics ar_count = row_count;
  end if;
  if to_regclass('public.relay_missions') is not null then
    delete from public.relay_missions where user_id = target_user_id;
  end if;
  if to_regclass('public.agents') is not null then
    delete from public.agents where user_id = target_user_id;
    get diagnostics ag_count = row_count;
  end if;
  if to_regclass('public.relay_cards') is not null then
    delete from public.relay_cards where user_id = target_user_id;
    get diagnostics rc_count = row_count;
  end if;
  if to_regclass('public.relay_devices') is not null then
    delete from public.relay_devices where user_id = target_user_id;
    get diagnostics rd_count = row_count;
  end if;
  if to_regclass('public.relay_pairing_codes') is not null then
    delete from public.relay_pairing_codes where user_id = target_user_id;
    get diagnostics rp_count = row_count;
  end if;
  if to_regclass('public.connections') is not null then
    delete from public.connections where user_id = target_user_id;
    get diagnostics conn_count = row_count;
  end if;
  if to_regclass('public.voice_profiles') is not null then
    delete from public.voice_profiles where user_id = target_user_id;
    get diagnostics vp_count = row_count;
  end if;
  if to_regclass('public.research_tasks') is not null then
    delete from public.research_tasks where user_id = target_user_id;
    get diagnostics rt_count = row_count;
  end if;
  if to_regclass('public.user_endpoints') is not null then
    delete from public.user_endpoints where user_id = target_user_id;
    get diagnostics ue_count = row_count;
  end if;
  if to_regclass('public.watchers') is not null then
    delete from public.watchers where user_id = target_user_id;
    get diagnostics w_count = row_count;
  end if;

  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count, utb_count, upcb_count,
    ukn_count, ut_count, me_count, mn_count, iu_count, iud_count, us_count,
    cma_count, sq_count, af_count, ast_count, ar_count, ag_count, rc_count,
    rd_count, rp_count, conn_count, dr_count, vp_count, rt_count, ue_count,
    w_count;
end;
$$;

revoke execute on function public.delete_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_user_data(uuid) to service_role;

update public.user_settings set voice_drafts_consent_at = null
where voice_drafts_consent_at is not null;

update public.research_tasks
set status = 'cancelled', completed_at = now()
where source = 'auto' and status = 'pending';

drop function if exists public.cleanup_phase2_retention();

create function public.cleanup_phase2_retention()
returns table(
  research_tasks_deleted integer,
  tool_invocations_deleted integer,
  device_tokens_deleted integer,
  cron_run_deleted integer,
  push_permission_events_deleted integer,
  auth_callback_rejections_deleted integer,
  inference_usage_rolled_up integer,
  inference_usage_daily_deleted integer,
  chat_context_log_deleted integer,
  pii_scrub_events_deleted integer,
  extraction_failures_deleted integer,
  search_queries_deleted integer,
  voice_profiles_deleted integer
)
language plpgsql
security definer
set search_path to 'public'
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
  sq_count   int := 0;
  vp_count   int := 0;
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

  if to_regclass('public.search_queries') is not null then
    delete from public.search_queries where created_at < now() - interval '30 days';
    get diagnostics sq_count = row_count;
  end if;
  if to_regclass('public.voice_profiles') is not null then
    delete from public.voice_profiles where expires_at < now();
    get diagnostics vp_count = row_count;
  end if;

  return query select
    r_count, t_count, d_count, c_count, p_count, a_count,
    iu_count, iud_count,
    ccl_count, pse_count, ef_count, sq_count, vp_count;
end;
$$;