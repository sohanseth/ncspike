# Mac overnight research

Paired Macs use POST `/api/public/relay/missions/upsert`, `/delete`, and `/results` on published hosting; equivalent `/api/relay/missions/*` paths preserve the local contract. Send JSON and the active device bearer token. Request bodies are limited to 16 KiB and strict version-1 schemas.

Mission names and topics are readable server-side and use the existing research-digest pipeline and its default budget/badge. These are not encrypted card envelopes; no browser encryption key is sent. A device may keep ten missions, with at most three unpaused/unarchived agents. Nightly means a 24-hour cadence; weekly means 168 hours, not a guaranteed wall-clock start time.

Mac agents appear in the ordinary list/detail pages. Owner-scoped mission mappings prevent browser pause/resume/archive. Revocation removes their agents, runs, findings, state and mappings. The mapping uses a plain owner UUID rather than a new auth foreign key; existing device deletion plus agent lifecycle cleanup preserves full-account deletion.

The single mission migration also restores research runtime tables/functions missing from the linked backend. Scheduling dispatch code is unchanged. An automatic overnight run on published hosting has not been verified; the existing worker scheduling still needs deployment validation.

Tests: `RELAY_MISSIONS_TEST_DB_URL` enables the isolated PostgreSQL mission suite in `tests/relay/missions.test.ts`. Never point it at production: the fixtures truncate test tables. Browser verification pairs a temporary device, creates a paused mission, checks list/detail/read-back, and revokes it without running external research.