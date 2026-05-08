-- Phase 2.8 — Voice (STT + TTS) telemetry and settings
-- See docs/07-spec-phase-2.8-voice.md §4

-- 1. Settings: the single new toggle + capability cache
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS prefer_local_audio BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS local_audio_capability JSONB;

-- 2. Voice telemetry on the existing chat row
ALTER TABLE public.inference_usage
  ADD COLUMN IF NOT EXISTS stt_provider TEXT,
  ADD COLUMN IF NOT EXISTS stt_model TEXT,
  ADD COLUMN IF NOT EXISTS stt_latency_ms INT,
  ADD COLUMN IF NOT EXISTS tts_provider TEXT,
  ADD COLUMN IF NOT EXISTS tts_model TEXT,
  ADD COLUMN IF NOT EXISTS tts_chars INT,
  ADD COLUMN IF NOT EXISTS tts_latency_ms INT,
  ADD COLUMN IF NOT EXISTS audio_micro_usd BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vtl_ms INT;