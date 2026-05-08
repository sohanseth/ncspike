-- Corrective migration. The Phase 2.8 contractor migration
-- 20260508092849_*.sql set `user_settings.prefer_local_audio` to
-- `default true`, contradicting the handoff contract (docs/08 §4) which
-- specifies `default false`. The earlier migration 20260508085322_*.sql
-- already created the column with `default FALSE`; the later one only
-- re-applies via `add column if not exists`, but in fresh-DB scenarios
-- (local dev / CI) the later default wins.
--
-- Per Option-2 (Phase 2.8 Day 2): on web the "Prefer on-device" toggle is
-- always hidden, so any persisted `true` value is stale and would only
-- matter once the native shell ships. Default-true also misleads any new
-- 2.7 broker user into thinking PRIVATE-on-web means real on-device audio
-- (it doesn't — it means browser-speech + text-only). Reset to false and
-- normalize existing rows.

alter table public.user_settings
  alter column prefer_local_audio set default false;

update public.user_settings
  set prefer_local_audio = false
  where prefer_local_audio = true;
