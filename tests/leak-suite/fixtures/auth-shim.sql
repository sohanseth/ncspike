-- ─────────────────────────────────────────────────────────────────────────────
-- Local-Postgres shim for the Supabase `auth` schema.
--
-- The real Supabase Cloud database ships with `auth.users`, `auth.uid()`,
-- and friends out of the box. An ephemeral plain-Postgres instance does
-- not, so we create just enough of the surface for our migrations to apply
-- and for `public.delete_user_data()` to run end-to-end:
--
--   * auth schema
--   * auth.users(id uuid pk, email text, raw_user_meta_data jsonb)
--     — `email` and `raw_user_meta_data` are needed because the
--       `handle_new_user` trigger reads them.
--   * auth.uid()  — returns NULL by default, mimicking a service-role caller.
--                   delete_user_data() treats NULL as "trust the caller's
--                   server-side userId binding" (see the function source).
--
-- Apply BEFORE supabase/migrations/*.sql. Tear down with the database itself.
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase ships these roles by default; plain Postgres does not. Several
-- migrations `grant execute ... to authenticated, service_role` or
-- `revoke ... from anon`, so create them as no-login NOINHERIT roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end$$;

create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key,
  email               text,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select null::uuid;
$$;
