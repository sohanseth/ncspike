# Project conventions

- Keep shared palette roles and domain colours in src/styles.css; workspace colour mappings reference these tokens so surfaces stay consistent.
- The root `.env` (publishable backend values only) must stay committed, never gitignored — published and shared-preview builds read it at build time and crash without it.
