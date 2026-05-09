-- Phase 2.8 follow-up: extend delete_user_data() to cover the new
-- `chat_message_attachments` table introduced by Lovable's vision merge in
-- migration 20260508221834_*. The cascade from chat_messages would already
-- nuke the rows, but the GDPR per-user-table-coverage test (and our
-- defense-in-depth posture) require an explicit guarded delete in the RPC
-- body so a future schema change that drops the cascade can't silently
-- leave per-user data behind.
--
-- This migration drop+recreates the function in full. The signature stays
-- backward compatible at call sites because we only ADD a new return
-- column (chat_message_attachments_deleted) at the end of the row.
--
-- Idempotent: drop function if exists + create or replace.

drop function if exists public.delete_user_data(uuid);

create or replace function public.delete_user_data(target_user_id uuid)
returns table (
  chat_messages_deleted              int,
  chat_threads_deleted               int,
  chat_context_log_deleted           int,
  pii_scrub_events_deleted           int,
  extraction_failures_deleted        int,
  user_trait_blocks_deleted          int,
  user_provider_category_blocks_del  int,
  user_known_names_deleted           int,
  user_traits_deleted                int,
  memory_edges_deleted               int,
  memory_nodes_deleted               int,
  inference_usage_deleted            int,
  inference_usage_daily_deleted      int,
  user_settings_deleted              int,
  chat_message_attachments_deleted   int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cm_count   int := 0;
  ct_count   int := 0;
  ccl_count  int := 0;
  pse_count  int := 0;
  ef_count   int := 0;
  utb_count  int := 0;
  upcb_count int := 0;
  ukn_count  int := 0;
  ut_count   int := 0;
  me_count   int := 0;
  mn_count   int := 0;
  iu_count   int := 0;
  iud_count  int := 0;
  us_count   int := 0;
  cma_count  int := 0;
begin
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'forbidden: caller cannot delete another user''s data';
  end if;

  -- Children-first. Attachment rows go before chat_messages so the
  -- explicit count is meaningful even if the FK cascade is later relaxed.
  if to_regclass('public.chat_message_attachments') is not null then
    delete from public.chat_message_attachments where user_id = target_user_id;
    get diagnostics cma_count = row_count;
  end if;

  if to_regclass('public.chat_messages') is not null then
    delete from public.chat_messages where user_id = target_user_id;
    get diagnostics cm_count = row_count;
  end if;

  if to_regclass('public.chat_threads') is not null then
    delete from public.chat_threads where user_id = target_user_id;
    get diagnostics ct_count = row_count;
  end if;

  delete from public.chat_context_log where user_id = target_user_id;
  get diagnostics ccl_count = row_count;

  delete from public.pii_scrub_events where user_id = target_user_id;
  get diagnostics pse_count = row_count;

  delete from public.extraction_failures where user_id = target_user_id;
  get diagnostics ef_count = row_count;

  delete from public.user_trait_blocks where user_id = target_user_id;
  get diagnostics utb_count = row_count;

  delete from public.user_provider_category_blocks where user_id = target_user_id;
  get diagnostics upcb_count = row_count;

  delete from public.user_known_names where user_id = target_user_id;
  get diagnostics ukn_count = row_count;

  delete from public.user_traits where user_id = target_user_id;
  get diagnostics ut_count = row_count;

  if to_regclass('public.memory_edges') is not null then
    delete from public.memory_edges where user_id = target_user_id;
    get diagnostics me_count = row_count;
  end if;

  if to_regclass('public.memory_nodes') is not null then
    delete from public.memory_nodes where user_id = target_user_id;
    get diagnostics mn_count = row_count;
  end if;

  if to_regclass('public.inference_usage') is not null then
    delete from public.inference_usage where user_id = target_user_id;
    get diagnostics iu_count = row_count;
  end if;

  if to_regclass('public.inference_usage_daily') is not null then
    delete from public.inference_usage_daily where user_id = target_user_id;
    get diagnostics iud_count = row_count;
  end if;

  if to_regclass('public.user_settings') is not null then
    delete from public.user_settings where user_id = target_user_id;
    get diagnostics us_count = row_count;
  end if;

  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count,
    utb_count, upcb_count, ukn_count, ut_count,
    me_count, mn_count, iu_count, iud_count, us_count,
    cma_count;
end;
$$;

revoke all on function public.delete_user_data(uuid) from public;
grant execute on function public.delete_user_data(uuid) to authenticated, service_role;
