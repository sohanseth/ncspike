alter table public.relay_devices add column if not exists lists_seq bigint not null default 0;
create table if not exists public.relay_lists (
 device_id uuid primary key references public.relay_devices(id) on delete cascade,
 user_id uuid not null,
 key_id text not null, nonce text not null, ciphertext text not null,
 refs text[] not null, seq bigint not null, expires_at timestamptz not null,
 updated_at timestamptz not null default now()
);
grant all on public.relay_lists to service_role;
alter table public.relay_lists enable row level security;
revoke all on public.relay_lists from anon, authenticated;
create index if not exists relay_lists_user_id_idx on public.relay_lists(user_id);
create or replace function public.relay_lists_put(p_device uuid, p_seq bigint, p_key_id text, p_nonce text, p_ciphertext text, p_refs text[], p_expires timestamptz) returns jsonb language plpgsql security definer set search_path = public as $$
declare dev relay_devices%rowtype;
begin
  select * into dev from relay_devices where id = p_device and revoked_at is null for update;
  if not found then
    return jsonb_build_object('status', 'revoked');
  end if;
  if p_seq <= dev.lists_seq then
    return jsonb_build_object('status', 'stale', 'lastSeq', dev.lists_seq);
  end if;
  insert into relay_lists (device_id, user_id, key_id, nonce, ciphertext, refs, seq, expires_at, updated_at)
    values (p_device, dev.user_id, p_key_id, p_nonce, p_ciphertext, p_refs, p_seq, p_expires, now())
  on conflict (device_id) do update set key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
    refs = excluded.refs, seq = excluded.seq, expires_at = excluded.expires_at, updated_at = now();
  update relay_devices set lists_seq = p_seq where id = p_device;
  return jsonb_build_object('status', 'ok');
end $$;
create or replace function public.relay_lists_delete(p_device uuid) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform 1 from relay_devices where id = p_device and revoked_at is null for update;
  if not found then
    return jsonb_build_object('status', 'revoked');
  end if;
  delete from relay_lists where device_id = p_device;
  return jsonb_build_object('status', 'ok');
end $$;
create or replace function public.relay_answer_put(p_user uuid, p_device uuid, p_key_id text, p_ref text, p_nonce text, p_ciphertext text) returns jsonb language plpgsql security definer set search_path = public as $$
declare dev relay_devices%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('relay_answer:' || p_user::text));
  select * into dev from relay_devices where id = p_device and user_id = p_user and revoked_at is null for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not exists (select 1 from relay_cards where device_id = p_device and ref = p_ref and key_id = p_key_id and expires_at > now())
     and not exists (select 1 from relay_lists where device_id = p_device and key_id = p_key_id and expires_at > now() and p_ref = any(refs)) then
    return jsonb_build_object('status', 'not_found');
  end if;
  delete from relay_answer_log where user_id = p_user and created_at <= now() - interval '1 hour';
  if (select count(*) from relay_answer_log where user_id = p_user) >= 60
     or (select count(*) from relay_answers where device_id = p_device and expires_at > now()) >= 200 then
    return jsonb_build_object('status', 'too_many');
  end if;
  insert into relay_answers (user_id, device_id, key_id, ref, nonce, ciphertext) values (p_user, p_device, p_key_id, p_ref, p_nonce, p_ciphertext);
  insert into relay_answer_log (user_id) values (p_user);
  return jsonb_build_object('status', 'ok');
end $$;
create or replace function public.relay_revoke(p_device uuid) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update relay_devices set revoked_at = now() where id = p_device and revoked_at is null;
  if not found then
    return false;
  end if;
  delete from relay_cards where device_id = p_device;
  delete from relay_answers where device_id = p_device;
  delete from relay_lists where device_id = p_device;
  if to_regclass('public.relay_missions') is not null then
    execute 'delete from agents where id in (select agent_id from relay_missions where device_id = $1)' using p_device;
  end if;
  return true;
end $$;
create or replace function public.cleanup_relay() returns jsonb language plpgsql security definer set search_path = public as $$
declare c int; n int; l int; p int; a int; d int;
begin
  delete from relay_cards where expires_at < now(); get diagnostics c = row_count;
  delete from relay_answers where expires_at < now(); get diagnostics n = row_count;
  delete from relay_lists where expires_at < now(); get diagnostics l = row_count;
  delete from relay_answer_log where created_at < now() - interval '1 hour';
  delete from relay_pairing_codes where used_at is not null or expires_at < now(); get diagnostics p = row_count;
  delete from relay_claim_attempts where created_at < now() - interval '1 day'; get diagnostics a = row_count;
  delete from relay_devices where revoked_at < now() - interval '30 days'; get diagnostics d = row_count;
  return jsonb_build_object('cards', c, 'answers', n, 'lists', l, 'codes', p, 'attempts', a, 'devices', d);
end $$;
create or replace function public.relay_lists_for(p_user uuid) returns table (device_id uuid, key_id text, nonce text, ciphertext text, expires_at timestamptz, updated_at timestamptz) language sql security definer set search_path = public as $$
  select l.device_id, l.key_id, l.nonce, l.ciphertext, l.expires_at, l.updated_at
    from relay_lists l join relay_devices d on d.id = l.device_id
   where l.user_id = p_user and d.user_id = p_user and d.revoked_at is null and l.expires_at > now()
   order by d.last_seen_at desc nulls last, l.updated_at desc;
$$;
revoke execute on function public.relay_lists_put(uuid,bigint,text,text,text,text[],timestamptz) from public, anon, authenticated;
grant execute on function public.relay_lists_put(uuid,bigint,text,text,text,text[],timestamptz) to service_role;
revoke execute on function public.relay_lists_delete(uuid) from public, anon, authenticated;
grant execute on function public.relay_lists_delete(uuid) to service_role;
revoke execute on function public.relay_answer_put(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.relay_answer_put(uuid,uuid,text,text,text,text) to service_role;
revoke execute on function public.relay_revoke(uuid) from public, anon, authenticated;
grant execute on function public.relay_revoke(uuid) to service_role;
revoke execute on function public.cleanup_relay() from public, anon, authenticated;
grant execute on function public.cleanup_relay() to service_role;
revoke execute on function public.relay_lists_for(uuid) from public, anon, authenticated;
grant execute on function public.relay_lists_for(uuid) to service_role;
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
  cloud_consents_deleted integer, cloud_activity_deleted integer, relay_answers_deleted integer, relay_answer_log_deleted integer
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
  ue_count int := 0; w_count int := 0; cc_count int := 0; ca_count int := 0; ra_count int := 0; ral_count int := 0;
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
  delete from public.relay_lists where user_id = target_user_id;
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
  delete from public.relay_answers where user_id = target_user_id; get diagnostics ra_count = row_count;
  delete from public.relay_answer_log where user_id = target_user_id; get diagnostics ral_count = row_count;
  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count, utb_count, upcb_count,
    ukn_count, ut_count, me_count, mn_count, iu_count, iud_count, us_count,
    cma_count, sq_count, af_count, ast_count, ar_count, ag_count, rc_count,
    rd_count, rp_count, conn_count, dr_count, vp_count, rt_count, ue_count,
    w_count, cc_count, ca_count, ra_count, ral_count;
end;
$$;
revoke execute on function public.delete_user_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_user_data(uuid) to service_role;