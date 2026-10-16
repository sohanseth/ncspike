-- Applied from supabase/migrations/20261016091000_encrypted_mac_relay.sql
create table if not exists public.relay_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
grant all on public.relay_pairing_codes to service_role;
revoke all on public.relay_pairing_codes from public, anon, authenticated;
alter table public.relay_pairing_codes enable row level security;
create table if not exists public.relay_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_seq bigint not null default 0,
  revoked_at timestamptz
);
grant all on public.relay_devices to service_role;
revoke all on public.relay_devices from public, anon, authenticated;
alter table public.relay_devices enable row level security;
create table if not exists public.relay_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  device_id uuid not null references public.relay_devices(id) on delete cascade,
  ref text not null,
  key_id text not null,
  nonce text not null,
  ciphertext text not null,
  ord int not null default 0,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (device_id, ref)
);
grant all on public.relay_cards to service_role;
revoke all on public.relay_cards from public, anon, authenticated;
alter table public.relay_cards enable row level security;
create table if not exists public.relay_claim_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  ok boolean not null,
  created_at timestamptz not null default now()
);
grant all on public.relay_claim_attempts to service_role;
revoke all on public.relay_claim_attempts from public, anon, authenticated;
alter table public.relay_claim_attempts enable row level security;
grant usage, select on sequence public.relay_claim_attempts_id_seq to service_role;
revoke all on sequence public.relay_claim_attempts_id_seq from public, anon, authenticated;
do $$ declare p record; begin
  for p in select tablename, policyname from pg_policies where schemaname = 'public'
    and tablename in ('relay_pairing_codes','relay_devices','relay_cards','relay_claim_attempts')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create index if not exists relay_claim_attempts_ip_created on public.relay_claim_attempts (ip_hash, created_at);
create index if not exists relay_claim_attempts_created on public.relay_claim_attempts (created_at);
create index if not exists relay_cards_owner_expires on public.relay_cards (user_id, expires_at);
create index if not exists relay_devices_owner on public.relay_devices (user_id);
create index if not exists relay_pairing_codes_owner on public.relay_pairing_codes (user_id);
create or replace function public.relay_claim(p_ip_hash text, p_code_hash text) returns jsonb language plpgsql security definer set search_path = public as $$
declare mine int; failed int; uid uuid;
begin
  perform pg_advisory_xact_lock(hashtext('relay_claim:' || p_ip_hash));
  select count(*) into mine from relay_claim_attempts where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
  select count(*) into failed from relay_claim_attempts where not ok and created_at > now() - interval '10 minutes';
  if mine >= 10 or failed >= 2000 then
    return jsonb_build_object('status', 'limited');
  end if;
  update relay_pairing_codes set used_at = now()
    where code_hash = p_code_hash and used_at is null and expires_at > now()
    returning user_id into uid;
  insert into relay_claim_attempts (ip_hash, ok) values (p_ip_hash, uid is not null);
  if uid is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  return jsonb_build_object('status', 'ok', 'user_id', uid);
end $$;
create or replace function public.relay_publish(p_device uuid, p_seq bigint, p_key_id text, p_rows jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare dev relay_devices%rowtype;
begin
  select * into dev from relay_devices where id = p_device and revoked_at is null for update;
  if not found then
    return jsonb_build_object('status', 'revoked');
  end if;
  if p_seq <= dev.last_seq then
    return jsonb_build_object('status', 'stale', 'lastSeq', dev.last_seq);
  end if;
  delete from relay_cards where device_id = p_device
    and ref not in (select r->>'ref' from jsonb_array_elements(p_rows) r);
  insert into relay_cards (user_id, device_id, ref, key_id, nonce, ciphertext, ord, expires_at, updated_at)
    select dev.user_id, p_device, r->>'ref', p_key_id, r->>'nonce', r->>'ciphertext', (r->>'order')::int, (r->>'expiresAt')::timestamptz, now()
    from jsonb_array_elements(p_rows) r
  on conflict (device_id, ref) do update set key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
    ord = excluded.ord, expires_at = excluded.expires_at, updated_at = now();
  update relay_devices set last_seen_at = now(), last_seq = p_seq where id = p_device;
  return jsonb_build_object('status', 'ok', 'stored', jsonb_array_length(p_rows));
end $$;
create or replace function public.relay_revoke(p_device uuid) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update relay_devices set revoked_at = now() where id = p_device and revoked_at is null;
  if not found then
    return false;
  end if;
  delete from relay_cards where device_id = p_device;
  return true;
end $$;
create or replace function public.cleanup_relay() returns jsonb language plpgsql security definer set search_path = public as $$
declare c int; p int; a int; d int;
begin
  delete from relay_cards where expires_at < now(); get diagnostics c = row_count;
  delete from relay_pairing_codes where used_at is not null or expires_at < now(); get diagnostics p = row_count;
  delete from relay_claim_attempts where created_at < now() - interval '1 day'; get diagnostics a = row_count;
  delete from relay_devices where revoked_at < now() - interval '30 days'; get diagnostics d = row_count;
  return jsonb_build_object('cards', c, 'codes', p, 'attempts', a, 'devices', d);
end $$;
revoke execute on function public.relay_claim(text, text) from public, anon, authenticated;
grant execute on function public.relay_claim(text, text) to service_role;
revoke execute on function public.relay_publish(uuid, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.relay_publish(uuid, bigint, text, jsonb) to service_role;
revoke execute on function public.relay_revoke(uuid) from public, anon, authenticated;
grant execute on function public.relay_revoke(uuid) to service_role;
revoke execute on function public.cleanup_relay() from public, anon, authenticated;
grant execute on function public.cleanup_relay() to service_role;
create or replace function public.delete_relay_for_removed_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.relay_cards where user_id = old.id;
  delete from public.relay_devices where user_id = old.id;
  delete from public.relay_pairing_codes where user_id = old.id;
  return old;
end $$;
revoke execute on function public.delete_relay_for_removed_user() from public, anon, authenticated;
grant execute on function public.delete_relay_for_removed_user() to service_role;
drop trigger if exists delete_relay_for_removed_user on auth.users;
create trigger delete_relay_for_removed_user after delete on auth.users
for each row execute function public.delete_relay_for_removed_user();
drop function if exists public.delete_user_data(uuid);
create or replace function public.delete_user_data(target_user_id uuid)
returns table (chat_messages_deleted int, chat_threads_deleted int, chat_context_log_deleted int, pii_scrub_events_deleted int, extraction_failures_deleted int, user_trait_blocks_deleted int, user_provider_category_blocks_del int, user_known_names_deleted int, user_traits_deleted int, memory_edges_deleted int, memory_nodes_deleted int, inference_usage_deleted int, inference_usage_daily_deleted int, user_settings_deleted int, chat_message_attachments_deleted int, search_queries_deleted int, agent_findings_deleted int, agent_state_deleted int, agent_runs_deleted int, agents_deleted int, relay_cards_deleted int, relay_devices_deleted int, relay_pairing_codes_deleted int)
language plpgsql security definer set search_path = public as $$
declare cm_count int := 0; ct_count int := 0; ccl_count int := 0; pse_count int := 0; ef_count int := 0; utb_count int := 0; upcb_count int := 0; ukn_count int := 0; ut_count int := 0; me_count int := 0; mn_count int := 0; iu_count int := 0; iud_count int := 0; us_count int := 0; cma_count int := 0; sq_count int := 0; af_count int := 0; ast_count int := 0; ar_count int := 0; ag_count int := 0; rc_count int := 0; rd_count int := 0; rp_count int := 0;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then raise exception 'forbidden: caller cannot delete another user''s data'; end if;
  if to_regclass('public.chat_message_attachments') is not null then delete from public.chat_message_attachments where user_id = target_user_id; get diagnostics cma_count = row_count; end if;
  if to_regclass('public.chat_messages') is not null then delete from public.chat_messages where user_id = target_user_id; get diagnostics cm_count = row_count; end if;
  if to_regclass('public.chat_threads') is not null then delete from public.chat_threads where user_id = target_user_id; get diagnostics ct_count = row_count; end if;
  delete from public.chat_context_log where user_id = target_user_id; get diagnostics ccl_count = row_count;
  delete from public.pii_scrub_events where user_id = target_user_id; get diagnostics pse_count = row_count;
  delete from public.extraction_failures where user_id = target_user_id; get diagnostics ef_count = row_count;
  delete from public.user_trait_blocks where user_id = target_user_id; get diagnostics utb_count = row_count;
  delete from public.user_provider_category_blocks where user_id = target_user_id; get diagnostics upcb_count = row_count;
  delete from public.user_known_names where user_id = target_user_id; get diagnostics ukn_count = row_count;
  delete from public.user_traits where user_id = target_user_id; get diagnostics ut_count = row_count;
  if to_regclass('public.memory_edges') is not null then delete from public.memory_edges where user_id = target_user_id; get diagnostics me_count = row_count; end if;
  if to_regclass('public.memory_nodes') is not null then delete from public.memory_nodes where user_id = target_user_id; get diagnostics mn_count = row_count; end if;
  if to_regclass('public.inference_usage') is not null then delete from public.inference_usage where user_id = target_user_id; get diagnostics iu_count = row_count; end if;
  if to_regclass('public.inference_usage_daily') is not null then delete from public.inference_usage_daily where user_id = target_user_id; get diagnostics iud_count = row_count; end if;
  if to_regclass('public.user_settings') is not null then delete from public.user_settings where user_id = target_user_id; get diagnostics us_count = row_count; end if;
  if to_regclass('public.search_queries') is not null then delete from public.search_queries where user_id = target_user_id; get diagnostics sq_count = row_count; end if;
  if to_regclass('public.agent_findings') is not null then delete from public.agent_findings where user_id = target_user_id; get diagnostics af_count = row_count; end if;
  if to_regclass('public.agent_state') is not null then delete from public.agent_state where user_id = target_user_id; get diagnostics ast_count = row_count; end if;
  if to_regclass('public.agent_runs') is not null then delete from public.agent_runs where user_id = target_user_id; get diagnostics ar_count = row_count; end if;
  if to_regclass('public.agents') is not null then delete from public.agents where user_id = target_user_id; get diagnostics ag_count = row_count; end if;
  delete from public.relay_cards where user_id = target_user_id; get diagnostics rc_count = row_count;
  delete from public.relay_devices where user_id = target_user_id; get diagnostics rd_count = row_count;
  delete from public.relay_pairing_codes where user_id = target_user_id; get diagnostics rp_count = row_count;
  return query select cm_count, ct_count, ccl_count, pse_count, ef_count, utb_count, upcb_count, ukn_count, ut_count, me_count, mn_count, iu_count, iud_count, us_count, cma_count, sq_count, af_count, ast_count, ar_count, ag_count, rc_count, rd_count, rp_count;
end; $$;
revoke all on function public.delete_user_data(uuid) from public;
grant execute on function public.delete_user_data(uuid) to authenticated, service_role;