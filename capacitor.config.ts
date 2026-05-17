/**
 * Capacitor configuration for the NeuralConnexions native shell.
 *
 * Bundle / app identity is locked per spec D5 §N1:
 *   - appId:    com.neuralconnexions.app  (used for both iOS bundle id and
 *               Android applicationId; do NOT change after first TestFlight
 *               upload — Apple treats it as a new app)
 *   - scheme:   neuralconnexions://       (custom scheme; fallback only.
 *               Universal Links / App Links on app.neuralconnexions.com are
 *               the primary path per N7)
 *
 * The `server.url` block is intentionally NOT set: we ship the built web
 * assets *bundled* with the app so a worker-deploy doesn't ship code that
 * the App Store hasn't reviewed (per N6 — PWA is preserved, native loads
 * its own copy of the build). For dev iteration, run `npx cap run android
 * --livereload --external` which transparently injects a server.url at
 * runtime without us committing it.
 *
 * Local-Mac steps to materialize native projects (NOT runnable here):
 *   pnpm build                                          # produce dist/
 *   npx cap add android                                 # creates android/
 *   npx cap add ios                                     # creates ios/
 *   npx cap sync                                        # copy dist + plugins
 *   npx cap open android   # → Android Studio
 *   npx cap open ios       # → Xcode
 *
 * See docs/04-native-shell-runbook.md for the full handoff.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.neuralconnexions.app",
  appName: "NeuralConnexions",

  // The web build output. Vite's default is `dist/`. `npx cap sync` copies
  // this directory into the native bundle's web-assets path.
  webDir: "dist",

  // Bundle the web layer; do NOT live-load over HTTP in production. Reviews
  // hate it and it breaks offline.
  bundledWebRuntime: false,

  // Allow the WebView to navigate to our own apex when an in-app link points
  // out of the bundled app (e.g. marketing → app handoff). Universal Links
  // intercept this on iOS / Android before the WebView ever sees it; this
  // list is the WebView fallback path. Keep tight.
  server: {
    androidScheme: "https",
    // iosScheme defaults to "capacitor"; leave it.
    allowNavigation: ["app.neuralconnexions.com", "neuralconnexions.com"],
    // DEV ONLY — point the WebView at the Mac's Vite dev server so the
    // real app renders on-device. REMOVE before any TestFlight / store
    // build (per N6 — production must bundle the reviewed JS).
    // NOTE: this URL bakes into the native build at `cap sync` time, so
    // when the Mac's LAN IP changes (DHCP renewal, Wi-Fi switch) you have
    // to update here + cap sync + rebuild. To avoid that churn use the
    // Mac's mDNS hostname instead, e.g. `http://REM-LGM7KQ4RJG-2.local:5173`
    // (works on the same LAN regardless of DHCP). For now using the
    // explicit IP — simpler debugging.
    url: "http://192.168.1.101:5173",
    cleartext: true,
  },

  // Plugin-specific tuning. Each plugin we install must opt in here if it
  // needs configuration; otherwise defaults apply.
  plugins: {
    App: {
      // No options today; deep-link handling lives in src/lib/native-deeplink.ts
      // (subscribes to `appUrlOpen` and validates against the path allowlist).
    },
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: "#0b0b0f",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    Keyboard: {
      // `native` mode makes the iOS WKWebView itself shrink when the keyboard
      // appears. Combined with the chat panel using `fixed inset-x-0 top-0`
      // + dvh height, the panel reflows above the keyboard without fixed-
      // position scrolling glitches. Without this, WKWebView leaves the
      // WebView at full height and scrolls the focused input into view,
      // pushing the chat header above the visible area.
      resize: "native",
      // Hide the keyboard's accessory bar (the ↑↓✓ strip above the keys)
      // — also done at runtime via Keyboard.setAccessoryBarVisible in
      // native-bootstrap.ts, but the static config helps for first launch.
      resizeOnFullScreen: true,
    },
  },

  ios: {
    // Capacitor will write Info.plist defaults; supplemental keys (NSUser
    // TrackingUsageDescription etc.) are added in Xcode after `cap add ios`.
    contentInset: "automatic",
    // backgroundColor: shows through during iOS rubber-band overscroll at the
    // top/bottom of the page. Default is white. Pin to the app's dark surface
    // so a pull-down doesn't expose a white pane behind the WebView.
    backgroundColor: "#0b0b0f",
  },

  android: {
    allowMixedContent: false,
    // Use the system's WebView; no custom build flavour.
  },
};

export default config;
