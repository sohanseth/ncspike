# Mac found items — verification

## Implemented
- The existing browser decryption retains top-level document fields; separate found validation fails closed without hiding Your list, Today or Coming up.
- MacFound appears immediately after MacLists. Add/Skip use the unchanged encrypted answer envelope; only refs and encrypted answers go back to the relay.
- Missing dates, private placeholders, pending/error/rescan states, focus/five-minute refresh and four-day local choice pruning are implemented.
- MacLists changes only its three visible private title expressions. MainApp, MacCards and all server code, routes, migrations, dependencies and existing settings are unchanged.
- The G2 test allowlist adds MacFound only; existing three exceptions and the expected-failing strict invariant remain unchanged.

## Checks completed
- Full Vitest suite against isolated PostgreSQL: **520 passed, 43 existing gated skips**, 51 passing files and 5 gated files. No existing test removed or newly skipped.
- Exact supplied list/found and answer encryption vectors; schema bounds and unknown fields; date labels; encrypted Add/Skip; decrypt-only refusal; four-day pruning.
- Existing relay SQL accepts list refs for encrypted add, skip and another opaque action, with persisted ciphertext read-back in rolled-back local fixtures.
- `python3 tests/relay/found.e2e.py`: managed signed-in workspace, real pairing and encrypted upload, six found rows, three Add buttons, missing-date Skip, no private buttons, Add/Skip storage/poll/decryption with matching refs, reload persistence, decrypt-only scan warning, private titles in all three MacLists panels, absent-found hiding and empty-found message.
- Desktop 1280×1800 and mobile 589×675 screenshots inspected. Temporary test devices revoked on test completion. Build telemetry reports build OK.

## Preservation checklist
Each category below was compared against the pre-change source. Unchanged source is preservation evidence, not a claim that every external or native flow was exercised live.

| Requested category | Result |
| --- | --- |
| Earlier relay claim/publish/revoke/answers, pairing/pasted link, /link, Mac cards/actions and Mac missions | Unchanged |
| Prompt G storage/routes/functions, ticks, Your list/Today/Coming up and G2 display-only privacy test | Preserved; specified passthrough, private title displays and MacFound allowlist only |
| Privacy switches/consent/turn-off/activity/choices/PRIVATE cleanup/notice, guards and badge resolution | Unchanged |
| Evening brief and other later additions | Unchanged |
| Landing/auth/password/error/404/workspace/agent/inbox/connections/drafts/personalization/privacy/usage/voice/internal/demo pages | Unchanged except additive workspace mount |
| Chat/TTS/STT/Google/retired WhatsApp routes and scheduled research/traits/agent jobs | Unchanged |
| MainApp nav/header/canvases/greeting/bento/domain sheet/mobile ask bar | Byte-for-byte unchanged |
| Email Voice Drafts, calendar/questions/reply/context/research/reminder actions | Unchanged |
| Manual/bulk/dictated task entry and classification | Unchanged |
| Chat badges/streaming/attachments/chips/voice/breadcrumb/undo/images/local models/safety/limits | Unchanged |
| Briefings/Compose/You/personalization disclosure | Unchanged |
| On-device Apple/Nano/WebLLM/image/safety models and font loading | Unchanged |
| Connections/Personalization/Privacy/Usage/Voice/Drafts/Inbox/Agents/internal CPAUD controls | Unchanged |
| Capacitor/native plugins/PWA/.well-known/docs/scripts/unlinked components/unused MainApp sections | Preserved; additive verification documentation only |
| All existing tests and fixtures | Preserved; G2's explicitly permitted one-line allowlist addition only |

## Not verified end to end
- Actual NeuralConnexions Mac collection and family-week processing: no originating Mac app is available. Browser tests simulate its existing encrypted upload and polling contract.
- Stale-card and arbitrary refusal UI plus the elapsed five-minute refresh were not driven live; their code paths are present, but no successful live check is claimed.
- The full preservation checklist's Google/provider/native/scheduled flows were not individually repeated. Source preservation and the existing full suite passed; 43 environment-gated cases remain skipped as before.
- No migration, new server route/function, consent switch or cloud activity row was added.