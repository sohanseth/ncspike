# Spec — Phase 2.5: Native Shell (Capacitor + Background + Push)

*Status: Draft for review · Owner: Sneha · Depends on: Decision Doc D4 · Target: 3 weeks*

> **Review note (architect, 2026-05-07):** earlier draft had four substantive issues — N3 invoked an admin-scoped all-users cron from a per-device trigger; N4 left APNs auth-key vs p12 open while claiming to be locked; N5 introduced native UI under an "infrastructure only" header; deep-link security was under-specified. All four are addressed below. Sequencing rebased from 2 weeks to 3 to absorb deep-link hardening and store provisioning realistically.

---

## 1. Goal & non-goals

**Goal.** Wrap the existing TanStack Start PWA in a Capacitor native shell so NC ships as a real `.ipa` and `.apk`, runs its overnight cron without depending on a browser tab being open, and delivers push notifications for the morning brief, draft-ready, and urgent-email events.

**Phase 2.5 is infrastructure only.** No new user-facing features. Three pillars: native wrapper, background execution, push.

### Explicitly out of scope (deferred to Phase 3)
- Share extension (iOS) / share intent (Android) — separate spec D6.
- New connectors (Slack, Microsoft Graph, Notion, etc.) — D6.
- Apple Foundation Models bridge — Phase 4 per D4.
- App Store / Play Store *publication*. Phase 2.5 produces signed builds installable via TestFlight + Play Internal Testing only.
- On-device LLM (WebLLM) packaging — stays Power-mode opt-in via the web path.
- Native UI replacements. The existing React UI runs unchanged inside the WebView.

---

## 2. The one metric

**Overnight-cron success rate (OCSR):** the % of mornings on which the previous night's per-user cron run (research batch, retention cleanup) was successfully **device-triggered** while the app was backgrounded or killed. Execution itself is server-side per D3 and N3; the metric measures whether the device woke and asked the server to advance the user's queue, not on-device compute.

- Target for V1 release: **≥80%** across the 50-user beta cohort over a 14-day window.
- Below 60% = native scheduling is not earning its keep over the existing Cloudflare Worker cron; revisit before Phase 3.
- Logged client-side as a single `cron_run` row written when the background task fires, plus a server-side reconciliation against the existing Worker cron (which becomes a fallback, not the primary).

Push delivery rate and battery impact are guardrails, not goals.

---

## 3. Decisions

### N1. Wrapper choice
**Decision:** **Capacitor 6** (not React Native, not Tauri, not raw WebViews). Existing Vite build output is served from the app bundle in production; dev builds point at the Vite dev server over LAN.
**Why:** zero rewrite, our entire UI is web. Capacitor's plugin ecosystem covers everything we need (BackgroundTask, PushNotifications, App URL handling, Filesystem). React Native would require rebuilding every screen.
**Forecloses:** native-only screens in Phase 2.5. Any native UI work waits for a deliberate native-screen decision later.

### N2. Bundle and group identifiers (locked)
**Decision:**
- iOS bundle ID: `com.neuralconnexions.app`
- Android application ID: `com.neuralconnexions.app`
- iOS App Group (used by future share extension and any cross-target storage): `group.com.neuralconnexions.shared`
- Custom URL scheme: `neuralconnexions://` (e.g. `neuralconnexions://shared`, `neuralconnexions://draft/<id>`)
**Why:** lock these now even though only the wrapper ships in 2.5; changing them after install is painful (App Group migrations, push-token re-registration). The share-extension App Group ID is reserved here so D6 doesn't have to renegotiate.
**Forecloses:** renaming after first beta install without forcing a reinstall.

### N3. Background execution model
**Decision:** Native scheduler **augments**, does not replace, the existing Cloudflare Worker cron. The Worker cron remains the source-of-truth, processing all users with admin scope. Native runs are **per-user, per-device, authenticated triggers** that ask the server to advance only that user's queue. Concretely:

- **New server fn:** `runResearchBatchForUser({ userId })` in `src/server/research-cron.ts`. Authenticated via the user's session JWT (Supabase `auth.uid()` must equal the passed `userId`); no service-role path exposed to the client. Internally calls the existing per-user processor used by the all-users batch loop, with the same row-level locking on `research_tasks`.
- **What native invokes:** the device's background task wakes the Capacitor WebView shim, which calls `runResearchBatchForUser` for the *currently signed-in user only*. Never `runResearchBatchAllUsers()`. Never with a different `userId`.
- **Schedulers:**
  - iOS: `BGTaskScheduler` with a `BGProcessingTaskRequest` registered for identifier `com.neuralconnexions.app.cron.research` (requires charging + network; iOS gives no firm guarantees on cadence — accepted for V1).
  - Android: `WorkManager` `PeriodicWorkRequest`, 15-minute minimum interval, `NetworkType.UNMETERED`, `requiresCharging = true` to mirror iOS.
- **Anti-stampede / precedence:** the per-user processor opens a transaction and uses `SELECT ... FOR UPDATE SKIP LOCKED` on the user's `research_tasks` rows (existing pattern). If the Worker cron is mid-run for the same user when the device wakes, the device gets zero rows and writes a `cron_run` row with `status = 'noop'`. No duplicate work. No anti-stampede backoff is needed beyond what `SKIP LOCKED` already provides at our scale (≤50 beta users).
- **Telemetry:** every invocation (worker, native iOS, native Android) writes a `cron_run` row with `(user_id, platform, trigger, started_at, finished_at, status ∈ {ok, noop, partial, error}, tasks_run)`.
- **Idempotency:** existing `research_tasks` status transitions and `scheduled_for` gating make all of this safe regardless of which trigger fires.

**Why:** iOS background execution is unreliable enough that retention cannot ride on it alone. Per-user authenticated triggers preserve least-privilege (no admin path on the client), keep the call chain auditable, and let us measure native vs. worker contribution per user via the OCSR metric. Note that "background execution" here means *triggering* a server-side run from the device — actual research still runs server-side per D3. The user-facing latency win is "wake → results pulled before user opens the app," not on-device compute.

**Forecloses:** any client-callable admin/all-user cron path. Turning off the Worker cron in 2.5. On-device research execution (stays Phase 4 conversation, tied to Apple Foundation Models bridge).

### N4. Push provider
**Decision:** **Firebase Cloud Messaging (FCM)** for both platforms via `@capacitor/push-notifications`. Server-side sender lives in a new `src/server/push.server.ts` calling FCM HTTP v1 with a service-account JWT. iOS uses FCM's APNs bridge with an **APNs auth key** (`.p8`) uploaded to Firebase — locked, no `.p12` certificate path.
**Why APNs auth key over `.p12` cert:** one key works for development and production, never expires, single rotation surface, no per-environment certificate juggling. Apple's own recommendation.
**Forecloses:** APNs-direct in 2.5. APNs `.p12` certificates in 2.5. Web Push in 2.5 (the existing PWA install path stays without notifications until we revisit).

### N5. Auth on native
**Decision:** Supabase OAuth flows (Google) launch in `ASWebAuthenticationSession` (iOS) / Custom Tabs (Android) via `@capacitor/browser`, **not** inside the embedded WebView. Callback URL is the deep link defined in N7 (universal/app link, with custom-scheme fallback). Supabase client uses `flowType: 'pkce'`. The deep-link handler validates and completes the session per N7's threat model.

**Apple Sign-In on iOS:** *deferred* to a Phase 3 follow-up. Adding the native Sign-in-with-Apple button is genuine UI work and contradicts this phase's "infrastructure only" frame. iOS users in 2.5 sign in with Google via the system browser, same as Android. This is acceptable for the beta cohort; App Store *publication* (not TestFlight) eventually requires Sign-in-with-Apple if any other social login is offered, and we're not publishing in 2.5.

**Why:** Google explicitly disallows OAuth in embedded WebViews and blocks the flow with `disallowed_useragent`. System browser is the only compliant option for Google. Apple Sign-In is a separate native UI surface, not infrastructure, and gets its own design pass.

**Forecloses:** in-WebView OAuth. Native Sign-in-with-Apple button in 2.5. App Store *publication* (as opposed to TestFlight distribution) in 2.5.

### N6. Coexistence with the PWA
**Decision:** PWA install path stays available. The native shell is an alternative distribution, not a replacement. Per-user preference is implicit (whichever one they installed). Push tokens are namespaced by `(user_id, platform)` so a user who installs both gets pushes on both.
**Why:** killing the PWA path before TestFlight/Play access scales would lock out beta users without Apple developer accounts. Keeping both has near-zero ongoing cost.
**Forecloses:** assuming a user has only one install. Server-side push fan-out must iterate `(user_id, platform)` rows.

### N7. Deep-link integrity (auth callback + future share/draft links)
**Decision:** All deep links use **Universal Links (iOS) and App Links (Android)** as the primary path, with the `neuralconnexions://` custom scheme retained only as a fallback for environments where AASA / Digital Asset Links files are unreachable. Universal/App links require the app to host `apple-app-site-association` and `assetlinks.json` at `https://app.neuralconnexions.com/.well-known/`, signed with the app's bundle ID + signing cert SHA-256.

The deep-link handler in the WebView shim enforces:
- **Path allowlist:** only `/auth/callback`, `/draft/<uuid>`, `/shared` (reserved for D6) are routable. Anything else is logged and dropped silently.
- **OAuth state + nonce verification:** the `state` parameter on `/auth/callback` must match a value generated and stored in secure storage at the moment of OAuth launch. Mismatch → reject, surface "Sign-in failed, try again," log to `auth_callback_rejections` table (RLS service-role only).
- **Single-use callback:** the `state` value is deleted from secure storage on first successful consumption. A second hit with the same state is rejected.
- **No mutation without authenticated session:** `/draft/<id>` and `/shared` only navigate the UI. They never call mutating server fns. Any server fn invoked from a deep-link-driven screen still requires the standard Supabase JWT.
- **Rejection telemetry:** every reject writes a `(timestamp, reason, raw_path_hash)` row. No raw URLs persisted (could contain tokens).

**Why:** custom-scheme deep links are vulnerable to scheme hijack — any other app can register `neuralconnexions://` and intercept callbacks. Universal/App Links bind the link to our verified domain via cryptographic association files Apple/Google fetch. The state/nonce check defends against the residual fallback case and against any forged callback even on the universal-link path. The path allowlist is defense-in-depth: even if an attacker somehow reaches the handler with `/admin/whatever`, the handler refuses to route.

**Forecloses:** custom-scheme-only flows. Mutating server fns invoked directly from deep-link parameters (e.g. `nc://draft/<id>/send` is *not* a thing — the draft screen requires user confirmation). Logging full deep-link URLs anywhere.

---

## 4. Privacy & security boundary

| Surface | What changes vs. PWA | Notes |
|---|---|---|
| Supabase auth tokens (access + refresh) | iOS Keychain / Android EncryptedSharedPreferences via `@capacitor-community/secure-storage`. **Single store, no `localStorage` fallback on native.** Refresh-token rotation handled by the Supabase client; the new refresh token replaces the old one in secure storage on every refresh, never appended. On logout or account-switch, the entire NC keychain group is wiped (`SecureStorage.clear()`) before the next sign-in starts. PWA path unchanged. | Native installs do not migrate from PWA `localStorage` — first native launch is a fresh sign-in. Documented as expected behaviour, not a bug. |
| Push tokens (FCM registration tokens) | Stored server-side in new `device_tokens` table, RLS = `auth.uid() = user_id`. | Rotated on app reinstall. Stale-token cleanup: rows untouched for 60 days deleted by `cleanup_phase2_retention()`. |
| OAuth `state` / nonce | iOS Keychain / Android EncryptedSharedPreferences, single-use, deleted on consumption (per N7). | Never logged. |
| `cron_run` telemetry | New row per native cron invocation: user, platform, started_at, finished_at, status. | RLS select-own. Used solely for OCSR metric. |
| `auth_callback_rejections` | Service-role-only table; rows = `(timestamp, reason, raw_path_hash)`. | No raw URL or token data persisted. 30-day TTL. |
| Background task payloads | None — the native task is a trigger only, all data stays in Postgres. | The Capacitor plugin shim does not pass data into the background task; it just calls the per-user authenticated server fn (N3). |
| Deep links | Universal Links / App Links primary, custom scheme fallback (per N7). | Path allowlist + OAuth state/nonce verification + no-mutation rule enforced in the deep-link handler. |

No new data leaves the device or the existing trust boundary. FCM is the one new third-party in the chain (Google), used only for delivering the notification envelope; no message content goes through FCM beyond the user-visible notification text.

**Disclosure copy delta (added to Settings → Privacy):**
> Notifications are delivered through Firebase Cloud Messaging (Google). Notification text (e.g. "3 urgent emails this morning") passes through Google's infrastructure. Email contents and personal data do not.

---

## 5. Data model deltas

### New table: `device_tokens`
```
id              uuid pk
user_id         uuid fk → auth.users
platform        text       -- 'ios' | 'android'
token           text       -- FCM registration token
app_version     text
created_at      timestamptz
last_seen_at    timestamptz
```
Unique on `(user_id, platform, token)`. RLS: `auth.uid() = user_id` for select; service-role only for insert/update.

### New table: `cron_run`
```
id              uuid pk
user_id         uuid fk
platform        text       -- 'ios' | 'android' | 'worker'
trigger         text       -- 'background_task' | 'cf_cron' | 'manual'
started_at      timestamptz
finished_at     timestamptz
status          text       -- 'ok' | 'noop' | 'partial' | 'error'
error           text       -- nullable
tasks_run       int
```
RLS: select-own; service-role writes. TTL: 30 days via existing `cleanup_phase2_retention()` extension.

### New table: `push_permission_events`
```
id              uuid pk
user_id         uuid fk
platform        text       -- 'ios' | 'android'
event           text       -- 'primer_shown' | 'primer_dismissed' | 'system_prompt_shown' | 'system_prompt_granted' | 'system_prompt_denied'
created_at      timestamptz
```
RLS: select-own; service-role writes. TTL: 90 days. Used to compute the permission funnel per §7.1.

### New table: `auth_callback_rejections`
```
id              uuid pk
created_at      timestamptz
reason          text       -- 'state_mismatch' | 'state_replay' | 'path_not_allowlisted' | 'malformed'
raw_path_hash   text       -- sha-256 of the inbound path; never the raw path
platform        text
```
RLS: service-role only (both read and write). TTL: 30 days. Used solely for security incident review per N7.

### `cleanup_phase2_retention()` extension
The existing function is extended to also delete: `cron_run` >30 days, `push_permission_events` >90 days, `auth_callback_rejections` >30 days, and `device_tokens` rows with `last_seen_at` >60 days.

### No changes to existing tables.

---

## 6. API surface

New TanStack Start server functions in `src/server/native.functions.ts`:
```
registerDeviceToken({ platform, token, appVersion })   // upsert into device_tokens
unregisterDeviceToken({ token })                       // delete on logout / uninstall callback
recordCronRun({ trigger, startedAt, finishedAt, status, tasksRun, error? })
sendPush({ userId, title, body, data? })               // service-role only; called by server-side notification triggers
```

Server-only helpers (`src/server/push.server.ts`):
```
notifyMorningBrief(userId)             // called by overnight cron at 06:30 local time per user
notifyDraftReady(userId, draftId)      // called when a Slice B draft completes
notifyUrgentEmail(userId, nodeId)      // called when classifier marks an email Urgent in real-time
```
All three rate-limited per-user via the existing `tool_invocations` rate-limit primitive (new tool keys: `push_morning`, `push_draft`, `push_urgent`; caps tbd in week 1).

Capacitor plugin shim (`capacitor/plugins/NCBackground/`):
```
NCBackground.scheduleNext()            // re-arms the next BGTaskScheduler / WorkManager run
NCBackground.runOnce()                 // for QA: triggers the entry point synchronously
```
The plugin's native side calls into the WebView's TS entry point via a custom `runtime` URL the Capacitor app loads on background invocation. Pattern documented in §8.

---

## 7. UX surfaces

### 7.1 First-launch on native — push permission policy
**Prompt timing:** *not* on first launch. The system push prompt is fired only after the user has completed sign-in *and* viewed at least one inbox item. Rationale: requesting push permission before the user understands what NC sends results in a much higher denial rate (Apple's own data: ~60% denial when prompted at app open vs. ~25% when prompted after a meaningful interaction).

**Authorization style (iOS):** **standard** authorization (`UNAuthorizationOptions: [.alert, .sound, .badge]`), *not* provisional. Provisional notifications go to the Notification Center silently and would defeat the morning-brief / urgent-email use case where a lock-screen alert is the entire point. Reconsider provisional in Phase 3 if denial rate exceeds 40%.

**The screen:** one-screen primer between the first inbox view and the system prompt. Three lines:
> NC sends three kinds of notifications: your morning brief at 6:30am, urgent emails as they land, and drafts when they're ready. You can turn any of them off in Settings.

One **"Turn on notifications"** button (fires the system prompt), one **"Not now"** link (closes the primer; never shown again unless the user opens it from Settings → Notifications).

**Telemetry:** every transition through the funnel (`primer_shown`, `primer_dismissed`, `system_prompt_shown`, `system_prompt_granted`, `system_prompt_denied`) writes to a new `push_permission_events` table (RLS select-own, 90-day TTL). Used to compute denial rate per-platform per-week.

**Denied recovery:** Settings → Notifications screen detects `permission === 'denied'` and shows a clear "Open system settings" link (uses `App.openUrl({ url: 'app-settings:' })` on iOS, equivalent on Android). No nagging; surfaced only when the user lands on that screen.

### 7.2 Settings → Notifications
Three toggles, default all-on:
- Morning brief (06:30 local)
- Draft ready
- Urgent email

Each toggle maps to a server-side preference checked before `sendPush()`.

### 7.3 Settings → Diagnostics
Read-only display of: last `cron_run` time, last successful background task, last push received, FCM token (truncated). Useful for the beta cohort to send us screenshots when something's off.

### 7.4 No other UI changes.
Inbox, Drafts, Memory, Settings — all unchanged. The whole point of Capacitor is the existing UI just works.

---

## 8. Sequencing (3 weeks)

Re-baselined from the original 2-week plan after architect review flagged it as unrealistic. The added week absorbs deep-link hardening (N7), store provisioning, and iOS BGTask testing, none of which compress safely.

| Week | Deliverable | Done = |
|---|---|---|
| 1 | **Android end-to-end.** Capacitor scaffold; Android shell building locally and on a real device; OAuth via Custom Tabs with Universal/App Links + N7 hardening (path allowlist, state/nonce, single-use); `device_tokens` table + registration; `auth_callback_rejections` table + handler. | Real Android device: sign in via system browser → callback validated → land on inbox → token row in Supabase → at least one rejected forged callback logged. |
| 2 | **iOS auth + push on both platforms.** iOS shell building locally (real device deferred to week 3 if Apple Dev account not yet provisioned); same OAuth + N7 path on iOS via `ASWebAuthenticationSession`; FCM push (N4) with APNs auth key uploaded; `push.server.ts` + 3 notification triggers + rate-limit keys; Settings → Notifications screen with the §7.1 primer + denial-recovery link; `push_permission_events` telemetry. | iOS Simulator + Android device: sign-in works; first push of each type lands on a real device of at least one platform; permission funnel rows visible. |
| 3 | **Background execution + signed builds.** `runResearchBatchForUser` server fn (N3) + Capacitor plugin shim (`NCBackground`) + iOS BGTask registration + Android WorkManager registration + `cron_run` telemetry; Settings → Diagnostics screen; signed iOS build (TestFlight) + signed Android build (Play Internal Testing). | At least one `cron_run` row of `trigger='background_task'` from a real backgrounded device of each platform; OCSR query returns data; both stores accept the upload. |

**Week-1 go/no-go gates (must be resolved by end of day 1):**
- **G1.** Apple Developer account ($99/yr) is provisioned and the team ID is in hand. Without this, iOS signing and TestFlight are blocked.
- **G2.** Google Play developer account ($25 one-time) is provisioned. Without this, Play Internal Testing is blocked.
- **G3.** A hostname under our control serves files at `https://<host>/.well-known/apple-app-site-association` and `.../assetlinks.json`. Without this, Universal/App Links per N7 fall back to custom-scheme-only, which materially weakens the security model and turns N7's "primary path" into "fallback path." If unresolved, either provision the hostname in week 1 or explicitly accept the security degradation in writing before week 2 starts.

If any gate is unmet at end of day 1, week 1 starts with a 24-hour countdown to resolve before the schedule slips.

**Descope rules under pressure (in order):**
1. If iOS Apple Dev account isn't provisioned by start of week 2 → defer iOS device testing to week 3, keep Simulator-only progress in week 2.
2. If iOS BGTask testing in week 3 reveals reliability worse than 30% in 5 nights → ship anyway, document the actual rate, and lean harder on the Worker-cron fallback. Don't let perfect block the release.
3. If both stores' provisioning slips → ship Android Play Internal first, iOS TestFlight in a week-4 trailing follow-up. Android-first is the safe descoping order (no Mac dependency for CI).

---

## 9. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| iOS background tasks rarely fire (BGTaskScheduler is opportunistic). | High | The Cloudflare Worker cron remains the source of truth (N3). Native runs are *additional*, not *replacement*. OCSR target is 80%, not 100%. |
| OAuth flow breaks on iOS due to `ASWebAuthenticationSession` quirks. | Med | Use `@capacitor/browser` with the explicit PKCE flow; smoke-test against Google + Apple in Week 1 not Week 2. |
| FCM service-account credential management. | Low | Store the JSON key in Cloudflare Worker secrets, mint short-lived JWTs server-side. No key in the client bundle. |
| Capacitor WebView lags behind Safari/Chrome (especially older iOS versions). | Med | Pin `minimum-os-version` to iOS 16+ and Android API 24+ for V1; revisit after beta. |
| App Group ID conflict with the future share extension. | Low | Locked in N2 specifically to avoid this. |
| Push prompt declined → no notifications, no recovery path. | Med | Settings → Notifications screen surfaces a clear "Open system settings" link when permission status is `denied`. |
| Supabase token storage migration from `localStorage` to Keychain breaks existing sessions on first native install. | Low | Acceptable: native install is a fresh install; user will sign in once. |
| The native cron entry point and the Worker cron both attempt the same retention cleanup at the same time. | Low | `cleanup_phase2_retention()` is idempotent. Documented as such in the migration. |

---

## 10. Open questions

1. **TestFlight / Play access (was G1 + G2; resolved 2026-05-07):**
   - **G1 — Apple Developer account: ✓ Provisioned.** iOS signing + TestFlight unblocked.
   - **G2 — Google Play developer account: ⏳ To be provisioned in parallel with week 1 build.** $25 one-time. Sneha kicks off Google's identity verification on day 1; not on the critical path for week 1 code (debug APK builds work without Play access).
2. **App icon / splash screen:** placeholder NC mark for V1. Real brand pass deferred to a separate design task before TestFlight goes wider than 5 testers.
3. **AASA / Digital Asset Links hostname (was G3; resolved 2026-05-07):** **`app.neuralconnexions.com`** hosted via Cloudflare Pages. Static `.well-known/apple-app-site-association` and `.well-known/assetlinks.json` files committed to the NC repo and deployed to that subdomain. Reasoning: clean separation from any future marketing apex on `neuralconnexions.com`; same Cloudflare dashboard already in use for Workers; trivial to rotate file contents without redeploy of the app itself. Bundle ID stays `com.neuralconnexions.app`.
4. **Quiet hours for push:** out of scope for Phase 2.5 (per-user preference of three on/off toggles is enough for V1). Quiet hours is a Phase 3 polish item once we see actual push frequency in the wild.
5. **Sentry / Crashlytics on native:** out of scope for 2.5; rely on Diagnostics screen + user-reported screenshots in beta. Revisit after OCSR data.
6. **PWA path deprecation:** explicitly *not* deprecated (per N6). Revisit only if both stores approve and we see ≥80% of beta users on native after 30 days.
7. **Apple Sign-In native button:** deferred to Phase 3 per N5. Re-open before any App Store *publication* attempt (TestFlight does not require it; the public store does, if any other social provider is offered).

---

## 11. Definition of done

- [ ] Signed iOS build distributable via TestFlight; signed Android build distributable via Play Internal Testing. (Android may ship one week ahead of iOS per §8 descope rules.)
- [ ] Sign-in works end-to-end on both platforms via system browser, not embedded WebView, using Universal/App Links per N7.
- [ ] At least one synthetic forged-callback rejection is logged in `auth_callback_rejections` (proves the path allowlist + state check are wired).
- [ ] At least one successful overnight `cron_run` row of `trigger='background_task'` written from a real backgrounded device on each platform.
- [ ] `runResearchBatchForUser` is the only client-callable cron entry point; `runResearchBatchAllUsers` is unreachable from any client surface (verified by code search + `auth.uid()` enforcement).
- [ ] At least one push notification of each type (morning brief, draft ready, urgent email) delivered to a real device of each platform.
- [ ] Push permission funnel (`push_permission_events`) returns rows for at least 5 beta users, enabling denial-rate computation.
- [ ] OCSR metric query exists and returns data from the beta cohort.
- [ ] Settings → Notifications and Settings → Diagnostics screens shipped and functional. Denial-recovery link works.
- [ ] Cloudflare Worker cron still runs and is documented as the source-of-truth fallback.
- [ ] Auth tokens stored in Keychain / EncryptedSharedPreferences only; no token leakage to `localStorage` on native (verified via DevTools storage inspection).
- [ ] Logout / account-switch wipes the keychain group before the next sign-in begins (verified manually).
- [ ] Privacy disclosure copy in §4 added to Settings → Privacy.
- [ ] All decisions (N1–N7) recorded in this doc; any deviation documented as an "Implementation deltas" appendix mirroring the Phase 2 doc's pattern.

---

## 12. What this unblocks

- **Phase 3 share extension (D6):** App Group ID and bundle IDs are already in place; Capacitor plugin pattern proven; deep-link handler proven.
- **Phase 3 new connectors:** none of them depend on native, but the push pipeline lets connectors notify ("Slack: 2 urgent threads from your team") without users opening the app.
- **Phase 4 Apple Foundation Models bridge:** the Capacitor plugin pattern from N3 is the same pattern that bridge will use.
