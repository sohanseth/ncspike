# Project conventions

- Keep shared palette roles and domain colours in src/styles.css; workspace colour mappings reference these tokens so surfaces stay consistent.
- The root `.env` (publishable backend values only) must stay committed, never gitignored — published and shared-preview builds read it at build time and crash without it.
- Relay logic lives in a server-only module; RPC wrappers import privileged clients only inside authenticated handlers so secrets never enter the browser bundle.
- Relay tables use plain owner UUIDs and an auth lifecycle deletion trigger instead of new auth foreign keys to follow Cloud schema conventions while preserving account-removal cleanup.
- External relay handlers are also exposed under `/api/public/relay/*` because published hosting only bypasses site authentication for that prefix; `/api/relay/*` retains the requested contract locally.
- No page may load third-party scripts; Mac card keys live in browser IndexedDB and any page script could read them.
- Mac research endpoints delegate to a server-only mission handler; owner-scoped mission mappings identify Mac agents and block web lifecycle mutations so control remains on the originating Mac.
- The mission migration restores absent research runtime prerequisites with plain owner UUIDs and auth lifecycle cleanup so the linked backend can run existing research agents without new auth foreign keys.
