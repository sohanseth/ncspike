-- Slice B / Week 1: voice_profiles table
-- Stores a deterministic structural summary of a user's writing voice,
-- derived from their last N sent messages. JSON values are encrypted at
-- the application layer via crypto.server.ts (same envelope as OAuth tokens).

create table if not exists public.voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Plaintext metadata used for cache decisions / UI display.
  sample_count int not null default 0,
  built_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  -- Encrypted JSON blob — see VoiceProfile type in src/server/voice-profile.server.ts
  profile_encrypted text,
  -- One profile per user (V1).
  unique(user_id)
);

create index if not exists voice_profiles_user_id_idx on public.voice_profiles(user_id);

alter table public.voice_profiles enable row level security;

create policy "own voice profile all" on public.voice_profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
