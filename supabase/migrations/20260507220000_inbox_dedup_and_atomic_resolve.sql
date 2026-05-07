-- Hardening for inbox dedup + resolve.
--
-- 0) Preflight: collapse any pre-existing duplicates from before app-layer
--    dedup existed. We keep the OLDEST row per (user_id, gmail_id) — that's
--    the one most likely to have a user-set resolved_at. Any newer dupes
--    (which by definition have no resolved_at, since the UI tick targets a
--    specific id) are safe to delete.
delete from public.memory_nodes m
 using (
   select id,
          row_number() over (
            partition by user_id, (data->>'gmail_id')
            order by created_at asc, id asc
          ) as rn
     from public.memory_nodes
    where source like 'gmail:%'
      and (data->>'gmail_id') is not null
 ) d
 where m.id = d.id
   and d.rn > 1;

-- 1) Partial unique index so two simultaneous Gmail pulls cannot race past
--    the app-layer dedup and insert duplicate rows for the same message.
--    Scoped to gmail-sourced rows only (other node_types/sources unaffected).
create unique index if not exists memory_nodes_user_gmail_id_uniq
  on public.memory_nodes (user_id, ((data->>'gmail_id')))
  where source like 'gmail:%' and (data->>'gmail_id') is not null;

-- 2) Atomic JSONB patch for marking an inbox item resolved. Avoids the
--    read-modify-write lost-update window in the JS server fn. Scoped to the
--    caller's user_id (the server fn passes p_user_id from auth context).
create or replace function public.mark_memory_node_resolved(
  p_node_id uuid,
  p_user_id uuid,
  p_action  text
) returns void
language sql
security definer
set search_path = public
as $$
  update public.memory_nodes
     set data = coalesce(data, '{}'::jsonb)
              || jsonb_build_object(
                   'resolved_at',     now(),
                   'resolved_action', coalesce(p_action, 'done')
                 )
   where id = p_node_id
     and user_id = p_user_id;
$$;

revoke all on function public.mark_memory_node_resolved(uuid, uuid, text) from public;
grant execute on function public.mark_memory_node_resolved(uuid, uuid, text) to service_role;
