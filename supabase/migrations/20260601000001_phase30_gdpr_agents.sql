-- Phase 3.0 GDPR coverage for agent runtime tables.
--
-- Extends public.delete_user_data() to cover the 4 new tables introduced by
-- 20260601000000_phase30_agent_runtime.sql:
--   agent_findings, agent_state, agent_runs, agents.
--
-- Why explicit guarded deletes when the FK from agents → auth.users already
-- cascades?  Same defense-in-depth posture as every prior GDPR migration
-- (20260516000000 chat_attachments, 20260517000300 search_queries): the per-
-- user-table-coverage test asserts an explicit count, so a future schema
-- change that relaxes the cascade can't silently leave per-user data behind.
--
-- New return columns appended at the end (so existing call sites stay
-- backward compatible if they only read named columns):
--   agents_deleted, agent_runs_deleted, agent_findings_deleted, agent_state_deleted.
--
-- FK-safe delete order: agent_findings → agent_state → agent_runs → agents.
-- (Children first; agent_runs is referenced by agent_findings.)
--
-- Pattern mirrors 20260517000300_phase29_gdpr_search_queries.sql.

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
  chat_message_attachments_deleted   int,
  search_queries_deleted             int,
  agent_findings_deleted             int,
  agent_state_deleted                int,
  agent_runs_deleted                 int,
  agents_deleted                     int
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
  sq_count   int := 0;
  af_count   int := 0;
  ast_count  int := 0;
  ar_count   int := 0;
  ag_count   int := 0;
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

  if to_regclass('public.search_queries') is not null then
    delete from public.search_queries where user_id = target_user_id;
    get diagnostics sq_count = row_count;
  end if;

  -- Phase 3.0 agent runtime tables. FK-safe order:
  --   agent_findings (→ agent_runs + agents)
  --   agent_state    (→ agents)
  --   agent_runs     (→ agents)
  --   agents         (→ auth.users)
  if to_regclass('public.agent_findings') is not null then
    delete from public.agent_findings where user_id = target_user_id;
    get diagnostics af_count = row_count;
  end if;

  if to_regclass('public.agent_state') is not null then
    delete from public.agent_state where user_id = target_user_id;
    get diagnostics ast_count = row_count;
  end if;

  if to_regclass('public.agent_runs') is not null then
    delete from public.agent_runs where user_id = target_user_id;
    get diagnostics ar_count = row_count;
  end if;

  if to_regclass('public.agents') is not null then
    delete from public.agents where user_id = target_user_id;
    get diagnostics ag_count = row_count;
  end if;

  return query select
    cm_count, ct_count, ccl_count, pse_count, ef_count,
    utb_count, upcb_count, ukn_count, ut_count,
    me_count, mn_count, iu_count, iud_count, us_count,
    cma_count, sq_count,
    af_count, ast_count, ar_count, ag_count;
end;
$$;

revoke all on function public.delete_user_data(uuid) from public;
grant execute on function public.delete_user_data(uuid) to authenticated, service_role;
