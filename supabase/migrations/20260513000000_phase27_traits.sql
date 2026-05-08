-- Phase 2.7 D8: Context Broker & Trait Sheet schema.
-- Spec: docs/06-spec-phase-2.7-context-broker.md §6.
--
-- One canonical trait sheet per user (PK on user_id, UPSERT on extraction).
-- Per-request broker decisions logged AFTER assistant message persistence so
-- the message_id FK is always resolvable (spec §4 step 8a).

-- ─── 1. user_traits ──────────────────────────────────────────────────────────
-- One row per user, ever. Updates overwrite via `insert ... on conflict do update`.
-- `version` is a monotonic counter inside the single row, used for audit linkage
-- from chat_context_log.trait_sheet_version. No prior versions retained.
create table if not exists public.user_traits (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  version      int  not null default 1,
  sheet        jsonb not null,
  derived_at   timestamptz not null default now(),
  source_count int  not null default 0,
  updated_at   timestamptz not null default now()
);

-- ─── 2. chat_context_log ─────────────────────────────────────────────────────
-- Per-request audit of what the broker decided to inject. FK to chat_messages
-- (the assistant row) is always resolvable because we write this in step 8a,
-- AFTER the assistant message is persisted in step 8.
-- We log fragment LENGTH only — never the fragment text itself, since trait
-- contents are sensitive enough to keep out of audit logs.
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

-- ─── 3. user_trait_blocks ────────────────────────────────────────────────────
-- "Forget this trait" actions from the ContextFooter. Extractor refuses to
-- recreate matching traits while blocked_until > now().
create table if not exists public.user_trait_blocks (
  user_id       uuid not null references auth.users(id) on delete cascade,
  category      text not null,
  trait_path    text not null,
  blocked_until timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, category, trait_path)
);

-- ─── 4. user_provider_category_blocks ────────────────────────────────────────
-- Per-tier per-category opt-outs from the personalization settings matrix.
-- Note: provider_tier (not provider_id) — matches B4's "matrix has fewer rows".
create table if not exists public.user_provider_category_blocks (
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider_tier int  not null check (provider_tier between 0 and 3),
  category      text not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, provider_tier, category)
);

-- ─── 5. user_known_names ─────────────────────────────────────────────────────
-- Names known to belong to or be connected with the user (contacts, calendar
-- attendees, email senders). The PII scrub uses this list to redact even when
-- a name slips past the extractor. Per gate G7 (locked 2026-05-08): populated
-- only by explicit user-initiated import, never auto-pulled on login.
create table if not exists public.user_known_names (
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null,
  source   text not null check (source in ('contacts','calendar','email_sender','manual')),
  added_at timestamptz not null default now(),
  primary key (user_id, name)
);

-- ─── 6. pii_scrub_events ─────────────────────────────────────────────────────
-- Audit trail for B5 scrub hits. Pattern class only — never the matched
-- substring (logging the substring would itself leak the PII we caught).
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

-- ─── 7. extraction_failures ──────────────────────────────────────────────────
-- Audit trail for §13 rollback-on-Zod-failure events. field_path only — never
-- the rejected value, again to avoid logging exactly the data we refused.
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

-- ─── 8. chat_messages additive columns ───────────────────────────────────────
-- Inherits chat_messages' existing RLS policy (own-rows-only).
alter table public.chat_messages
  add column if not exists context_used        jsonb,
  add column if not exists trait_sheet_version int;

-- ─── 9. user_settings additive columns (Phase 2.7 personalization controls) ──
-- personalization_v1_enabled: rollout flag (B11). Default false for existing
-- beta users; new users get true after first-run disclosure (handled in app).
-- oss_only_mode / private_only_mode: B10 + B7 global toggles.
alter table public.user_settings
  add column if not exists personalization_v1_enabled boolean not null default false,
  add column if not exists oss_only_mode              boolean not null default false,
  add column if not exists private_only_mode          boolean not null default false;

-- ─── 10. RLS — own-rows select for everything; client-writable tables get
-- explicit insert/delete policies. All other writes are service-role only.
--
-- Idempotency: dev pulls re-run migrations, and `create policy` has no
-- `if not exists` form. Drop-then-create is the conventional way to make
-- policy DDL rerunnable in Supabase migrations.
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
-- Insert/delete from client allowed only via the explicit-import settings flow,
-- which writes through the service role; no client insert/delete policy here.

alter table public.pii_scrub_events enable row level security;
drop policy if exists "own scrub events select" on public.pii_scrub_events;
create policy "own scrub events select" on public.pii_scrub_events
  for select using (auth.uid() = user_id);

alter table public.extraction_failures enable row level security;
drop policy if exists "own extraction failures select" on public.extraction_failures;
create policy "own extraction failures select" on public.extraction_failures
  for select using (auth.uid() = user_id);
