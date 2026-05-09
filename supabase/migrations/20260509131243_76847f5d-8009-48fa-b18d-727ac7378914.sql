-- Phase 2.8 — On-device PRIVATE tier idempotency. See docs/11 §8.
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