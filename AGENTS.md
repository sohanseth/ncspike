# Project conventions

- Keep shared palette roles and domain colours in src/styles.css; workspace colour mappings reference these tokens so surfaces stay consistent.
- The root `.env` (publishable backend values only) must stay committed, never gitignored — published and shared-preview builds read it at build time and crash without it.
- Relay logic lives in a server-only module; RPC wrappers import privileged clients only inside authenticated handlers so secrets never enter the browser bundle.
- Relay tables use plain owner UUIDs and an auth lifecycle deletion trigger instead of new auth foreign keys to follow Cloud schema conventions while preserving account-removal cleanup.
- External relay handlers are also exposed under `/api/public/relay/*` because published hosting only bypasses site authentication for that prefix; `/api/relay/*` retains the requested contract locally.
