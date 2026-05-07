-- Adds 'sending' as a transient status for drafts so sendDraftViaGmail can
-- atomically claim a row before issuing the external Gmail API call. Without
-- a transient state, two concurrent invocations (double-click, retry) could
-- both observe status='pending' and both fire a real outbound email.
--
-- Lifecycle: pending  -[claim]->  sending  -[ok]->  sent | edited_then_sent
--                                          -[err]-> pending  (we revert)
alter table public.drafts
  drop constraint if exists drafts_status_check;

alter table public.drafts
  add constraint drafts_status_check
  check (status in ('pending', 'sending', 'sent', 'dismissed', 'edited_then_sent'));
