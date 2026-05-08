/**
 * Deep-link primitives for the native shell (N7 hardening).
 *
 * This module is intentionally pure logic + a thin storage abstraction. It
 * does NOT subscribe to Capacitor's `appUrlOpen` event — that wiring lives
 * in src/lib/native-bootstrap.ts (Day-2 work) so this file stays trivially
 * unit-testable in a Node environment.
 *
 * What N7 buys us:
 *   1. Path allowlist: only known routes can be opened via deep link, so a
 *      malicious link can't navigate the WebView to an arbitrary internal
 *      route or trigger a server fn we didn't intend to expose externally.
 *   2. State+nonce single-use: the OAuth callback enforces that the `state`
 *      parameter (a) was minted by us, (b) hasn't expired, (c) hasn't been
 *      consumed already. This blocks both replay and CSRF on the OAuth path.
 *   3. Telemetry: every rejection lands in auth_callback_rejections so we
 *      can spot probing.
 *
 * Storage backend:
 *   - Native (Capacitor available): @aparajita/capacitor-secure-storage
 *     (Keychain on iOS, EncryptedSharedPreferences on Android). State and
 *     nonce live there because they're short-lived security material.
 *   - Web: sessionStorage. Same lifetime semantics as the native case (one
 *     auth attempt), and clears on tab close.
 */

// ---------------------------------------------------------------------------
// Path allowlist
// ---------------------------------------------------------------------------

/**
 * The only paths a deep link is allowed to open. Anything else fails the
 * `path_not_allowed` check and is logged. UUID and other dynamic segments
 * are matched with regex anchors; keep this list narrow.
 */
export const ALLOWED_DEEPLINK_PATHS: ReadonlyArray<RegExp> = [
  // OAuth + email-magic-link callbacks. Sole entry point for Supabase auth
  // tokens arriving from the system browser.
  /^\/auth\/callback$/,
  // Open a specific draft. UUID is validated at the route level.
  /^\/draft\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // Phase 3 share-extension landing page. Stub for now; route doesn't exist
  // yet but the allowlist entry is here so we don't have to ship a new
  // bundle when Phase 3 enables share-extension.
  /^\/shared$/,
  // Workspace home. Universal Link from the marketing site.
  /^\/workspace$/,
];

/**
 * Hosts allowed to deliver Universal Links / App Links to the app. The
 * native bundle's entitlements pin to these exact hosts; the JS check is
 * defence-in-depth for cases where the OS hands us a URL anyway.
 */
export const ALLOWED_DEEPLINK_HOSTS: ReadonlyArray<string> = [
  "app.neuralconnexions.com",
  "neuralconnexions.com",
];

/** Custom-scheme fallback. Used only if Universal Links fail to register
 *  (e.g. user has the app installed but tapped a link before AASA sync). */
export const DEEPLINK_SCHEME = "neuralconnexions";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type DeepLinkValidation =
  | { ok: true; path: string; query: URLSearchParams }
  | {
      ok: false;
      reason:
        | "malformed_url"
        | "path_not_allowed"
        | "host_not_allowed";
      urlHost?: string;
      urlPath?: string;
    };

/**
 * Validate that a URL is safe to open inside the app. Pure function — does
 * not touch storage, does not record telemetry. Caller is responsible for
 * forwarding rejections to recordAuthCallbackRejection.
 */
export function validateDeepLink(rawUrl: string): DeepLinkValidation {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed_url" };
  }

  // Custom scheme: skip host check (the scheme itself is the entitlement).
  // Universal/App Link: enforce host allowlist.
  if (parsed.protocol !== `${DEEPLINK_SCHEME}:`) {
    if (parsed.protocol !== "https:") {
      return {
        ok: false,
        reason: "host_not_allowed",
        urlHost: parsed.hostname,
        urlPath: parsed.pathname,
      };
    }
    if (!ALLOWED_DEEPLINK_HOSTS.includes(parsed.hostname)) {
      return {
        ok: false,
        reason: "host_not_allowed",
        urlHost: parsed.hostname,
        urlPath: parsed.pathname,
      };
    }
  }

  const path = parsed.pathname || "/";
  const matches = ALLOWED_DEEPLINK_PATHS.some((re) => re.test(path));
  if (!matches) {
    return {
      ok: false,
      reason: "path_not_allowed",
      urlHost: parsed.hostname,
      urlPath: path,
    };
  }

  return { ok: true, path, query: parsed.searchParams };
}

// ---------------------------------------------------------------------------
// State + nonce single-use store
// ---------------------------------------------------------------------------

const STATE_KEY = "nc.oauth.state";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for the OAuth
                                      // round-trip with a slow user, short
                                      // enough to bound replay window.

type StoredState = {
  state: string;
  nonce: string;
  createdAt: number;
};

/**
 * Storage abstraction. We probe for Capacitor's SecureStoragePlugin lazily
 * (so this module imports cleanly in SSR / web-only builds), and fall back
 * to sessionStorage when not running natively. Both backends are async to
 * keep the public API uniform.
 */
type SecureStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

let _store: SecureStore | null = null;

async function getStore(): Promise<SecureStore> {
  if (_store) return _store;

  // Try the native plugin first. Dynamic import so SSR doesn't choke.
  try {
    // @ts-expect-error — optional native dep; resolved at runtime when present
    const cap = await import("@capacitor/core");
    if (cap?.Capacitor?.isNativePlatform?.()) {
      // @ts-expect-error — optional native dep
      const ss = await import("@aparajita/capacitor-secure-storage");
      // The aparajita plugin exports `SecureStorage` with promise-based
      // get/set/remove that take a key string directly (not an options bag).
      const plugin = ss.SecureStorage;
      _store = {
        async get(key) {
          const v = await plugin.get(key);
          return v == null ? null : String(v);
        },
        async set(key, value) {
          await plugin.set(key, value);
        },
        async remove(key) {
          await plugin.remove(key);
        },
      };
      return _store;
    }
  } catch {
    // Either Capacitor isn't installed (SSR / pure web) or we're not on
    // a native platform. Fall through to sessionStorage.
  }

  // Web fallback. sessionStorage clears on tab close, which matches the
  // single-OAuth-attempt lifetime we want.
  _store = {
    async get(key) {
      if (typeof sessionStorage === "undefined") return null;
      return sessionStorage.getItem(key);
    },
    async set(key, value) {
      if (typeof sessionStorage === "undefined") return;
      sessionStorage.setItem(key, value);
    },
    async remove(key) {
      if (typeof sessionStorage === "undefined") return;
      sessionStorage.removeItem(key);
    },
  };
  return _store;
}

/**
 * Generate cryptographically random hex of `bytes` length. Uses Web Crypto
 * (available in browsers, Capacitor WebView, Workers, modern Node).
 */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a new state+nonce pair, persist them, and return them so the caller
 * can include them in the OAuth authorization request. ANY previous unused
 * state is overwritten — there's only ever one in-flight OAuth attempt per
 * device, so the storage slot is single-tenant.
 *
 * Serialized via the store mutex so a mint in flight at the same time as a
 * consume can't race the slot.
 */
export async function mintOAuthState(): Promise<{ state: string; nonce: string }> {
  return withStoreMutex(async () => {
    const state = randomHex(32);
    const nonce = randomHex(32);
    const stored: StoredState = { state, nonce, createdAt: Date.now() };
    const store = await getStore();
    await store.set(STATE_KEY, JSON.stringify(stored));
    return { state, nonce };
  });
}

export type StateConsumeResult =
  | { ok: true; nonce: string }
  | {
      ok: false;
      reason:
        | "state_missing"
        | "state_mismatch"
        | "state_expired"
        | "state_replayed"
        | "store_failure";
    };

/**
 * Validate a callback's `state` against the stored value AND consume it
 * (delete from storage) so a replayed callback fails with `state_missing`
 * on the second attempt. Caller must forward `ok:false` outcomes to
 * recordAuthCallbackRejection.
 *
 * Serialization: in JS, this is single-threaded *per process*, but if two
 * `appUrlOpen` events fire back-to-back (e.g. an Android Custom Tab plus a
 * separately-handled Universal Link race), naive get→remove can let both
 * read the stored value before either remove completes. We guard with a
 * promise-chain mutex (`withStoreMutex`) so any concurrent calls serialize
 * and the second one observes the empty slot.
 *
 * Cross-device or cross-process replay is *not* possible because state is
 * stored in device-local Keychain/EncryptedSharedPreferences (or
 * sessionStorage on web), all of which are scoped to a single app install.
 *
 * Failure mode: if the underlying store throws, we fail closed with
 * `store_failure` so a broken Keychain doesn't degrade silently into "no
 * state therefore unauthenticated callback accepted".
 */
export async function consumeOAuthState(
  presentedState: string,
): Promise<StateConsumeResult> {
  return withStoreMutex(async (): Promise<StateConsumeResult> => {
    let store: SecureStore;
    let raw: string | null;
    try {
      store = await getStore();
      raw = await store.get(STATE_KEY);
    } catch (e) {
      console.warn("[native-deeplink] store get failed:", e);
      return { ok: false, reason: "store_failure" };
    }

    if (!raw) {
      return { ok: false, reason: "state_missing" };
    }

    let parsed: StoredState;
    try {
      parsed = JSON.parse(raw) as StoredState;
    } catch {
      try { await store.remove(STATE_KEY); } catch { /* best-effort */ }
      return { ok: false, reason: "state_missing" };
    }

    // Single-use: remove BEFORE comparison so even an exception below leaves
    // the slot empty. Combined with the mutex above, this is the atomic
    // critical section that defeats concurrent replay.
    try {
      await store.remove(STATE_KEY);
    } catch (e) {
      // If we can't delete, fail closed — accepting the callback would let
      // a future replay succeed since the slot is still populated.
      console.warn("[native-deeplink] store remove failed:", e);
      return { ok: false, reason: "store_failure" };
    }

    if (Date.now() - parsed.createdAt > STATE_TTL_MS) {
      return { ok: false, reason: "state_expired" };
    }
    if (typeof presentedState !== "string" || presentedState.length === 0) {
      return { ok: false, reason: "state_mismatch" };
    }
    if (!constantTimeEqual(parsed.state, presentedState)) {
      return { ok: false, reason: "state_mismatch" };
    }

    return { ok: true, nonce: parsed.nonce };
  });
}

// ---------------------------------------------------------------------------
// In-process mutex
// ---------------------------------------------------------------------------
// Promise-chain mutex: each call awaits the previous tail before running, so
// store operations on STATE_KEY are observed in source order. Cheap (no
// timers, no Atomics), and adequate because (a) JS is single-threaded per
// realm and (b) we only need to serialize within this single module.
let _mutexTail: Promise<unknown> = Promise.resolve();
function withStoreMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = _mutexTail.then(fn, fn);
  // Swallow the result for the chain so a rejection in one caller doesn't
  // poison the next; each caller still gets its own original promise.
  _mutexTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
