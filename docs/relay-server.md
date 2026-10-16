# Encrypted Mac relay — server contract

No UI changes. The server never receives the AES key, decrypts cards, or sends card data to an AI.

## Endpoints

The requested paths are `POST /api/relay/claim`, `/api/relay/publish`, and `/api/relay/revoke`. All require `application/json`. For an external Mac on published Lovable hosting, use **`/api/public/relay/claim`**, **`/api/public/relay/publish`**, and **`/api/public/relay/revoke`**: only this prefix bypasses hosting's sign-in wall. These use the same verified handlers, not unauthenticated privileged writes.

- Claim: `{v:1,code,deviceName}` → `{deviceId,token}`. Code uppercase/hyphen normalization, ten-minute expiry, one use. Token is 32 random bytes base64url, returned once; only its SHA-256 hash persists.
- Publish: bearer device token plus `{v:1,seq,keyId,generatedAt,cards}`. `seq` is an increasing safe integer; stale requests return 409 plus `lastSeq`. Full-list replacement, including `[]` to clear. Per-device row lock serializes publish and revocation.
- Revoke: bearer device token. Clears cards and disables further publication.

Body cap: 400 KiB, enforced while reading even without Content-Length. Card cap: 20. Unique lower-hex 24-character refs, unique orders 0–19, lower-hex 8-character keyId, base64 nonce (12 bytes), base64 ciphertext (16–16,384 bytes), future ISO timestamp expiry within four days.

## Signed-in functions

`createRelayPairingCode`, `listRelayDevices`, `revokeRelayDevice` (UUID string input), `listRelayCards` live in `src/lib/relay.functions.ts`. Each includes bearer attachment and server session verification. Call with TanStack `useServerFn`, not raw fetch. Ownership always comes from the authenticated context; never pass a userId.

Lists return only active devices and unexpired ciphertext. Devices exclude token hashes. Cards use newest device last-seen first, then order. All four tables deny direct browser access and all relay SQL functions are service-role-only.

## Retention and account removal

The existing retention sweep calls `cleanup_relay()` and logs aggregate counts only. This does not add a new scheduler or change existing scheduling. Relay owner tables participate in account export and the existing atomic delete RPC; account-removal cleanup is also enforced by an auth lifecycle trigger. Owner UUIDs intentionally have no new auth FK, per Cloud schema requirements. Claim-attempt IP HMACs have no user binding and expire after one day.

## Tests

`bunx vitest run tests/relay` runs schema tests. For real SQL locking, permission, handler, and lifecycle checks against an **isolated** database with the auth shim and relay migration applied, set `RELAY_TEST_DB_URL` and run `bunx vitest run tests/relay`. The suite truncates relay tables and must never target production. Existing GDPR seeds include the new tables.

Verified: 13 relay tests passed against isolated PostgreSQL; signed-in live pairing → upload → owner read-back → revoke passed, with further uploads rejected (401). Full existing suite: 390 passed, 32 skipped without their database settings, one pre-existing PRIVATE image-editing test failed (`phase29c-img2img-no-egress.test.ts`). UI and image handling were not changed for this relay task.