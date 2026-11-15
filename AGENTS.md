# Project conventions

- Keep shared palette roles and domain colours in src/styles.css; workspace colour mappings reference these tokens so surfaces stay consistent.
- The root `.env` (publishable backend values only) must stay committed, never gitignored — published and shared-preview builds read it at build time and crash without it.
- Relay logic lives in a server-only module; RPC wrappers import privileged clients only inside authenticated handlers so secrets never enter the browser bundle.
- Encrypted Mac answers use a separate server-only handler and browser-only encryption; answer polling never updates device last-seen timestamps.
- Encrypted Mac lists use separate schemas, handlers and panels; browser-only decryption and ticks share the existing key and answer envelope to preserve card behavior.
- Mac-found items use an additive browser-only panel with local answer suppression and the existing encrypted list/answer envelope; top-level list fields pass through validation so invalid optional found data never hides the original lists.
- Relay tables use plain owner UUIDs and an auth lifecycle deletion trigger instead of new auth foreign keys to follow Cloud schema conventions while preserving account-removal cleanup.
- External relay handlers are also exposed under `/api/public/relay/*` because published hosting only bypasses site authentication for that prefix; `/api/relay/*` retains the requested contract locally.
- No page may load third-party scripts; Mac card keys live in browser IndexedDB and any page script could read them.
- Mac research endpoints delegate to a server-only mission handler; owner-scoped mission mappings identify Mac agents and block web lifecycle mutations so control remains on the originating Mac.
- The mission migration restores absent research runtime prerequisites with plain owner UUIDs and auth lifecycle cleanup so the linked backend can run existing research agents without new auth foreign keys.
- The agents parent route renders its nested detail through Outlet so agent links display their own page rather than the list.
- Account deletion is a five-step pipeline in src/lib/gdpr.server.ts (gdpr.functions.ts holds only RPC wrappers that lazy-import it) (sign out sessions → revoke Google tokens → wipe Storage → delete_user_data RPC → delete auth user); delete_user_data is service_role-only and every public user_id table must stay covered by export+RPC or GDPR_IGNORE_TABLES (CI-enforced).
- Retired endpoints answer 410 {"error":"gone"} and call/log nothing (WhatsApp fn + route, supabase/functions/chat).
- Logs never carry raw provider bodies, request payloads, push titles or whole error objects — log error class + HTTP status, using scrubErrorMessage where it fits.
- Live Privacy confirmation tests use Python Playwright with managed preview auth and owner-scoped persisted read-back; use voice replies and restore its original state to avoid deleting user content.
- Mac privacy boundary tests recursively audit display imports and allow only the four named relay RPCs; keep the strict consumer invariant expected-failing with a separately asserted exception inventory until existing consumers may be changed, because the requested audit must not refactor runtime features.
