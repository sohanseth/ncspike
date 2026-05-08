-- Phase 2.6 — Chat Wiring & Multi-Provider Smart Routing (D7)

alter table public.chat_messages
  add column if not exists badge          text check (badge in ('flash','pro','genius','private')),
  add column if not exists provider       text,
  add column if not exists model          text,
  add column if not exists fallback_depth int;

create table if not exists public.inference_usage (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  thread_id       uuid,
  badge           text not null check (badge in ('flash','pro','genius','private')),
  provider_chain  text[] not null,
  provider_used   text not null,
  model_used      text,
  fallback_depth  int  not null default 0,
  input_tokens    int,
  output_tokens   int,
  cost_micro_usd  bigint,
  latency_ms      int,
  status          text not null check (status in ('ok','rate_limited','error','user_abort','cap_exceeded')),
  error_class     text,
  started_at      timestamptz not null default now()
);

create index if not exists inference_usage_user_day_idx
  on public.inference_usage(user_id, started_at);
create index if not exists inference_usage_user_badge_day_idx
  on public.inference_usage(user_id, badge, started_at);

alter table public.inference_usage enable row level security;

create policy "own usage select" on public.inference_usage
  for select using (auth.uid() = user_id);