-- Phase 2.6 hardening — race-proof daily chat-usage caps.
--
-- The original implementation in `assertWithinDailyCaps` did
-- `select count(*) ... where status='ok'` and only later inserted the new
-- usage row from a different transaction. Two concurrent requests at the
-- cap edge could both see `count = cap-1`, both pass, both spend, and
-- both write — overshooting the cap by 1+. Phase 2.6 architect review B1
-- flagged this; this migration closes it by replacing the read-then-write
-- with a serialized reserve / finalize / release RPC trio.
--
-- Design:
--   * Add a transitional `pending` status. A reserved-but-not-yet-completed
--     slot is a `pending` row; it counts toward the daily cap exactly the
--     same as `ok` does. Concurrent reservations therefore see each other.
--   * `reserve_inference_slot` takes a per-(user,badge) `pg_advisory_xact_lock`
--     so two callers cannot both pass `count(*) < cap` and both insert. The
--     lock is released automatically at txn commit.
--   * Stale `pending` rows older than 5 minutes are swept inside the same
--     RPC so a crashed chain run cannot permanently consume a slot.
--   * `finalize_inference_usage` flips `pending` → terminal status and
--     writes the real cost / model / token counts. `release_inference_slot`
--     deletes the reservation when the chain exhausts (so the user is not
--     debited for a request that never produced a response).
--
-- Idempotent: safe to re-apply on a DB that already has these functions
-- (drop function if exists ... + create or replace ...) and on a fresh DB
-- (constraint replacement guarded by pg_constraint lookup).

-- ── 1. Allow 'pending' in inference_usage.status ────────────────────────────
do $$
declare
  cur_def text;
begin
  select pg_get_constraintdef(c.oid) into cur_def
    from pg_constraint c
    where c.conrelid = 'public.inference_usage'::regclass
      and c.conname  = 'inference_usage_status_check';
  if cur_def is not null and position('pending' in cur_def) = 0 then
    alter table public.inference_usage
      drop constraint inference_usage_status_check;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
      where conrelid = 'public.inference_usage'::regclass
        and conname  = 'inference_usage_status_check'
  ) then
    alter table public.inference_usage
      add constraint inference_usage_status_check
      check (status in ('ok','rate_limited','error','user_abort','cap_exceeded','pending'));
  end if;
end $$;

-- ── 2. reserve_inference_slot ───────────────────────────────────────────────
drop function if exists public.reserve_inference_slot(uuid, uuid, text, text[], int);

create or replace function public.reserve_inference_slot(
  p_user_id        uuid,
  p_thread_id      uuid,
  p_badge          text,
  p_provider_chain text[],
  p_cap            int
)
returns table (
  usage_id   uuid,
  used_count int,
  accepted   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used  int;
  v_id    uuid;
  v_lock  bigint;
  v_start timestamptz;
begin
  -- Per-(user,badge) advisory lock — serializes concurrent cap checks for
  -- the same key, so two callers cannot both see `count < cap` and both
  -- reserve. Released at txn end.
  v_lock := hashtextextended(p_user_id::text || ':' || p_badge, 0);
  perform pg_advisory_xact_lock(v_lock);

  -- Sweep stale reservations from crashed chain runs so they don't
  -- permanently consume cap slots. 5 min is well above the longest
  -- expected provider chain runtime.
  delete from public.inference_usage
    where user_id = p_user_id
      and status  = 'pending'
      and started_at < now() - interval '5 minutes';

  v_start := date_trunc('day', timezone('UTC', now())) at time zone 'UTC';

  select count(*) into v_used
    from public.inference_usage
    where user_id   = p_user_id
      and badge     = p_badge
      and status    in ('ok','pending')
      and started_at >= v_start;

  if v_used >= p_cap then
    insert into public.inference_usage (
      user_id, thread_id, badge, provider_chain, provider_used,
      fallback_depth, latency_ms, status, error_class
    ) values (
      p_user_id, p_thread_id, p_badge, p_provider_chain,
      coalesce(p_provider_chain[1], 'unknown'),
      0, 0, 'cap_exceeded', 'cap_exceeded'
    ) returning id into v_id;
    return query select v_id, v_used, false;
    return;
  end if;

  insert into public.inference_usage (
    user_id, thread_id, badge, provider_chain, provider_used,
    fallback_depth, latency_ms, status
  ) values (
    p_user_id, p_thread_id, p_badge, p_provider_chain,
    coalesce(p_provider_chain[1], 'unknown'),
    0, 0, 'pending'
  ) returning id into v_id;

  return query select v_id, v_used + 1, true;
end $$;

revoke all on function public.reserve_inference_slot(uuid, uuid, text, text[], int) from public;
grant execute on function public.reserve_inference_slot(uuid, uuid, text, text[], int) to service_role;

-- ── 3. finalize_inference_usage ─────────────────────────────────────────────
drop function if exists public.finalize_inference_usage(uuid, uuid, text, text, text, int, int, int, bigint, int, text, uuid);

create or replace function public.finalize_inference_usage(
  p_usage_id        uuid,
  p_user_id         uuid,
  p_status          text,
  p_provider_used   text,
  p_model_used      text,
  p_fallback_depth  int,
  p_input_tokens    int,
  p_output_tokens   int,
  p_cost_micro_usd  bigint,
  p_latency_ms      int,
  p_error_class     text,
  p_message_id      uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if p_status not in ('ok','rate_limited','error','user_abort') then
    raise exception 'finalize_inference_usage: invalid terminal status %', p_status;
  end if;

  update public.inference_usage
     set status         = p_status,
         provider_used  = coalesce(p_provider_used, provider_used),
         model_used     = p_model_used,
         fallback_depth = coalesce(p_fallback_depth, fallback_depth),
         input_tokens   = p_input_tokens,
         output_tokens  = p_output_tokens,
         cost_micro_usd = p_cost_micro_usd,
         latency_ms     = coalesce(p_latency_ms, latency_ms),
         error_class    = p_error_class,
         message_id     = coalesce(p_message_id, message_id)
   where id      = p_usage_id
     and user_id = p_user_id
     and status  = 'pending';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

revoke all on function public.finalize_inference_usage(uuid, uuid, text, text, text, int, int, int, bigint, int, text, uuid) from public;
grant execute on function public.finalize_inference_usage(uuid, uuid, text, text, text, int, int, int, bigint, int, text, uuid) to service_role;

-- ── 4. release_inference_slot ───────────────────────────────────────────────
drop function if exists public.release_inference_slot(uuid, uuid);

create or replace function public.release_inference_slot(
  p_usage_id uuid,
  p_user_id  uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from public.inference_usage
   where id      = p_usage_id
     and user_id = p_user_id
     and status  = 'pending';
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end $$;

revoke all on function public.release_inference_slot(uuid, uuid) from public;
grant execute on function public.release_inference_slot(uuid, uuid) to service_role;
