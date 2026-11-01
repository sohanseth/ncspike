# Encrypted Mac relay

# Mac overnight research

- [x] Apply mission mapping and atomic mission functions with owner-only server access; restore missing research prerequisites.
- [x] Add validated mission endpoints and digest result conversion.
- [x] Identify Mac agents in list/detail; keep lifecycle management on the Mac.
- [x] Run mission security/lifecycle tests and full suite (435 passed, 32 existing checks skipped); verify signed-in pairing, creation, state read-back and revocation.

- [x] Check the re-uploaded server brief: server functionality already present; 396 tests pass, 32 database-dependent tests skipped.

- [x] Add and apply private relay schema and atomic functions; include export/deletion and retention.
- [x] Add pairing and owner-scoped server functions plus validated claim/publish/revoke endpoints.
- [x] Test security, concurrency, lifecycle, and run the full existing suite (13 relay tests passed; existing image-editing test fails).

# Mac cards in browser

- [x] Compare the re-uploaded browser brief: identical and already implemented; five browser security tests pass; live unsigned /link opens without redirect and clears its fragment.

- [x] Add strict shared card contract, isolated key-link page, and browser-only decryption.
- [x] Add Mac pairing settings and signed-in Worth knowing cards using the shared demo card view.
- [x] Verify encryption vectors, key storage, page isolation, and full suite (396 passed; 32 real-database tests skipped without their test settings).
- [x] Verify signed-in pairing, card read-back, persistent dismissal, and disconnection in the browser.
## Privacy fixes (prompt D)
- [x] 1. Full account deletion: sign out sessions, revoke Google tokens, wipe storage, extend delete_user_data (new tables + service_role-only), delete auth user; export new tables (no tokens, decrypted drafts/voice); update privacy wording
- [x] 2. Google disconnect: shared-token semantics, revoke on last disconnect, always delete row
- [x] 3. Voice Drafts consent wording + null out voice_drafts_consent_at; buildVoiceProfile refuses without consent
- [x] 4. Stop auto-queueing sender research in Gmail pull; cancel queued tasks
- [x] 5. WhatsApp entry points → 410 gone
- [x] 6. supabase/functions/chat → 410 gone
- [x] 7. Scrub personal data from logs (8 files)
- [x] 8. Retention: search_queries 30d, expired voice_profiles, orphaned chat-attachments files
- [x] 9. capacitor.config.ts: https server.url, no cleartext
- [x] 10. Mobile "More" bottom sheet with nine header actions
- [x] 11. New tests for all of the above; full suite green

## Prompt E — private by default
- [ ] 1 cloud-features.ts list + wording check
- [ ] 2 migration (user_settings default, cloud_consents, cloud_activity, retention, GDPR)
- [ ] 3 server fns getCloudFeatures/setCloudFeature + deletions + presets; cloud-features.server.ts
- [ ] 4 guards before every cloud call + activity rows
- [ ] 5 PRIVATE turns stay on device; delete PRIVATE server chats button
- [ ] 6 browser follows setting (ChatPanel lock, TTS local voices, dictation, consent triggers, Voice Drafts dialog, error link)
- [ ] 7 CloudFeatureSheet component
- [ ] 8 Privacy page sections + truthful claims
- [ ] 9 one-time notice
- [ ] 10 tests + full suite

### Prompt E status
- [x] Feature list, database, server switches, cloud guards, PRIVATE chats local, presets
- [x] Chat: locked cloud models + consent sheet, search consent, device voice fallback
- [x] Privacy page sections (switches, activity, legacy PRIVATE chats cleanup)
- [x] One-time "private by default" notice
- [x] Consent prompts on Connect Gmail/Calendar, Context on sender, Research overnight, voice profile, new agent
- [x] On-device dictation option; Voice Drafts dialog wording
- [x] New tests for each rule

## Prompt E2 — finish private by default
- [x] 1 Context on this sender + Research overnight open the email_ai consent card when off; Turn on carries on
- [x] 2 Voice Drafts dialog shows whenever email_ai is off, even if voice_drafts_consent_at is set
- [x] 3 Consent card + turn-off confirmation match app dialog theme; body text contrast >= 4.5:1
- [x] 4 One-time notice dismissed on the account (user_settings.private_notice_dismissed_at) + localStorage fallback
- [x] 5 Verify checklist items (privacy fixes + private-by-default) and report
- [x] 6 New tests; full suite green without weakening existing tests
