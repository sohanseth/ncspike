-- ─────────────────────────────────────────────────────────────────────────────
-- Local-Postgres shim for the Supabase `storage` schema.
--
-- Supabase Cloud ships `storage.buckets`, `storage.objects`, and helper
-- functions like `storage.foldername(text)` out of the box. An ephemeral
-- plain-Postgres instance does not, so the chat-attachments migration
-- (`20260508221834_*.sql`) fails on `insert into storage.buckets ...` and
-- on `create policy ... using (storage.foldername(name))[1] = ...`.
--
-- This shim creates just enough of the surface for those migrations to
-- apply and for any RLS policies referencing storage.foldername / auth.uid
-- to compile:
--
--   * storage schema
--   * storage.buckets(id text pk, name text, public bool, file_size_limit
--                     bigint, allowed_mime_types text[])
--   * storage.objects(id uuid pk, bucket_id text, name text, owner uuid,
--                     created_at, updated_at)
--   * storage.foldername(text) returns text[]  — splits the object name
--     on '/' the same way Supabase's helper does, so policies that read
--     `(storage.foldername(name))[1]` get the user-id prefix.
--
-- Apply BEFORE supabase/migrations/*.sql, AFTER auth-shim.sql (we don't
-- depend on auth here, but ordering is consistent with the script).
-- Tear down with the database itself.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists storage;

create table if not exists storage.buckets (
  id                  text primary key,
  name                text not null,
  public              boolean not null default false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets(id) on delete cascade,
  name        text,
  owner       uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select string_to_array(name, '/');
$$;
