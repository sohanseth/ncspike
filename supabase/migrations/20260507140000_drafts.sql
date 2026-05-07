-- Slice B / Week 2: drafts table
-- Stores generated reply drafts. Body is encrypted at the application
-- layer using the same envelope as OAuth tokens (crypto.server.ts).

create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The memory_node representing the email being replied to.
  source_node_id uuid references public.memory_nodes(id) on delete set null,
  -- One of: 'acknowledge' | 'decline' | 'schedule' | 'ask_info' | 'confirm'
  template text not null check (template in ('acknowledge', 'decline', 'schedule', 'ask_info', 'confirm')),
  -- Encrypted draft body.
  body_encrypted text not null,
  -- Plaintext char count of the *original* generated body — denominator for the EDTS metric.
  -- Must NOT be overwritten on send; if it changes, EDTS reporting is invalid.
  chars_in_draft int not null default 0 check (chars_in_draft >= 0),
  -- Populated on send. NULL while pending.
  chars_edited int check (chars_edited is null or chars_edited >= 0),
  -- Lifecycle.
  status text not null default 'pending' check (status in ('pending', 'sent', 'dismissed', 'edited_then_sent')),
  -- Templates already tried, so regenerate can rotate.
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
