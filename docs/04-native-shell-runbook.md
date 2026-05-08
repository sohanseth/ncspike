# 04 — Native Shell Runbook

Companion to `docs/03-spec-phase-2.5-native-shell.md`. This is the operational checklist for turning the Replit-side scaffolding (Day 1, complete) into running iOS + Android builds on Sneha's local Mac.

> **What's already done in the repo (Day 1):**
> - SQL migration `supabase/migrations/20260508050000_phase25_native_shell.sql` — 4 new tables + extended retention sweep
> - Server fns in `src/server/native.functions.ts` — register/unregister device, runResearchBatchForUser, recordCronRun, recordPushPermissionEvent, recordAuthCallbackRejection
> - `src/server/research-cron.ts` refactored to expose `runResearchBatchForUserId` (N3)
> - `src/server/push.server.ts` — FCM stub (real send wired in Day 3)
> - `capacitor.config.ts` — bundle id `com.neuralconnexions.app`, scheme `neuralconnexions://`
> - `src/lib/native-deeplink.ts` — N7 path allowlist + state/nonce single-use store
> - `public/.well-known/apple-app-site-association` and `assetlinks.json` (templates with TODO placeholders)
> - Capacitor packages installed: `@capacitor/core @capacitor/cli @capacitor/android @capacitor/ios @capacitor/app @capacitor/browser @aparajita/capacitor-secure-storage`

---

## Day 0 — accounts (run in parallel with code work)

| Step | Where | Time | Notes |
| --- | --- | --- | --- |
| Apple Developer enrolment | developer.apple.com → Account | already done (G1 ✓) | Confirm Team ID; you'll need it for `apple-app-site-association`. |
| Google Play Console | play.google.com/console — "Get started" | $25, ~1 day | Identity verification can be slow. Start day 0; not blocking week-1 dev builds. |
| Cloudflare Pages project for `.well-known/` | dash.cloudflare.com → Workers & Pages → Create | 5 min | See `public/.well-known/README.md` for the exact wrangler commands. |
| DNS: `app.neuralconnexions.com` | Cloudflare DNS for `neuralconnexions.com` | 1 min | CNAME to `<pages-project>.pages.dev`, proxied (orange cloud). |

---

## Day 1 (local, on your Mac) — materialise the native projects

Prereqs you should already have or install once:

- **Xcode 16+** (App Store; ~1 hr download)
- **Android Studio** (developer.android.com/studio; ~1 hr install + SDK download)
- **Node 22** + `pnpm` (or `npm`)
- **CocoaPods** (`brew install cocoapods` or `sudo gem install cocoapods`)
- **Java 17** (Android Studio bundles one, or `brew install --cask zulu@17`)

Then, from the repo root:

```bash
# 1. Build the web app so dist/ exists for cap to copy
pnpm install        # or: npm install
pnpm build          # vite build → dist/

# 2. Generate the native shells. These are committed to the repo afterward
#    so future `cap sync` is the only step you need.
npx cap add android
npx cap add ios

# 3. Copy the web bundle + plugin code into the native shells
npx cap sync

# 4. Open each in its IDE
npx cap open android   # Android Studio
npx cap open ios       # Xcode
```

What you'll see:
- `ios/App/App/Info.plist` and `ios/App/App.xcodeproj` — open in Xcode, set the Team to your Apple Developer team, set the bundle id (should already be `com.neuralconnexions.app`).
- `android/app/build.gradle` — `applicationId "com.neuralconnexions.app"`. Sync Gradle.

---

## Day 1 — first device run (smoke test)

### Android
1. Plug in an Android phone with USB debugging on (Settings → About → tap Build Number 7×, then Settings → Developer Options → USB Debugging).
2. Android Studio → Run (▶︎). It builds a debug APK, installs, launches.
3. **Verify**: app opens, you see the auth screen, sign-in works (the Google OAuth tab opens in Custom Tabs and returns).

### iOS
1. Plug in your iPhone, trust the Mac.
2. Xcode → Signing & Capabilities → "Automatically manage signing" → select your Team.
3. Run (▶︎). Xcode builds, deploys, launches.
4. **Verify**: app opens, sign-in works.

If sign-in fails, the most common causes are:
- Supabase project's **Authentication → URL Configuration → Redirect URLs** doesn't include the deep-link callback. Add `neuralconnexions://auth/callback` and `https://app.neuralconnexions.com/auth/callback`.
- iOS: Universal Links don't activate until the phone has fetched AASA at least once *after* install. Cold-launch the app once with a network connection, then test the deep link.

---

## Day 2 (local code edits to commit back)

Once the smoke test passes, wire the runtime pieces. These are deferred from Day 1 because they only matter on a real device.

1. **Native bootstrap module** (`src/lib/native-bootstrap.ts`): subscribe to Capacitor's `App.addListener('appUrlOpen', ...)`, run `validateDeepLink`, route accordingly. Forward all rejections to `recordAuthCallbackRejection`.
2. **Patch `src/integrations/supabase/client.ts`**: when `Capacitor.isNativePlatform()`, swap the `auth.storage` from `localStorage` to a SecureStorage adapter. This keeps the session token out of the WebView's localStorage (which can be scraped by other WebView contexts in some Android OEM forks).
3. **OAuth flow**: change `onGoogle` in `src/routes/auth.tsx` to use `@capacitor/browser` (ASWebAuthenticationSession on iOS, Custom Tabs on Android) when on native. Mint the state via `mintOAuthState()`, append it to the auth URL, and validate on the callback route via `consumeOAuthState`.
4. **Device-token registration**: in the native bootstrap, after sign-in, call `registerDeviceToken({ platform, token, deviceModel, appVersion })` with the FCM token (Day 3 wires `@capacitor/push-notifications`).

---

## Day 3 — push (FCM)

1. **Firebase project**: console.firebase.google.com → Add Project → "NeuralConnexions". Add an iOS app (bundle id `com.neuralconnexions.app`) and an Android app (same).
2. **APNs auth key**: Apple Developer → Keys → "+" → Apple Push Notification service (APNs). Download the `.p8`. Upload to Firebase → Project Settings → Cloud Messaging → APNs Authentication Key.
3. **Service account JSON**: Firebase → Project Settings → Service Accounts → Generate new private key. Save as a single-line JSON in Replit Secrets as `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. **`google-services.json`** → drop into `android/app/`. **`GoogleService-Info.plist`** → drop into `ios/App/App/` and add to the Xcode target.
5. Replace the stub in `src/server/push.server.ts` with the real FCM HTTP/v1 send (OAuth2 access token from the service account JSON, then `POST /v1/projects/<project-id>/messages:send`).
6. Install `@capacitor/push-notifications`, wire token registration in the bootstrap module per Day 2.

---

## Day 5 — TestFlight + Play Internal Testing

### TestFlight
```bash
# Bump build number (in Xcode: Targets → App → General → Build)
# Product → Archive → Distribute App → App Store Connect → Upload
# In App Store Connect: TestFlight → add up to 10 internal testers
```

### Play Internal Testing
```bash
# In Android Studio: Build → Generate Signed Bundle (.aab)
# Use the upload key generated by Play Console's Play App Signing
# Play Console → Internal testing → Create release → upload .aab
# Add testers by email (up to 100) — they get a join link
```

---

## Verification checklist (signs the foundation works)

- [ ] `app.neuralconnexions.com/.well-known/apple-app-site-association` returns 200 + `Content-Type: application/json` (use `curl -I`).
- [ ] Tapping a `https://app.neuralconnexions.com/draft/<some-uuid>` link from Notes / Mail opens the app, not Safari.
- [ ] Sign-out + sign-in: a fresh `device_tokens` row appears (query in Supabase).
- [ ] Force-quit + relaunch: previous session restores from SecureStorage, no re-login.
- [ ] Tap a deep link with a junk path (`https://app.neuralconnexions.com/__not_allowed`): app opens to the home screen, an `auth_callback_rejections` row appears with `reason='path_not_allowed'`.
- [ ] Toggle airplane mode → tap deep link → reconnect: the queued URL is processed correctly when the app comes back online.

---

## What's intentionally NOT in Phase 2.5

Per spec D5:
- Share extension (NCShare from the Swift spike) → Phase 3 / D6
- Slack + MS Graph → Phase 3 / D6
- Apple Sign-In native button → Phase 3 / N5 (re-open before App Store *publication*; TestFlight doesn't need it)
- Quiet hours for push → Phase 3 polish (need real push frequency data first)
- Sentry / Crashlytics on native → out of scope (Diagnostics screen + screenshots until OCSR data justifies)

---

## Rollback plan if a release breaks

Capacitor live-update is **not** wired (intentionally — App Store review wants the JS reviewed too). To roll back:
1. Submit a hotfix build with the previous `dist/` content.
2. Until that lands, the PWA at `app.neuralconnexions.com` is the working surface — N6 explicitly preserves it.
