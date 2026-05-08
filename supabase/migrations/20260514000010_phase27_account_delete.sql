-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2.7 D8 Day 7 — transactional account deletion (spec §14).
--
-- Spec wants single-transaction all-or-nothing semantics for "Delete my data".
-- The Supabase JS client doesn't expose multi-statement transactions, so we
-- expose a SECURITY DEFINER function that runs every per-user delete inside
-- ONE PostgreSQL transaction. Any failure rolls back everything.
--
-- Tables wiped (FK-safe order):
--   chat_messages, chat_threads,
--   chat_context_log, pii_scrub_events, extraction_failures,
--   user_trait_blocks, user_provider_category_blocks, user_known_names,
--   user_traits,
--   memory_edges, memory_nodes,
--   inference_usage,
--   user_settings (personalization toggles + global flags).
--
-- Returns one row of per-table counts so the UI can summarize the wipe.
-- The auth.users row itself is NOT touched — that's a Supabase admin op.
-- ─────────────────────────────────────────────────────────────────────────────

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
  user_settings_deleted              int
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
  us_count   int := 0;
begin
  -- AuthZ: only the user themselves (or service_role bypass) may delete.
  -- service_role calls have auth.uid() = null; we allow that path so the
  -- server-side server function can invoke this with the user's identity
  -- already verified by attachSupabaseAuth + requireSupabaseAuth.
  if auth.uid() is not null and auth.uid() <> target_user_id then
    raise exception 'forbidden: caller cannot delete another user''s data';
  end if;

  -- Children-first to keep FK constraints happy even where ON DELETE CASCADE
  -- isn't uniformly configured.
  delete from public.chat_messages where user_id = target_user_id;
  get diagnostics cm_count = row_count;

  delete from public.chat_threads where user_id = target_user_id;
  get diagnostics ct_count = row_count;

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

  delete from public.memory_edges where user_id = target_user_id;
  get diagnostics me_count = row_count;

  delete from public.memory_nodes where user_id = target_user_id;
  get diagnostics mn_count = row_count;

  delete from public.inference_usage where user_id = target_user_id;
  get diagnostics iu_count = row_count;

  delete from public.user_settings where user_id = target_user_id;
  get diagnostics us_count = row_count;

  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count,
    utb_count, upcb_count, ukn_count, ut_count,
    me_count, mn_count, iu_count, us_count;
end;
$$;

revoke all on function public.delete_user_data(uuid) from public;
grant execute on function public.delete_user_data(uuid) to authenticated, service_role;
