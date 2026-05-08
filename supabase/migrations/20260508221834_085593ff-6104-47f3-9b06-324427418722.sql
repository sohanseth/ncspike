-- Private bucket for chat image attachments
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  10485760, -- 10 MB
  array['image/png','image/jpeg','image/webp','image/gif']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public = excluded.public;

-- RLS: owner-only via {user_id}/... path convention
create policy "chat-attachments owner select"
on storage.objects for select to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "chat-attachments owner insert"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "chat-attachments owner delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Per-message attachments table
create table public.chat_message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null,
  storage_path text not null,
  mime text not null,
  width integer,
  height integer,
  bytes integer,
  created_at timestamptz not null default now()
);

create index chat_message_attachments_message_idx
  on public.chat_message_attachments(message_id);
create index chat_message_attachments_user_idx
  on public.chat_message_attachments(user_id);

alter table public.chat_message_attachments enable row level security;

create policy "own attachments all"
on public.chat_message_attachments for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);