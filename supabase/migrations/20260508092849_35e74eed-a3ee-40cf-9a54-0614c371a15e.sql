-- Phase 2.8 voice columns. Per handoff §4: timestamp prefix 20260520_*,
-- "add column if not exists" only, no drops/renames/constraint changes on
-- shared tables.

alter table public.inference_usage
  add column if not exists audio_micro_usd numeric(10,6),
  add column if not exists voice_turn_latency_ms int,
  add column if not exists stt_provider text,
  add column if not exists tts_provider text;

alter table public.user_settings
  add column if not exists prefer_local_audio boolean not null default true;
