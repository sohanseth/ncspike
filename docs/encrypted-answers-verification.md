# Encrypted Mac answers: verification

## Verified

- Both supplied AES-GCM vectors match byte-for-byte; random answer IDs, timestamps, padding, envelope sizes and key usages are tested.
- Atomic PostgreSQL tests cover owner isolation, stale/expired cards, revocation, malformed envelopes, 60 answers per user per hour (including acknowledged answers), 200 pending per device, expiry, oldest-first batches of 50, device-isolated acknowledgments, and unchanged last-seen timestamps.
- Signed-in browser flow: pair a temporary Mac, publish an encrypted card, see Done and Remind, press Done, read the saved encrypted answer through the polling endpoint, decrypt with the originating key, confirm action, republish with a new nonce and see the card return. A decrypt-only key displays the rescan message without hiding the card. Temporary Mac revoked afterward. No browser page errors.
- GDPR export/deletion coverage and deletion-result parity pass. Final suite: 484 passed, 43 pre-existing gated tests skipped. Preview build OK.

## Preservation checklist

All checklist groups remain in source; `MainApp.tsx` has no changes. No existing route, feature, dependency, test or unused component was removed.

- Earlier relay, pairing, Connections pasted-link field, Worth knowing, overnight mission routes: retained. Only key encryption usage and answer provenance/control integration changed.
- Privacy switches, consent and confirmation, activity/history, legacy PRIVATE cleanup, first-run notice, cloud guards and badge resolution: retained.
- Evening brief and all other existing pages, including authentication, password recovery, workspace subpages and CPAUD: retained. Existing router-level error/not-found handling retained.
- Chat, TTS, STT, Google callback, retired WhatsApp routes and research/trait/agent jobs: retained.
- Every MainApp header action, canvas, domain tile/detail, manual task, voice draft, chat, image, briefing, Compose and You flow: unchanged source.
- On-device AI, native plugins, model/safety downloads and fonts: retained.
- Connections, Personalization, Privacy, Usage, Voice settings, Drafts, Inbox and Agents: retained.
- Capacitor, iOS/Android, manifest, well-known files, docs/scripts and unused components/symbols: retained.
- Existing tests: none removed or weakened; existing key-usage/card-provenance expectations updated and GDPR seeds extended for the added tables.

This inventory establishes preservation in source, not exhaustive runtime verification of every old flow.

## Not verified end to end

- Actual Mac app execution of Done/Remind: no running originating Mac application is available. Its transport and decryption contract were exercised in the browser and PostgreSQL tests.
- Automatic half-hour polling on published hosting and scheduled research/trait jobs: requires deployed scheduling and a connected Mac; not exercised here.
- Every pre-existing cloud-provider, native-device and integration flow: requires the relevant services/devices; unchanged source and passing regression tests are not a substitute for those live checks.
- Private-card local dismissal, successful Remind/Not now clicks and all error UI branches were not separately exercised live; underlying filtering, encryption, suppression and refusal rules have automated coverage.

## Implementation adaptations

- Owner IDs stay plain UUIDs with account-lifecycle deletion, following this project's Cloud schema convention rather than introducing new foreign keys to auth users.
- Public-prefix endpoint alias retained for published-host authentication bypass; it verifies device tokens itself.
- A second additive migration updates account-deletion result counters so encrypted answer export and deletion contracts stay aligned.