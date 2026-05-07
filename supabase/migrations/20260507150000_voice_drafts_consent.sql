-- Slice B / Week 3: per-user consent for Voice Drafts.
-- NULL = not consented. Set to a timestamp the moment the user accepts the
-- consent screen. Server-side gating in voice-drafts.functions.ts checks
-- this before any inference call.
alter table public.user_settings
  add column if not exists voice_drafts_consent_at timestamptz;
