-- Phase 2 leftovers: rate-limit table + retention TTL.
--
-- 1) tool_invocations: append-only ledger for sliding-window rate limiting of
--    agent-tool calls. We can't rely on in-memory counters on the edge runtime
--    (multi-instance, no shared state), so we count rows in the last N minutes
--    instead. Cheap because the table is partitioned-by-time logically (we
--    delete rows older than the longest window we ever check).
create table if not exists public.tool_invocations (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  tool_id     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists tool_invocations_user_tool_time_idx
  on public.tool_invocations (user_id, tool_id, created_at desc);

alter table public.tool_invocations enable row level security;

-- Users can only see their own invocations (we write via service role).
create policy "own tool_invocations select" on public.tool_invocations
  for select using (auth.uid() = user_id);

-- 2) Retention: completed/error/cancelled research_tasks older than 30 days
--    and tool_invocations older than 7 days. Called from the nightly cron so
--    the table doesn't grow forever. Returns counts for observability.
create or replace function public.cleanup_phase2_retention()
returns table (research_tasks_deleted int, tool_invocations_deleted int)
language plpgsql
security definer
set search_path = public
as $$
declare
  r_count int;
  t_count int;
begin
  delete from public.research_tasks
   where status in ('done','error','cancelled')
     and completed_at is not null
     and completed_at < now() - interval '30 days';
  get diagnostics r_count = row_count;

  delete from public.tool_invocations
   where created_at < now() - interval '7 days';
  get diagnostics t_count = row_count;

  return query select r_count, t_count;
end;
$$;

revoke all on function public.cleanup_phase2_retention() from public;
grant execute on function public.cleanup_phase2_retention() to service_role;
