-- Phase 2.8 — On-device PRIVATE tier idempotency. See docs/11 §8.
--
-- The on-device chat path uses a prepare/finalize server-fn pair instead
-- of the SSE chain runner. Network retries between the steps could
-- otherwise create duplicate assistant rows (one per finalize call) and
-- duplicate inference_usage rows (one per finalize call). Two unique
-- partial indexes give us per-user-message idempotency without changing
-- the existing chat surface:
--
--   chat_messages.in_reply_to_id  — unique (NOT NULL only); FK back to
--                                   the user message this assistant row
--                                   replies to. Hosted-tier rows leave
--                                   it NULL and are not constrained.
--   inference_usage.message_id    — unique (NOT NULL only); FK to the
--                                   assistant chat_messages row this
--                                   telemetry row describes.
--
-- The hosted-tier sendChatMessage path can be migrated to use these in a
-- follow-up; for now they coexist (NULLs allowed, partial-index excludes
-- nulls so no constraint violation on hosted writes).
--
-- Idempotent on re-run: `add column if not exists` + `create unique index
-- if not exists` per replit.md user preferences.

alter table public.chat_messages
  add column if not exists in_reply_to_id uuid
    references public.chat_messages (id) on delete set null;

create unique index if not exists chat_messages_in_reply_to_uniq
  on public.chat_messages (in_reply_to_id)
  where in_reply_to_id is not null;

alter table public.inference_usage
  add column if not exists message_id uuid
    references public.chat_messages (id) on delete set null;

create unique index if not exists inference_usage_message_uniq
  on public.inference_usage (message_id)
  where message_id is not null;
