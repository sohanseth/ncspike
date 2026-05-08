-- Phase 2.7 D8 Day 3: atomic import for user_known_names with hard cap.
--
-- Application-level cap (count → insert) had a TOCTOU race that let
-- concurrent import calls overshoot the 1000-name limit. This function
-- runs the count + insert in a single transaction with row-level locking
-- via INSERT ... ON CONFLICT, returning the actual inserted count (not
-- the candidate count) so callers can report truthfully.
--
-- SECURITY DEFINER + auth.uid() check: the function bypasses RLS on the
-- write but only ever writes rows for the calling user. Callers from the
-- server that use supabaseAdmin can pass an explicit user_id; callers
-- from the client (via PostgREST RPC) get implicitly scoped to their own
-- auth.uid(). We accept user_id as a parameter so the same function
-- serves both paths.

create or replace function public.import_known_names(
  p_user_id uuid,
  p_names   text[],
  p_source  text
) returns table (inserted int, capped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap        constant int := 1000;
  v_existing   int;
  v_remaining  int;
  v_to_insert  text[];
  v_inserted   int;
begin
  -- Authn floor: when called via PostgREST, the caller MUST be writing for
  -- their own user_id. Server-side callers using the service role bypass
  -- this check (auth.uid() returns null under service role).
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'forbidden: cannot import names for another user';
  end if;

  if p_source not in ('contacts','calendar','email_sender','manual') then
    raise exception 'invalid source: %', p_source;
  end if;

  -- Lock the user's existing rows so a concurrent import can't slip in
  -- between our count and our insert. Cheap because PK index on user_id.
  perform 1 from user_known_names where user_id = p_user_id for update;

  select count(*) into v_existing
    from user_known_names where user_id = p_user_id;

  v_remaining := greatest(0, v_cap - v_existing);

  if v_remaining = 0 or coalesce(array_length(p_names, 1), 0) = 0 then
    return query select 0::int, (coalesce(array_length(p_names, 1), 0) > 0);
    return;
  end if;

  -- Slice the candidate array down to remaining capacity.
  v_to_insert := p_names[1 : v_remaining];

  -- Insert with conflict-skip to keep idempotency. RETURNING gives the
  -- TRUE inserted count (excluding rows already present).
  with new_rows as (
    insert into user_known_names (user_id, name, source)
    select p_user_id, n, p_source
      from unnest(v_to_insert) as t(n)
    on conflict (user_id, name) do nothing
    returning 1
  )
  select count(*)::int into v_inserted from new_rows;

  return query select
    v_inserted,
    (coalesce(array_length(p_names, 1), 0) > v_remaining);
end;
$$;

-- Authenticated callers (and service role) only.
grant execute on function public.import_known_names(uuid, text[], text) to authenticated;
revoke execute on function public.import_known_names(uuid, text[], text) from anon;
