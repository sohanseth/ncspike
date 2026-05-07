-- Overnight research queue: persistent task list for the deep-research agent.
-- Throughout the day, the app (or the user) enqueues research tasks. A batch
-- runner — invoked manually now, by a Cloudflare Worker cron later — pulls
-- due `pending` rows and dispatches them via the existing AGENT_TOOLS
-- registry. Results land back in the same row for a morning briefing.
--
-- Design notes:
--   * `tool_id` references the in-code AGENT_TOOLS map; no FK because the
--     registry lives in TypeScript, not SQL. Validation happens at enqueue.
--   * `input_key` is a canonical-JSON serialization used for dedupe so the
--     same research request isn't queued twice while still pending/running.
--   * `priority` is "lower runs first" (classic queue convention). Default 100
--     leaves room above and below for system-injected high/low priority work.
--   * `scheduled_for` lets us defer manual "research overnight" requests to a
--     wee-hours run while still allowing immediate execution by setting it to
--     `now()`.

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

-- Pending due-work lookup (the batch runner's hot path).
create index if not exists research_tasks_user_due_idx
  on public.research_tasks (user_id, priority, scheduled_for)
  where status = 'pending';

-- Morning briefing: completed but unread, newest first.
create index if not exists research_tasks_user_briefing_idx
  on public.research_tasks (user_id, completed_at desc)
  where status = 'done' and read_at is null;

-- Dedupe: at most one in-flight task per (user, tool, canonical-input).
-- Done/error/cancelled rows are excluded so the user can re-research later.
create unique index if not exists research_tasks_dedupe_idx
  on public.research_tasks (user_id, tool_id, input_key)
  where status in ('pending','running');

alter table public.research_tasks enable row level security;

create policy "own research tasks all" on public.research_tasks
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
