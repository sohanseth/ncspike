import { Capacitor } from "@capacitor/core";

let initialized = false;

// Dynamic imports: native-only modules — loading them in a non-native build
// pulls Capacitor plugin shims that warn loudly on web.
export async function initNativeShell(): Promise<void> {
  if (initialized || !Capacitor.isNativePlatform()) return;
  initialized = true;

  // Status bar: overlay the WebView with light content on a dark background.
  // Without this iOS draws a solid white status-bar strip above the WebView.
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  await StatusBar.setOverlaysWebView({ overlay: true });
  await StatusBar.setStyle({ style: Style.Dark });

  // Keyboard: hide the iOS form-navigation accessory bar (the ↑↓✓ strip
  // above the keyboard) and set the keyboard appearance to dark to match the
  // app. The plugin's `resize: native` mode (configured in capacitor.config.ts)
  // makes the WebView itself shrink when the keyboard rises, so
  // `fixed inset-0` / `100dvh` panels reflow naturally — no need to fight
  // WKWebView's built-in input-scrolling from JS.
  const { Keyboard, KeyboardStyle } = await import("@capacitor/keyboard");
  await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {
    /* iOS-only — ignore on Android. */
  });
  await Keyboard.setStyle({ style: KeyboardStyle.Dark }).catch(() => {
    /* iOS-only — ignore on Android. */
  });
}
