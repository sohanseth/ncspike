-- Phase 2.9a — image-out foundation
--
-- Adds an `attachment_kind` discriminator to chat_message_attachments so
-- future image-out turns (Phase 2.9 slice b/c, on-device generated images)
-- can be distinguished from existing vision-in attachments (user uploads
-- the model reads). Slice a ships the column only; the SSE route still
-- writes the existing kind on every insert. Slice b will start setting
-- 'image_out' for assistant-generated images.
--
-- Idempotent: re-runnable on a fresh DB and on the user's existing DB
-- per replit.md migration policy.
--   * `to_regclass` guard so the migration is a no-op if the table was
--     dropped (e.g. partial wipe / fresh re-init).
--   * `if not exists` on column add so re-running on a DB that already has
--     it doesn't error.
--   * Backfill is harmless on re-run because the default already pinned
--     existing rows on the first apply.
--
-- Does NOT touch:
--   * RLS on chat_message_attachments (the existing "own attachments all"
--     policy already gates by user_id; attachment_kind doesn't add a new
--     access dimension in slice a).
--   * The chat-attachments storage bucket policy (still owner-only via
--     {user_id}/... path convention).

do $$
begin
  if to_regclass('public.chat_message_attachments') is not null then
    -- Add the discriminator column. Default 'image_in' so existing rows
    -- (all of which are user-uploaded source images) backfill correctly
    -- without an explicit UPDATE.
    alter table public.chat_message_attachments
      add column if not exists attachment_kind text not null default 'image_in';

    -- CHECK constraint. Drop-if-exists then re-add so re-runs don't trip
    -- "constraint already exists" — safer than `add constraint if not
    -- exists` which only landed in PG 15+.
    alter table public.chat_message_attachments
      drop constraint if exists chat_message_attachments_kind_check;
    alter table public.chat_message_attachments
      add constraint chat_message_attachments_kind_check
      check (attachment_kind in ('image_in', 'image_out'));

    -- Defensive backfill — `default` covers new rows but if a previous
    -- partial migration created rows without the default we'd see NULLs
    -- and the not-null + default wouldn't have rescued them. Re-running
    -- this update is a no-op on a clean DB.
    update public.chat_message_attachments
       set attachment_kind = 'image_in'
     where attachment_kind is null;

    -- Helper index for slice-c telemetry and the GDPR coverage check
    -- (counting per-kind rows during retention sweeps). Cheap on a small
    -- table; matches the existing index naming style.
    create index if not exists chat_message_attachments_kind_idx
      on public.chat_message_attachments(attachment_kind);
  end if;
end$$;
