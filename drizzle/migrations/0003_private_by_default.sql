alter table public.user_settings add column if not exists private_default_applied_at timestamptz;
update public.user_settings set private_only_mode = true, private_default_applied_at = now() where private_default_applied_at is null;
alter table public.user_settings alter column private_only_mode set default true;
alter table public.user_settings alter column private_default_applied_at set default now();

create table if not exists public.cloud_consents (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  feature text not null check (feature in ('cloud_chat','voice_replies','web_search','email_on_server','email_ai','calendar_on_server','nightly_traits','overnight_research','voice_input')),
  granted boolean not null,
  wording_version text not null,
  source text not null check (source in ('settings','prompt','preset')),
  created_at timestamptz not null default now()
);
revoke all on public.cloud_consents from anon, authenticated;
grant select on public.cloud_consents to authenticated;
grant all on public.cloud_consents to service_role;
create index if not exists cloud_consents_user_feature_idx on public.cloud_consents (user_id, feature, id desc);
alter table public.cloud_consents enable row level security;
drop policy if exists "own consents readable" on public.cloud_consents;
create policy "own consents readable" on public.cloud_consents for select to authenticated using (auth.uid() = user_id);

create table if not exists public.cloud_activity (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  feature text not null,
  provider text not null,
  created_at timestamptz not null default now()
);
revoke all on public.cloud_activity from anon, authenticated;
grant select on public.cloud_activity to authenticated;
grant all on public.cloud_activity to service_role;
create index if not exists cloud_activity_user_created_idx on public.cloud_activity (user_id, created_at desc);
alter table public.cloud_activity enable row level security;
drop policy if exists "own activity readable" on public.cloud_activity;
create policy "own activity readable" on public.cloud_activity for select to authenticated using (auth.uid() = user_id);

create or replace function public.delete_cloud_for_removed_user() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  delete from public.cloud_consents where user_id = old.id;
  delete from public.cloud_activity where user_id = old.id;
  return old;
end;
$fn$;
revoke execute on function public.delete_cloud_for_removed_user() from public, anon, authenticated;
drop trigger if exists delete_cloud_for_removed_user on auth.users;
create trigger delete_cloud_for_removed_user after delete on auth.users
  for each row execute function public.delete_cloud_for_removed_user();

drop function if exists public.delete_user_data(uuid);
create or replace function public.delete_user_data(target_user_id uuid)
returns table(
  chat_messages_deleted integer, chat_threads_deleted integer, chat_context_log_deleted integer,
  pii_scrub_events_deleted integer, extraction_failures_deleted integer, user_trait_blocks_deleted integer,
  user_provider_category_blocks_del integer, user_known_names_deleted integer, user_traits_deleted integer,
  memory_edges_deleted integer, memory_nodes_deleted integer, inference_usage_deleted integer,
  inference_usage_daily_deleted integer, user_settings_deleted integer, chat_message_attachments_deleted integer,
  search_queries_deleted integer, agent_findings_deleted integer, agent_state_deleted integer,
  agent_runs_deleted integer, agents_deleted integer, relay_cards_deleted integer,
  relay_devices_deleted integer, relay_pairing_codes_deleted integer, connections_deleted integer,
  drafts_deleted integer, voice_profiles_deleted integer, research_tasks_deleted integer,
  user_endpoints_deleted integer, watchers_deleted integer,
  cloud_consents_deleted integer, cloud_activity_deleted integer
)
language plpgsql security definer set search_path to 'public'
as $$
declare
  cm_count int := 0; ct_count int := 0; ccl_count int := 0; pse_count int := 0;
  ef_count int := 0; utb_count int := 0; upcb_count int := 0; ukn_count int := 0;
  ut_count int := 0; me_count int := 0; mn_count int := 0; iu_count int := 0;
  iud_count int := 0; us_count int := 0; cma_count int := 0; sq_count int := 0;
  af_count int := 0; ast_count int := 0; ar_count int := 0; ag_count int := 0;
  rc_count int := 0; rd_count int := 0; rp_count int := 0;
  conn_count int := 0; dr_count int := 0; vp_count int := 0; rt_count int := 0;
  ue_count int := 0; w_count int := 0; cc_count int := 0; ca_count int := 0;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'forbidden: caller cannot delete another user''s data';
  end if;
  if to_regclass('public.drafts') is not null then
    delete from public.drafts where user_id = target_user_id; get diagnostics dr_count = row_count; end if;
  if to_regclass('public.chat_message_attachments') is not null then
    delete from public.chat_message_attachments where user_id = target_user_id; get diagnostics cma_count = row_count; end if;
  if to_regclass('public.chat_messages') is not null then
    delete from public.chat_messages where user_id = target_user_id; get diagnostics cm_count = row_count; end if;
  if to_regclass('public.chat_threads') is not null then
    delete from public.chat_threads where user_id = target_user_id; get diagnostics ct_count = row_count; end if;
  if to_regclass('public.chat_context_log') is not null then
    delete from public.chat_context_log where user_id = target_user_id; get diagnostics ccl_count = row_count; end if;
  if to_regclass('public.pii_scrub_events') is not null then
    delete from public.pii_scrub_events where user_id = target_user_id; get diagnostics pse_count = row_count; end if;
  if to_regclass('public.extraction_failures') is not null then
    delete from public.extraction_failures where user_id = target_user_id; get diagnostics ef_count = row_count; end if;
  if to_regclass('public.user_trait_blocks') is not null then
    delete from public.user_trait_blocks where user_id = target_user_id; get diagnostics utb_count = row_count; end if;
  if to_regclass('public.user_provider_category_blocks') is not null then
    delete from public.user_provider_category_blocks where user_id = target_user_id; get diagnostics upcb_count = row_count; end if;
  if to_regclass('public.user_known_names') is not null then
    delete from public.user_known_names where user_id = target_user_id; get diagnostics ukn_count = row_count; end if;
  if to_regclass('public.user_traits') is not null then
    delete from public.user_traits where user_id = target_user_id; get diagnostics ut_count = row_count; end if;
  if to_regclass('public.memory_edges') is not null then
    delete from public.memory_edges where user_id = target_user_id; get diagnostics me_count = row_count; end if;
  if to_regclass('public.memory_nodes') is not null then
    delete from public.memory_nodes where user_id = target_user_id; get diagnostics mn_count = row_count; end if;
  if to_regclass('public.inference_usage') is not null then
    delete from public.inference_usage where user_id = target_user_id; get diagnostics iu_count = row_count; end if;
  if to_regclass('public.inference_usage_daily') is not null then
    delete from public.inference_usage_daily where user_id = target_user_id; get diagnostics iud_count = row_count; end if;
  if to_regclass('public.user_settings') is not null then
    delete from public.user_settings where user_id = target_user_id; get diagnostics us_count = row_count; end if;
  if to_regclass('public.search_queries') is not null then
    delete from public.search_queries where user_id = target_user_id; get diagnostics sq_count = row_count; end if;
  if to_regclass('public.agent_findings') is not null then
    delete from public.agent_findings where user_id = target_user_id; get diagnostics af_count = row_count; end if;
  if to_regclass('public.agent_state') is not null then
    delete from public.agent_state where user_id = target_user_id; get diagnostics ast_count = row_count; end if;
  if to_regclass('public.agent_runs') is not null then
    delete from public.agent_runs where user_id = target_user_id; get diagnostics ar_count = row_count; end if;
  if to_regclass('public.agents') is not null then
    delete from public.agents where user_id = target_user_id; get diagnostics ag_count = row_count; end if;
  if to_regclass('public.relay_cards') is not null then
    delete from public.relay_cards where user_id = target_user_id; get diagnostics rc_count = row_count; end if;
  if to_regclass('public.relay_devices') is not null then
    delete from public.relay_devices where user_id = target_user_id; get diagnostics rd_count = row_count; end if;
  if to_regclass('public.relay_pairing_codes') is not null then
    delete from public.relay_pairing_codes where user_id = target_user_id; get diagnostics rp_count = row_count; end if;
  if to_regclass('public.connections') is not null then
    delete from public.connections where user_id = target_user_id; get diagnostics conn_count = row_count; end if;
  if to_regclass('public.voice_profiles') is not null then
    delete from public.voice_profiles where user_id = target_user_id; get diagnostics vp_count = row_count; end if;
  if to_regclass('public.research_tasks') is not null then
    delete from public.research_tasks where user_id = target_user_id; get diagnostics rt_count = row_count; end if;
  if to_regclass('public.user_endpoints') is not null then
    delete from public.user_endpoints where user_id = target_user_id; get diagnostics ue_count = row_count; end if;
  if to_regclass('public.watchers') is not null then
    delete from public.watchers where user_id = target_user_id; get diagnostics w_count = row_count; end if;
  if to_regclass('public.cloud_consents') is not null then
    delete from public.cloud_consents where user_id = target_user_id; get diagnostics cc_count = row_count; end if;
  if to_regclass('public.cloud_activity') is not null then
    delete from public.cloud_activity where user_id = target_user_id; get diagnostics ca_count = row_count; end if;
  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count, utb_count, upcb_count,
    ukn_count, ut_count, me_count, mn_count, iu_count, iud_count, us_count,
    cma_count, sq_count, af_count, ast_count, ar_count, ag_count, rc_count,
    rd_count, rp_count, conn_count, dr_count, vp_count, rt_count, ue_count,
    w_count, cc_count, ca_count;
end;
$$;
revoke execute on function public.delete_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_user_data(uuid) to service_role;

drop function if exists public.cleanup_phase2_retention();
create function public.cleanup_phase2_retention()
returns table(
  research_tasks_deleted integer, tool_invocations_deleted integer, device_tokens_deleted integer,
  cron_run_deleted integer, push_permission_events_deleted integer, auth_callback_rejections_deleted integer,
  inference_usage_rolled_up integer, inference_usage_daily_deleted integer, chat_context_log_deleted integer,
  pii_scrub_events_deleted integer, extraction_failures_deleted integer, search_queries_deleted integer,
  voice_profiles_deleted integer, cloud_activity_deleted integer
)
language plpgsql security definer set search_path to 'public'
as $$
declare
  r_count int := 0; t_count int := 0; d_count int := 0; c_count int := 0; p_count int := 0;
  a_count int := 0; iu_count int := 0; iud_count int := 0; ccl_count int := 0; pse_count int := 0;
  ef_count int := 0; sq_count int := 0; vp_count int := 0; ca_count int := 0;
begin
  if to_regclass('public.research_tasks') is not null then
    execute 'delete from public.research_tasks where status in (''done'',''error'',''cancelled'') and completed_at is not null and completed_at < now() - interval ''30 days''';
    get diagnostics r_count = row_count; end if;
  if to_regclass('public.tool_invocations') is not null then
    execute 'delete from public.tool_invocations where created_at < now() - interval ''7 days''';
    get diagnostics t_count = row_count; end if;
  if to_regclass('public.device_tokens') is not null then
    execute 'delete from public.device_tokens where last_seen_at < now() - interval ''30 days''';
    get diagnostics d_count = row_count; end if;
  if to_regclass('public.cron_run') is not null then
    execute 'delete from public.cron_run where ran_at < now() - interval ''14 days''';
    get diagnostics c_count = row_count; end if;
  if to_regclass('public.push_permission_events') is not null then
    execute 'delete from public.push_permission_events where created_at < now() - interval ''365 days''';
    get diagnostics p_count = row_count; end if;
  if to_regclass('public.auth_callback_rejections') is not null then
    execute 'delete from public.auth_callback_rejections where created_at < now() - interval ''30 days''';
    get diagnostics a_count = row_count; end if;
  delete from public.chat_context_log where created_at < now() - interval '90 days';
  get diagnostics ccl_count = row_count;
  delete from public.pii_scrub_events where created_at < now() - interval '365 days';
  get diagnostics pse_count = row_count;
  delete from public.extraction_failures where created_at < now() - interval '90 days';
  get diagnostics ef_count = row_count;
  if to_regclass('public.search_queries') is not null then
    delete from public.search_queries where created_at < now() - interval '30 days';
    get diagnostics sq_count = row_count; end if;
  if to_regclass('public.voice_profiles') is not null then
    delete from public.voice_profiles where expires_at < now();
    get diagnostics vp_count = row_count; end if;
  if to_regclass('public.cloud_activity') is not null then
    delete from public.cloud_activity where created_at < now() - interval '90 days';
    get diagnostics ca_count = row_count; end if;
  return query select r_count, t_count, d_count, c_count, p_count, a_count, iu_count, iud_count,
    ccl_count, pse_count, ef_count, sq_count, vp_count, ca_count;
end;
$$;