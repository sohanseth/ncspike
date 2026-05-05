-- Enums
create type public.storage_mode as enum ('standard', 'private', 'sovereign');
create type public.ai_mode as enum ('hosted_proprietary', 'hosted_oss', 'byo');
create type public.connection_provider as enum ('gmail', 'google_calendar', 'google_drive', 'slack', 'notion', 'outlook', 'whatsapp');
create type public.node_type as enum ('person', 'project', 'product', 'preference', 'priority', 'event', 'note', 'thread', 'other');
create type public.message_role as enum ('system', 'user', 'assistant', 'tool');

-- profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own profile read" on public.profiles for select using (auth.uid() = id);
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);

-- user_settings
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  storage_mode public.storage_mode not null default 'standard',
  ai_mode public.ai_mode not null default 'hosted_proprietary',
  preferred_model text not null default 'google/gemini-3-flash-preview',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
create policy "own settings all" on public.user_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- user_endpoints (sovereign mode — encrypted at app layer)
create table public.user_endpoints (
  user_id uuid primary key references auth.users(id) on delete cascade,
  db_url_encrypted text,
  model_url_encrypted text,
  model_key_encrypted text,
  updated_at timestamptz not null default now()
);
alter table public.user_endpoints enable row level security;
create policy "own endpoints all" on public.user_endpoints for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- connections (per-user OAuth tokens, encrypted at app layer)
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider public.connection_provider not null,
  account_label text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider, account_label)
);
alter table public.connections enable row level security;
create policy "own connections all" on public.connections for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- memory_nodes
create table public.memory_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  node_type public.node_type not null,
  label text not null,
  data jsonb not null default '{}'::jsonb,
  source text,
  importance smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.memory_nodes(user_id);
create index on public.memory_nodes(user_id, node_type);
alter table public.memory_nodes enable row level security;
create policy "own nodes all" on public.memory_nodes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- memory_edges
create table public.memory_edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_node uuid not null references public.memory_nodes(id) on delete cascade,
  to_node uuid not null references public.memory_nodes(id) on delete cascade,
  relation text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.memory_edges(user_id);
create index on public.memory_edges(from_node);
create index on public.memory_edges(to_node);
alter table public.memory_edges enable row level security;
create policy "own edges all" on public.memory_edges for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- chat_threads
create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.chat_threads(user_id, updated_at desc);
alter table public.chat_threads enable row level security;
create policy "own threads all" on public.chat_threads for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- chat_messages
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.message_role not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.chat_messages(thread_id, created_at);
alter table public.chat_messages enable row level security;
create policy "own messages all" on public.chat_messages for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- watchers
create table public.watchers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  target text not null,
  rule jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_result jsonb,
  created_at timestamptz not null default now()
);
create index on public.watchers(user_id);
alter table public.watchers enable row level security;
create policy "own watchers all" on public.watchers for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- updated_at trigger
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger profiles_set_updated before update on public.profiles for each row execute function public.tg_set_updated_at();
create trigger user_settings_set_updated before update on public.user_settings for each row execute function public.tg_set_updated_at();
create trigger user_endpoints_set_updated before update on public.user_endpoints for each row execute function public.tg_set_updated_at();
create trigger connections_set_updated before update on public.connections for each row execute function public.tg_set_updated_at();
create trigger memory_nodes_set_updated before update on public.memory_nodes for each row execute function public.tg_set_updated_at();
create trigger chat_threads_set_updated before update on public.chat_threads for each row execute function public.tg_set_updated_at();

-- Auto-create profile + settings on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)), new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();