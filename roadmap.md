# Encrypted Mac relay

- [ ] Check the re-uploaded server brief against the existing relay and report any differences.

- [x] Add and apply private relay schema and atomic functions; include export/deletion and retention.
- [x] Add pairing and owner-scoped server functions plus validated claim/publish/revoke endpoints.
- [x] Test security, concurrency, lifecycle, and run the full existing suite (13 relay tests passed; existing image-editing test fails).

# Mac cards in browser

- [x] Add strict shared card contract, isolated key-link page, and browser-only decryption.
- [x] Add Mac pairing settings and signed-in Worth knowing cards using the shared demo card view.
- [x] Verify encryption vectors, key storage, page isolation, and full suite (396 passed; 32 real-database tests skipped without their test settings).
- [x] Verify signed-in pairing, card read-back, persistent dismissal, and disconnection in the browser.