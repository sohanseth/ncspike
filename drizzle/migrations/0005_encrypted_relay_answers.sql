create table if not exists public.relay_answers (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 device_id uuid not null references public.relay_devices(id) on delete cascade,
 key_id text not null, ref text not null, nonce text not null, ciphertext text not null,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now() + interval '3 days')
);
grant all on public.relay_answers to service_role;
revoke all on public.relay_answers from anon, authenticated;
alter table public.relay_answers enable row level security;
create index if not exists relay_answers_device_created_idx on public.relay_answers(device_id,created_at,id);
create index if not exists relay_answers_user_created_idx on public.relay_answers(user_id,created_at);
create table if not exists public.relay_answer_log (
 id bigint generated always as identity primary key,
 user_id uuid not null,
 created_at timestamptz not null default now()
);
grant all on public.relay_answer_log to service_role;
revoke all on public.relay_answer_log from anon, authenticated;
alter table public.relay_answer_log enable row level security;
grant usage, select on sequence public.relay_answer_log_id_seq to service_role;
create index if not exists relay_answer_log_user_created_idx on public.relay_answer_log(user_id,created_at);
create or replace function public.relay_answer_put(p_user uuid, p_device uuid, p_key_id text, p_ref text, p_nonce text, p_ciphertext text) returns jsonb language plpgsql security definer set search_path = public as $$
declare dev relay_devices%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('relay_answer:' || p_user::text));
  select * into dev from relay_devices where id = p_device and user_id = p_user and revoked_at is null for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not exists (select 1 from relay_cards where device_id = p_device and ref = p_ref and key_id = p_key_id and expires_at > now()) then
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

create or replace function public.relay_answers_take(p_device uuid, p_ack uuid[]) returns jsonb language plpgsql security definer set search_path = public as $$
declare got jsonb;
begin
  if not exists (select 1 from relay_devices where id = p_device and revoked_at is null) then
    return jsonb_build_object('status', 'revoked');
  end if;
  delete from relay_answers where device_id = p_device and (id = any(p_ack) or expires_at <= now());
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'keyId', a.key_id, 'ref', a.ref, 'nonce', a.nonce, 'ciphertext', a.ciphertext,
           'createdAt', to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by a.created_at, a.id), '[]'::jsonb)
    into got
    from (select * from relay_answers where device_id = p_device order by created_at, id limit 50) a;
  return jsonb_build_object('status', 'ok', 'answers', got);
end $$;

create or replace function public.relay_revoke(p_device uuid) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update relay_devices set revoked_at = now() where id = p_device and revoked_at is null;
  if not found then
    return false;
  end if;
  delete from relay_cards where device_id = p_device;
  delete from relay_answers where device_id = p_device;
  if to_regclass('public.relay_missions') is not null then
    execute 'delete from agents where id in (select agent_id from relay_missions where device_id = $1)' using p_device;
  end if;
  return true;
end $$;

create or replace function public.cleanup_relay() returns jsonb language plpgsql security definer set search_path = public as $$
declare c int; n int; p int; a int; d int;
begin
  delete from relay_cards where expires_at < now(); get diagnostics c = row_count;
  delete from relay_answers where expires_at < now(); get diagnostics n = row_count;
  delete from relay_answer_log where created_at < now() - interval '1 hour';
  delete from relay_pairing_codes where used_at is not null or expires_at < now(); get diagnostics p = row_count;
  delete from relay_claim_attempts where created_at < now() - interval '1 day'; get diagnostics a = row_count;
  delete from relay_devices where revoked_at < now() - interval '30 days'; get diagnostics d = row_count;
  return jsonb_build_object('cards', c, 'answers', n, 'codes', p, 'attempts', a, 'devices', d);
end $$;
revoke execute on function public.relay_answer_put(uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.relay_answer_put(uuid,uuid,text,text,text,text) to service_role;
revoke execute on function public.relay_answers_take(uuid,uuid[]) from public, anon, authenticated;
grant execute on function public.relay_answers_take(uuid,uuid[]) to service_role;
revoke execute on function public.relay_revoke(uuid) from public, anon, authenticated;
grant execute on function public.relay_revoke(uuid) to service_role;
revoke execute on function public.cleanup_relay() from public, anon, authenticated;
grant execute on function public.cleanup_relay() to service_role;

create or replace function public.delete_relay_answers_for_removed_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
 delete from public.relay_answers where user_id = old.id;
 delete from public.relay_answer_log where user_id = old.id;
 return old;
end $$;
revoke execute on function public.delete_relay_answers_for_removed_user() from public, anon, authenticated;
do $$ begin
 if not exists (select 1 from pg_trigger where tgname = 'delete_relay_answers_for_removed_user' and tgrelid = 'auth.users'::regclass) then
 create trigger delete_relay_answers_for_removed_user after delete on auth.users for each row execute function public.delete_relay_answers_for_removed_user();
 end if;
end $$;
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
  delete from public.relay_answers where user_id = target_user_id;
  delete from public.relay_answer_log where user_id = target_user_id;
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