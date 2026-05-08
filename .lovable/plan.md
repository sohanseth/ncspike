# Paste-image (vision) in chat

## What you'll see in the app

1. **Paste Ctrl/Cmd+V** an image into the chat input, or drag-drop one onto the chat panel — a thumbnail chip appears above the input. Up to **10 images, 10 MB each** per message. You can remove a chip with × before sending.
2. **Sending** stores the images in a private `chat-attachments` bucket, then sends the turn to a vision-capable model. The user message bubble shows the thumbnails.
3. **Per-badge routing for vision turns:**
   - **Flash** → `google/gemini-3-flash-preview` (vision-capable)
   - **Pro** → `anthropic/claude-3.5-sonnet` (vision) → `openai/gpt-5` fallback
   - **Genius** → `openai/gpt-5` (vision)
   - **Private** → Cloudflare `@cf/meta/llama-3.2-11b-vision-instruct` only — fail-closed contract preserved
4. **StatusPill** gets a small "vision" badge during a vision turn, and on PRIVATE shows a one-line note ("Llama 3.2 11B Vision — slower, on-platform").
5. **Reload-safe**: thumbnails reload from the bucket via signed URLs when you reopen a thread.

## Technical plan

### 1. Storage (migration)
- New `chat-attachments` bucket (private).
- Path convention: `{user_id}/{thread_id}/{uuid}.{ext}`.
- RLS on `storage.objects`: owner-only `select/insert/delete`, scoped via `(storage.foldername(name))[1] = auth.uid()::text`.
- New `chat_message_attachments` table: `id, message_id, user_id, storage_path, mime, width, height, bytes, created_at`. RLS: owner only.

### 2. Client (paste/drop + chip UI)
- Extend `ChatPanel` (`MainApp.tsx`) with `attachments: { id, file, previewUrl, status }[]`.
- Wire `onPaste` on the input + `onDragOver`/`onDrop` on the panel.
- Validate (image/*, ≤10 MB, ≤10 total). Show error toast on reject.
- Auto-downscale >2048px on the client (canvas) before upload to keep latency reasonable on PRIVATE.
- Thumbnail strip above the input with × removal.
- On send: upload via `supabase.storage.from('chat-attachments').upload(...)`, then pass storage paths into `streamChatMessage`.

### 3. chat-stream protocol change
- `streamChatMessage` request body gains `attachments: string[]` (storage paths).
- `/api/chat/stream` server route: signed-URL each attachment, build a multimodal `messages` array (`content: [{type:"text"...},{type:"image_url"...}]`), persist `chat_message_attachments` rows linked to the new user message id, then route to provider.

### 4. Provider router for vision
- New helper `pickVisionModel(badge)` returns `{ provider, model }` overriding the default chain when `attachments.length > 0`.
- Update `src/server/inference/router.ts` chains' vision overrides table; PRIVATE fails closed (no fallback).
- Cloudflare adapter (`src/server/inference/cloudflare.ts`) gets a vision branch: when called with image parts, hit `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct` with `{ image: <base64 bytes>, prompt }`. (Cloudflare's vision endpoints accept raw bytes, not URLs, so we fetch+base64 server-side.)
- OpenAI/Anthropic/Google adapters already accept the OpenAI-style `image_url` content part — pass through unchanged.

### 5. Rendering
- User message bubble renders thumbnails (signed URLs cached in React state) above the text.
- Thread reload (`getMessages` server fn) joins `chat_message_attachments` and returns `attachments[]` per message; client signs URLs once per session.

### 6. UI feedback
- StatusPill: add `hasVision` boolean prop; render a small "vision" pill next to the provider chip during/after a vision turn.
- PRIVATE-specific hint shown the first time a vision turn runs on PRIVATE (dismissable).

## Files that will change / be created

```text
supabase migration             chat-attachments bucket + RLS + chat_message_attachments table
src/components/workspace/MainApp.tsx     paste/drop, chip strip, send wiring, bubble thumbnails
src/components/workspace/StatusPill.tsx  vision pill + private hint
src/lib/chat-stream.ts                   accept + forward attachments[]
src/lib/chat-attachments.ts (new)        upload helper, downscale, signed URL cache
src/routes/api.chat.stream.ts            sign URLs, build multimodal messages, persist attachments
src/server/inference/router.ts           vision override per badge (PRIVATE fail-closed)
src/server/inference/cloudflare.ts       Llama 3.2 11B Vision branch (base64 image + prompt)
src/server/inference/{openai,anthropic,google}.ts  pass-through image_url parts (verify)
```

## Out of scope (this pass)
- Drag-to-reorder thumbnails.
- Multi-image conversations spanning multiple turns (we send attachments only with the turn they're attached to; later assistant follow-ups remain text).
- Document/PDF uploads — images only.
- Camera capture button — paste/drag only for now.
- Streaming partial vision tokens for Cloudflare (Cloudflare returns a full response; we'll emit it as a single delta).

## Risks
- **Cloudflare Llama vision cold-start latency** can be 4-8s; we'll show a "thinking…" skeleton with a vision indicator.
- **Provider parity**: if Anthropic vision fails, Pro falls back to OpenAI vision; PRIVATE has no fallback by design — failure surfaces as an error toast rather than a silent downgrade.
- Image bytes are sent to Cloudflare base64-inline, which inflates payload by ~33%. The 10 MB client cap means worst-case ~13 MB per request, well under Worker limits.
