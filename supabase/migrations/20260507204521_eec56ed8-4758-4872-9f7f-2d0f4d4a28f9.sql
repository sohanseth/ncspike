create table if not exists public.research_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_id text not null,
  input jsonb not null default '{}'::jsonb,
  input_key text not null,
  status text not null default 'pending'
    check (status in ('pending','running','done','error','cancelled')),
  priority int not null default 100,
  source text not null default 'manual'
    check (source in ('auto','manual','system')),
  source_context text,
  scheduled_for timestamptz not null default now(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text,
  read_at timestamptz
);

create index if not exists research_tasks_user_due_idx
  on public.research_tasks (user_id, priority, scheduled_for)
  where status = 'pending';

create index if not exists research_tasks_user_briefing_idx
  on public.research_tasks (user_id, completed_at desc)
  where status = 'done' and read_at is null;

create unique index if not exists research_tasks_dedupe_idx
  on public.research_tasks (user_id, tool_id, input_key)
  where status in ('pending','running');

alter table public.research_tasks enable row level security;

create policy "own research tasks all" on public.research_tasks
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);