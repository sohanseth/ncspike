create table if not exists public.voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sample_count int not null default 0,
  built_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  profile_encrypted text,
  unique(user_id)
);

create index if not exists voice_profiles_user_id_idx on public.voice_profiles(user_id);

alter table public.voice_profiles enable row level security;

drop policy if exists "own voice profile all" on public.voice_profiles;
create policy "own voice profile all" on public.voice_profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);