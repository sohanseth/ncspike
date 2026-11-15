# docs/10 — Share extension (NCShare) spec

Status: **build-ready spec**. Greenfield work. Owner: TBD (iOS-capable
contractor — could be Lovable if their iOS lane has bandwidth, or
external).
Drafted: 2026-05-08. Phase: targets Phase 3 / D6 per
`docs/04-native-shell-runbook.md` line 138.

**Changed on 2026-11-15 for the phone-first MVP** (`docs/26-phone-reader.md`): shared items are read on the phone
by the message reader (`src/lib/reader`, the `SharedInbox` plugin) and removed from `captures/pending/` once the
app has kept what it found. The server intake (§6 steps c–f and §7) is not built: nothing shared leaves the phone.
Identity, payload and storage layout (§3–§5) are as below, except that text may be up to 64 KB and a photo is saved
again as a JPEG at most 3,000 pixels across.

---

## 1. Why this exists

Today, sending a webpage / image / file from any other iOS app into
NeuralConnexions requires the user to copy → switch app → paste. That
loses content type (URL becomes string), it loses source attribution,
and it's enough friction that the "save it for the agent later" gesture
never happens.

The share extension turns the iOS share sheet into a one-tap "send to
NC" surface. The shared payload is captured by an extension target,
written to the App Group container, and ingested by the main app (or
the server, depending on payload size and connectivity) on next
foreground.

---

## 2. Scope

### In scope (v1)

- iOS share extension target inside the existing `NeuralConnexions`
  app, bundle suffix `.NCShare`.
- Share-sheet payload types: **URL, plain text, rich text, single
  image, single file**.
- App Group write path using the already-reserved
  `group.com.neuralconnexions.shared`.
- Server intake endpoint that accepts the captured payload, dedupes
  against existing memory, and surfaces it in the inbox.
- Main-app UI surface in the inbox showing "captures from share sheet
  (N)" with a one-tap Save / Discard.
- Security model documented (extension sandbox, App Group ACL, payload
  size cap, content type allowlist).

### Out of scope (v1)

- **Multi-item share** (more than one URL, image, or file in one share
  invocation). Apple's `NSExtensionItem.attachments` supports it; we
  defer the UX (which item wins? do we merge?) to v2.
- **Live editing** in the extension UI (annotations, tags). Extension
  shows a 3-line preview, a Save button, and a Cancel button. Anything
  more lives in the main app.
- **Android**. See §11 for the deferred plan.
- **Push notification on save** ("we ingested your share"). The user
  just shared from another app; another notification immediately is
  noise.

---

## 3. Identity & bundle layout

| Thing | Value | Source of truth |
| --- | --- | --- |
| Main app bundle | `com.neuralconnexions.app` | Phase 2.5 |
| Share extension bundle | `com.neuralconnexions.app.NCShare` | this spec |
| App Group ID | `group.com.neuralconnexions.shared` | Phase 2.5 §N2 |
| Custom URL scheme | `neuralconnexions://shared` (deep-link landing) | Phase 2.5 §N2 |

The extension is a separate target with its own provisioning profile,
its own entitlements file, and its own Info.plist. Both the main app
target and the extension target must declare the same App Group ID in
their entitlements.

---

## 4. Payload contract

The extension serialises a single capture as a JSON file in the App
Group container. The schema:

```ts
type SharedCapture = {
  /** Capture UUID (v4). Generated in the extension. Becomes the
   *  idempotency key on the server intake. */
  id: string;
  /** ISO-8601 UTC, set in the extension at capture time. */
  capturedAt: string;
  /** Schema version. v1 = "1". */
  schemaVersion: 1;
  /** Source app bundle ID, if iOS reveals it. May be null. */
  sourceBundleId: string | null;
  /** Source app display name, if iOS reveals it. May be null. */
  sourceAppName: string | null;
  /** Exactly one of url | text | image | file is set. */
  payload: SharedPayload;
};

type SharedPayload =
  | { kind: "url"; url: string; pageTitle: string | null }
  | { kind: "text"; text: string }              // ≤ 16 KB
  | { kind: "image"; relativePath: string;      // path under captures/
                     mimeType: string;          // image/jpeg|png|heic|webp
                     bytes: number; width: number | null; height: number | null }
  | { kind: "file";  relativePath: string;
                     mimeType: string;
                     bytes: number;
                     filename: string };
```

### Payload size caps (extension-enforced)

- text: 16 KB
- image: 8 MB (resized in the extension if larger; preserve EXIF
  orientation, strip GPS — see §8)
- file: 16 MB

If the user shares something over the cap, the extension shows
"Too large to share. Open NeuralConnexions and import directly." and
the share invocation is cancelled. We do **not** silently truncate.

### Storage layout in the App Group container

```
group.com.neuralconnexions.shared/
  captures/
    pending/
      <capture-id>.json       # the manifest above
      <capture-id>.bin        # the image/file blob (only if kind = image|file)
    ingested/                 # main app moves here once ingested OK
    failed/                   # main app moves here on terminal ingest failure
```

`pending/` is the only directory the extension writes to. The main app
is the only writer to `ingested/` and `failed/`.

---

## 5. Extension lifecycle

1. User invokes share sheet in any app, picks NCShare.
2. iOS spins up the extension binary. UIKit-based UI (small, fast — no
   React Native here; this is a Swift target).
3. Extension reads the `NSExtensionItem.attachments`, picks the first
   one matching its declared `NSExtensionActivationRule`
   (URL OR text OR image OR file).
4. Extension renders the preview UI:
   - URL: title + favicon + URL string
   - text: first 3 lines monospaced
   - image: thumbnail
   - file: filename + size + icon
5. User taps **Save**.
6. Extension:
   a. Generates capture ID (UUID v4).
   b. Image-only: resize if needed, strip EXIF GPS.
   c. Writes blob (if any) to `pending/<id>.bin` with `.completion`
      semantics (write to `<id>.bin.tmp`, `fsync`, rename — atomic on
      iOS).
   d. Writes manifest to `pending/<id>.json` with the same
      write-tmp-then-rename pattern. Manifest is written *last* so the
      main app never sees a manifest pointing at a half-written blob.
   e. Calls `extensionContext.completeRequest`, which dismisses the
      sheet.
7. iOS tears the extension down within seconds.

**No network calls in the extension.** Extension targets have a tiny
memory budget (~120 MB) and are killed aggressively. Doing the server
intake from the extension is unreliable; we always defer to the main
app.

---

## 6. Main-app ingest path

The main app on next foreground:

1. Lists `pending/*.json`. Sorted by `capturedAt`.
2. For each:
   a. Loads the manifest. If it doesn't parse, move file pair to
      `failed/` with a `.error.txt` next to it.
   b. If `payload.kind ∈ {image, file}`, verifies the blob exists and
      its byte count matches `bytes`. Mismatch → move to `failed/`.
   c. Calls the server intake server-fn (§7) with idempotency key =
      capture id.
   d. On 2xx: move pair to `ingested/`. Schedule blob deletion 7 days
      from now (§9 retention).
   e. On 5xx / network: leave in `pending/`. Will retry next foreground.
   f. On 4xx (validation, content-type rejected): move to `failed/`.
3. After processing, post a single inbox notice "N captures ingested"
   if N ≥ 1.

The ingest path is gated behind the existing Supabase auth session.
Captures created while the user was logged out stay in `pending/`
until they log back in.

---

## 7. Server intake endpoint

New TanStack Start server-fn: `src/lib/share-intake.functions.ts` →
`ingestSharedCapture(input)`.

Auth: standard `attachSupabaseAuth + requireSupabaseAuth`.

Input shape mirrors `SharedCapture` plus base64-encoded blob bytes for
image/file kinds. Validate with Zod (max sizes per §4).

Server-side processing:

1. **Idempotency**: insert-on-conflict against
   `shared_captures(id pk)`. If `id` already exists for this
   `user_id`, return `{ status: "duplicate", capture_id }` and stop.
2. **Dedupe vs existing memory**:
   - URL: hash to canonical form (lowercase scheme+host, strip
     `utm_*`, sort query keys). If a `memory_nodes` row already has
     that `canonical_url`, set `dedupe_target_id` to it.
   - Image/file: SHA-256 over bytes. If `memory_nodes.content_sha256`
     already matches, set `dedupe_target_id`.
   - Text: skipped — text dedupe is too noisy at this layer.
3. **Persist** to `shared_captures` (new table, see §10).
4. **Surface in inbox**: insert `inbox_items` row referencing the
   capture. Inbox rendering already exists from Phase 3.4.
5. Return `{ status: "ok" | "duplicate", capture_id, dedupe_target_id }`.

The server **never** invokes any LLM provider on intake. Trait
extraction / agent reactions happen on the existing nightly cadence.
This keeps share-sheet latency tight and CPAUD predictable.

---

## 8. Security & privacy

### Extension sandbox

iOS gives the extension its own sandbox; it cannot read the main app's
keychain, cookies, or files outside the App Group. This is good for
us — the extension cannot exfiltrate the user's session token even if
compromised.

### App Group ACL

Both targets share read/write access to the App Group container; iOS
has no per-file ACL inside it. Treat the App Group as untrusted by
default: the main app **always** revalidates manifests against the
Zod schema before ingesting, and never `eval`s or otherwise executes
content from the App Group.

### EXIF GPS stripping

Image captures pass through `CGImageSource` →
`CGImageDestinationAddImage` with the GPS dictionary explicitly
removed. Done in the extension (so the GPS payload never leaves the
device unless the user explicitly opted into it elsewhere).

### Content-type allowlist

- Images: `image/jpeg`, `image/png`, `image/heic`, `image/webp` only.
- Files: a closed allowlist of MIME types — `application/pdf`,
  `text/plain`, `text/markdown`, `text/csv`, plus the Apple iWork
  family (`.pages`, `.numbers`, `.key`) which iOS surfaces with
  `application/vnd.apple.*`.
- Anything else → "Unsupported file type" sheet, capture cancelled.

### Source-app spoofing

`sourceBundleId` and `sourceAppName` come from
`NSExtensionItem.userInfo` and are easy for a malicious app to lie
about. We display them in the inbox preview but never use them for
authorisation or routing. Treat them as advisory metadata only.

### Rate limit

Server intake: 60 captures/user/hour. Beyond that the server returns
429 with `Retry-After`; the client backs off and surfaces a soft
notice "captures throttled — try again in a bit." Stops a runaway
share-loop from a misbehaving source app.

---

## 9. Retention

- `shared_captures` row: kept indefinitely until either the user
  deletes the inbox item or the GDPR delete RPC fires (must be added
  to `delete_user_data()` in the next migration — see §10).
- App Group blob in `ingested/`: kept 7 days then deleted by the main
  app on launch. Server already has the bytes; the client cache is
  pure latency optimisation.
- App Group blob in `failed/`: kept 30 days for debugging, then
  deleted.

---

## 10. New migration

`supabase/migrations/20260518000000_share_captures.sql` (idempotent —
`if not exists`, `to_regclass`, `drop function if exists` before
recreate, per the project rule).

```sql
create table if not exists public.shared_captures (
  id                  uuid primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  captured_at         timestamptz not null,
  ingested_at         timestamptz not null default now(),
  schema_version      smallint not null check (schema_version = 1),
  source_bundle_id    text,
  source_app_name     text,
  payload_kind        text not null check (payload_kind in ('url','text','image','file')),
  -- url
  url                 text,
  canonical_url       text,
  page_title          text,
  -- text
  text_content        text,
  -- image | file
  blob_storage_path   text,            -- supabase storage path, never the App Group path
  mime_type           text,
  byte_count          bigint,
  filename            text,
  content_sha256      text,
  -- dedupe
  dedupe_target_id    uuid references public.memory_nodes(id) on delete set null
);

create index if not exists shared_captures_user_captured_idx
  on public.shared_captures(user_id, captured_at desc);
create index if not exists shared_captures_canonical_url_idx
  on public.shared_captures(user_id, canonical_url) where canonical_url is not null;
create index if not exists shared_captures_sha_idx
  on public.shared_captures(user_id, content_sha256) where content_sha256 is not null;

alter table public.shared_captures enable row level security;
drop policy if exists "own captures select" on public.shared_captures;
create policy "own captures select" on public.shared_captures
  for select using (auth.uid() = user_id);
-- writes only via service role (server-fn intake).
```

`delete_user_data()` must add `delete from public.shared_captures
where user_id = target_user_id` and the count is returned in a new
column `shared_captures_deleted`. The GDPR coverage drift test
(`tests/gdpr/per-user-table-coverage.test.ts`) will fail if this is
forgotten — that's intentional.

`EXPORT_TABLES` in `src/lib/gdpr.functions.ts` must add
`"shared_captures"`. Same drift test enforces this.

Blob bytes are uploaded to a new Supabase Storage bucket
`shared-captures` with RLS allowing only the owner to read; server-fn
uploads via service role. The bucket is also wiped on GDPR delete via
a new helper in the migration (`delete_storage_objects(...)` pattern,
or a server-side sweep — pick whichever the database skill recommends
when this lands).

---

## 11. Android share-intent counterpart (deferred)

Out of scope for v1; sketched here so future-us doesn't relitigate.

Android's `ACTION_SEND` / `ACTION_SEND_MULTIPLE` is the parallel.
Capacitor exposes intent metadata via the
`@capacitor-community/share-target` plugin (or Capgo's equivalent).
The architecture would mirror this spec exactly, with the intent
handler writing to the app's internal storage instead of an App Group.

The reason for deferral: the iOS NCShare target is meaningfully more
work than the Android intent handler, so we want to get the iOS
ergonomics right first and let the server intake API stabilise. Once
this v1 ships, Android is a ~3-day fast-follow.

---

## 12. Open questions for the implementer (non-blocking)

These are calls the iOS contractor can make at build time without
spec revision:

1. SwiftUI vs UIKit for the extension preview UI. Either is fine;
   UIKit is lower-overhead, SwiftUI is faster to write. Pick whichever
   the contractor is more fluent in.
2. Capacitor bridge plugin name & API surface. The main app is
   Capacitor-based; the bridge that lists `pending/*.json` and posts
   to the server-fn can either be a custom Capacitor plugin or a
   plain `Capacitor.Plugins.Filesystem`-style call. Custom plugin is
   cleaner but adds a build step.
3. Manifest schema migrations. v1 ships with `schemaVersion: 1`. If
   we ever bump it, the main app must accept v1 manifests indefinitely
   (users may have un-ingested captures for weeks). Just write a
   manifest-upgrade switch at ingest time.

---

## 13. Acceptance criteria

- Share sheet from Safari, Photos, Files, and Notes all produce a
  capture in the App Group.
- Main app ingests within 2 seconds of next foreground.
- Duplicate URL share returns `status: "duplicate"` and surfaces the
  existing memory node in the inbox.
- Image share with GPS in EXIF: server-side blob has no GPS dict.
- 17 MB file share: extension cancels with the "too large" sheet,
  nothing written to App Group.
- GDPR delete: `shared_captures` rows + storage bucket objects are
  gone. Coverage drift test stays green.
- No prompt or response text crosses the share intake (it's a pure
  data path, never invokes LLM providers).
