-- Phase 2.7 D8: Context Broker & Trait Sheet schema (idempotent apply).

create table if not exists public.user_traits (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  version      int  not null default 1,
  sheet        jsonb not null,
  derived_at   timestamptz not null default now(),
  source_count int  not null default 0,
  updated_at   timestamptz not null default now()
);

create table if not exists public.chat_context_log (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  message_id          uuid not null references public.chat_messages(id) on delete cascade,
  badge               text not null check (badge in ('flash','pro','genius','private')),
  strictest_tier      int  not null check (strictest_tier between 0 and 3),
  categories_used     text[] not null default '{}',
  fragment_length     int  not null default 0,
  scrub_blocked       boolean not null default false,
  trait_sheet_version int,
  created_at          timestamptz not null default now()
);
create index if not exists chat_context_log_user_day_idx
  on public.chat_context_log(user_id, created_at);
create index if not exists chat_context_log_message_idx
  on public.chat_context_log(message_id);

create table if not exists public.user_trait_blocks (
  user_id       uuid not null references auth.users(id) on delete cascade,
  category      text not null,
  trait_path    text not null,
  blocked_until timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, category, trait_path)
);

create table if not exists public.user_provider_category_blocks (
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider_tier int  not null check (provider_tier between 0 and 3),
  category      text not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, provider_tier, category)
);

create table if not exists public.user_known_names (
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null,
  source   text not null check (source in ('contacts','calendar','email_sender','manual')),
  added_at timestamptz not null default now(),
  primary key (user_id, name)
);

create table if not exists public.pii_scrub_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  category      text,
  pattern_class text not null check (pattern_class in (
    'email','phone','postal','credit_card','name_match',
    'exact_age','gov_id','employer_heuristic','injection_sentinel'
  )),
  badge         text,
  provider_tier int,
  occurred_at   timestamptz not null default now()
);
create index if not exists pii_scrub_events_user_day_idx
  on public.pii_scrub_events(user_id, occurred_at);

create table if not exists public.extraction_failures (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  category      text,
  failure_class text not null check (failure_class in (
    'zod_reject','llm_no_response','embedding_failed','injection_pattern'
  )),
  field_path    text,
  occurred_at   timestamptz not null default now()
);
create index if not exists extraction_failures_user_day_idx
  on public.extraction_failures(user_id, occurred_at);

alter table public.chat_messages
  add column if not exists context_used        jsonb,
  add column if not exists trait_sheet_version int;

alter table public.user_settings
  add column if not exists personalization_v1_enabled boolean not null default false,
  add column if not exists oss_only_mode              boolean not null default false,
  add column if not exists private_only_mode          boolean not null default false;

alter table public.user_traits enable row level security;
drop policy if exists "own traits select" on public.user_traits;
create policy "own traits select" on public.user_traits
  for select using (auth.uid() = user_id);

alter table public.chat_context_log enable row level security;
drop policy if exists "own context log select" on public.chat_context_log;
create policy "own context log select" on public.chat_context_log
  for select using (auth.uid() = user_id);

alter table public.user_trait_blocks enable row level security;
drop policy if exists "own trait blocks select" on public.user_trait_blocks;
create policy "own trait blocks select" on public.user_trait_blocks
  for select using (auth.uid() = user_id);
drop policy if exists "own trait blocks insert" on public.user_trait_blocks;
create policy "own trait blocks insert" on public.user_trait_blocks
  for insert with check (auth.uid() = user_id);
drop policy if exists "own trait blocks delete" on public.user_trait_blocks;
create policy "own trait blocks delete" on public.user_trait_blocks
  for delete using (auth.uid() = user_id);

alter table public.user_provider_category_blocks enable row level security;
drop policy if exists "own provider blocks select" on public.user_provider_category_blocks;
create policy "own provider blocks select" on public.user_provider_category_blocks
  for select using (auth.uid() = user_id);
drop policy if exists "own provider blocks insert" on public.user_provider_category_blocks;
create policy "own provider blocks insert" on public.user_provider_category_blocks
  for insert with check (auth.uid() = user_id);
drop policy if exists "own provider blocks delete" on public.user_provider_category_blocks;
create policy "own provider blocks delete" on public.user_provider_category_blocks
  for delete using (auth.uid() = user_id);

alter table public.user_known_names enable row level security;
drop policy if exists "own known names select" on public.user_known_names;
create policy "own known names select" on public.user_known_names
  for select using (auth.uid() = user_id);

alter table public.pii_scrub_events enable row level security;
drop policy if exists "own scrub events select" on public.pii_scrub_events;
create policy "own scrub events select" on public.pii_scrub_events
  for select using (auth.uid() = user_id);

alter table public.extraction_failures enable row level security;
drop policy if exists "own extraction failures select" on public.extraction_failures;
create policy "own extraction failures select" on public.extraction_failures
  for select using (auth.uid() = user_id);

create or replace function public.import_known_names(
  p_user_id uuid,
  p_names   text[],
  p_source  text
) returns table (inserted int, capped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap        constant int := 1000;
  v_existing   int;
  v_remaining  int;
  v_to_insert  text[];
  v_inserted   int;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'forbidden: cannot import names for another user';
  end if;
  if p_source not in ('contacts','calendar','email_sender','manual') then
    raise exception 'invalid source: %', p_source;
  end if;
  perform 1 from user_known_names where user_id = p_user_id for update;
  select count(*) into v_existing
    from user_known_names where user_id = p_user_id;
  v_remaining := greatest(0, v_cap - v_existing);
  if v_remaining = 0 or coalesce(array_length(p_names, 1), 0) = 0 then
    return query select 0::int, (coalesce(array_length(p_names, 1), 0) > 0);
    return;
  end if;
  v_to_insert := p_names[1 : v_remaining];
  with new_rows as (
    insert into user_known_names (user_id, name, source)
    select p_user_id, n, p_source
      from unnest(v_to_insert) as t(n)
    on conflict (user_id, name) do nothing
    returning 1
  )
  select count(*)::int into v_inserted from new_rows;
  return query select
    v_inserted,
    (coalesce(array_length(p_names, 1), 0) > v_remaining);
end;
$$;

grant execute on function public.import_known_names(uuid, text[], text) to authenticated;
revoke execute on function public.import_known_names(uuid, text[], text) from anon;

notify pgrst, 'reload schema';
