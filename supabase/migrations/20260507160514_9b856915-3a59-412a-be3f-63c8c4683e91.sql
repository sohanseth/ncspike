
create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_node_id uuid references public.memory_nodes(id) on delete set null,
  template text not null check (template in ('acknowledge', 'decline', 'schedule', 'ask_info', 'confirm')),
  body_encrypted text not null,
  chars_in_draft int not null default 0 check (chars_in_draft >= 0),
  chars_edited int check (chars_edited is null or chars_edited >= 0),
  status text not null default 'pending' check (status in ('pending', 'sent', 'dismissed', 'edited_then_sent')),
  templates_tried text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists drafts_user_status_idx on public.drafts(user_id, status, created_at desc);
create index if not exists drafts_source_node_idx on public.drafts(source_node_id);

alter table public.drafts enable row level security;

create policy "own drafts all" on public.drafts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.user_settings
  add column if not exists voice_drafts_consent_at timestamptz;
