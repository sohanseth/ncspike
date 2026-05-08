/**
 * Server fns called by the Capacitor native shell.
 *
 * All exports here are TanStack Start server fns (POST). Auth is enforced
 * via `requireSupabaseAuth`, which extracts the userId from the bearer
 * token. We never accept userId as a client-supplied argument for anything
 * that touches user data — the cron fn (N3) explicitly cross-checks the
 * authenticated userId against the request body so a forged or replayed
 * call from a stale token can't trigger work for someone else's account.
 *
 * Note on transport: every fn here is .method('POST'). TanStack Start
 * defaults to POST anyway, but we set it explicitly so the contract is
 * obvious to anyone reading the file.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runResearchBatchForUserId } from "@/server/research-cron";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegisterDeviceTokenInput = {
  platform: "ios" | "android";
  token: string;
  deviceModel?: string;
  appVersion?: string;
};

export type CronRunInput = {
  source: "native_ios" | "native_android" | "manual";
  status: "ok" | "noop" | "error" | "timeout";
  attempted?: number;
  succeeded?: number;
  failed?: number;
  durationMs?: number;
  errorMessage?: string;
};

export type PushPermissionEventInput = {
  platform: "ios" | "android";
  event:
    | "primer_shown"
    | "primer_accepted"
    | "primer_dismissed"
    | "os_granted"
    | "os_denied"
    | "os_provisional"
    | "state_check";
  osState?: string;
  appVersion?: string;
};

export type AuthCallbackRejectionInput = {
  reason:
    | "path_not_allowed"
    | "host_not_allowed"
    | "state_missing"
    | "state_mismatch"
    | "state_expired"
    | "state_replayed"
    | "nonce_missing"
    | "nonce_mismatch"
    | "malformed_url";
  urlHost?: string;
  urlPath?: string;
  clientInfo?: string;
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const PLATFORMS = new Set(["ios", "android"]);

function assertPlatform(p: unknown): asserts p is "ios" | "android" {
  if (typeof p !== "string" || !PLATFORMS.has(p)) {
    throw new Response("Invalid platform", { status: 400 });
  }
}

function assertNonEmptyString(v: unknown, field: string): asserts v is string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Response(`Invalid ${field}`, { status: 400 });
  }
}

// FCM tokens are typically 140-200 chars; cap at 4096 to absorb future growth
// while still rejecting obvious garbage.
const MAX_TOKEN_LEN = 4096;
function assertTokenShape(token: unknown): asserts token is string {
  assertNonEmptyString(token, "token");
  if ((token as string).length > MAX_TOKEN_LEN) {
    throw new Response("Token too long", { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Server fns
// ---------------------------------------------------------------------------

/**
 * Register or refresh an FCM/APNs token for the calling user's device.
 * Idempotent on (token) thanks to the unique index — we upsert last_seen_at
 * so retention can prune dead installs.
 */
export const registerDeviceToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RegisterDeviceTokenInput) => {
    assertPlatform(input?.platform);
    assertTokenShape(input?.token);
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;

    // Upsert via "do nothing" on conflict + a follow-up update so we don't
    // need a server-side function. Two-statement form is fine because the
    // unique key is the token itself, not a composite.
    const { error: insErr } = await (supabaseAdmin as any)
      .from("device_tokens")
      .upsert(
        {
          user_id: userId,
          platform: data.platform,
          token: data.token,
          device_model: data.deviceModel ?? null,
          app_version: data.appVersion ?? null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "token" },
      );

    if (insErr) {
      console.error("[native:registerDeviceToken] upsert failed:", insErr);
      throw new Response("Failed to register device", { status: 500 });
    }

    return { ok: true as const };
  });

/**
 * Remove a token (user signed out on this device, or app uninstall hook).
 * Scoped to the calling user — RLS would catch a cross-user attempt anyway,
 * but we filter on user_id explicitly so the service-role write can't be
 * misused via a forged token argument.
 */
export const unregisterDeviceToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string }) => {
    assertTokenShape(input?.token);
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { error } = await (supabaseAdmin as any)
      .from("device_tokens")
      .delete()
      .eq("token", data.token)
      .eq("user_id", userId);

    if (error) {
      console.error("[native:unregisterDeviceToken] delete failed:", error);
      throw new Response("Failed to unregister device", { status: 500 });
    }

    return { ok: true as const };
  });

/**
 * Per-N3: native background task triggers a research batch for *this user
 * only*. The Worker cron remains the source-of-truth all-users path; this
 * exists so the OS scheduler can opportunistically catch up if the user
 * opens the app shortly after midnight. `runResearchBatch` is itself
 * idempotent (claims pending → running atomically), so a duplicate run from
 * Worker + native is safe.
 */
export const runResearchBatchForUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { perUserLimit?: number } | undefined) => {
    const limit = input?.perUserLimit;
    if (limit !== undefined && (typeof limit !== "number" || limit < 1 || limit > 100)) {
      throw new Response("Invalid perUserLimit", { status: 400 });
    }
    return { perUserLimit: limit };
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const result = await runResearchBatchForUserId(userId, {
      perUserLimit: data.perUserLimit,
    });
    return result;
  });

/**
 * Native cron observability. Records that the OS scheduler fired and what
 * it accomplished, so the Diagnostics screen can answer "is background
 * fetch actually running on this device?".
 */
export const recordCronRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CronRunInput) => {
    if (!["native_ios", "native_android", "manual"].includes(input?.source)) {
      throw new Response("Invalid source", { status: 400 });
    }
    if (!["ok", "noop", "error", "timeout"].includes(input?.status)) {
      throw new Response("Invalid status", { status: 400 });
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { error } = await (supabaseAdmin as any).from("cron_run").insert({
      source: data.source,
      status: data.status,
      user_id: userId,
      attempted: data.attempted ?? 0,
      succeeded: data.succeeded ?? 0,
      failed: data.failed ?? 0,
      duration_ms: data.durationMs ?? null,
      error_message: data.errorMessage ?? null,
    });

    if (error) {
      console.error("[native:recordCronRun] insert failed:", error);
      // Don't throw — telemetry failure must not break the actual cron path.
      return { ok: false as const };
    }
    return { ok: true as const };
  });

/**
 * Append-only OCSR telemetry. See spec N4 for cohort math.
 */
export const recordPushPermissionEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: PushPermissionEventInput) => {
    assertPlatform(input?.platform);
    const events = new Set([
      "primer_shown",
      "primer_accepted",
      "primer_dismissed",
      "os_granted",
      "os_denied",
      "os_provisional",
      "state_check",
    ]);
    if (!events.has(input?.event)) {
      throw new Response("Invalid event", { status: 400 });
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { error } = await (supabaseAdmin as any)
      .from("push_permission_events")
      .insert({
        user_id: userId,
        platform: data.platform,
        event: data.event,
        os_state: data.osState ?? null,
        app_version: data.appVersion ?? null,
      });

    if (error) {
      console.warn("[native:recordPushPermissionEvent] insert failed:", error);
      return { ok: false as const };
    }
    return { ok: true as const };
  });

/**
 * N7 telemetry. Note this fn does NOT require auth — pre-login OAuth
 * callbacks have no user context. We log url_host/url_path only (never the
 * raw URL, which could carry a real OAuth code on a misrouted-but-legit
 * callback).
 *
 * Hardening for an unauthenticated, service-role-bypassing endpoint:
 *   1. Length caps on every text field (DB writes are bounded).
 *   2. Process-local token bucket so a single edge instance can't be used
 *      to flood the table. With multiple edge instances this is best-effort
 *      (each instance has its own bucket), but the cap × instance count is
 *      still small enough to not bloat the DB. Real per-IP throttling needs
 *      a request middleware; deferred until we see actual abuse.
 *   3. The auth_callback_rejections table itself has a 30-day TTL via
 *      cleanup_phase2_retention(), so even sustained abuse caps total rows.
 */
const REJECTION_MAX_HOST = 253;     // RFC 1035 max FQDN length
const REJECTION_MAX_PATH = 512;     // generous; real paths are <100 chars
const REJECTION_MAX_CLIENT = 256;   // user-agent-ish

// Token bucket: 60 records / 60s per process. Generous enough for a busy
// burst of legitimate rejections after a release breaks a deep link;
// tight enough to defang a script.
const REJECTION_BUCKET_CAP = 60;
const REJECTION_BUCKET_WINDOW_MS = 60_000;
let _rejectionBucket: number[] = [];

function rejectionBucketAdmits(): boolean {
  const now = Date.now();
  const cutoff = now - REJECTION_BUCKET_WINDOW_MS;
  // Drop expired entries. O(n) but n ≤ cap so trivial.
  _rejectionBucket = _rejectionBucket.filter((t) => t > cutoff);
  if (_rejectionBucket.length >= REJECTION_BUCKET_CAP) return false;
  _rejectionBucket.push(now);
  return true;
}

function clampString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // Strip control chars (NUL etc.) which would corrupt downstream tooling.
  const cleaned = v.replace(/[\u0000-\u001F\u007F]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export const recordAuthCallbackRejection = createServerFn({ method: "POST" })
  .inputValidator((input: AuthCallbackRejectionInput) => {
    const reasons = new Set([
      "path_not_allowed",
      "host_not_allowed",
      "state_missing",
      "state_mismatch",
      "state_expired",
      "state_replayed",
      "nonce_missing",
      "nonce_mismatch",
      "malformed_url",
    ]);
    if (!reasons.has(input?.reason)) {
      throw new Response("Invalid reason", { status: 400 });
    }
    return {
      reason: input.reason,
      urlHost: clampString(input.urlHost, REJECTION_MAX_HOST),
      urlPath: clampString(input.urlPath, REJECTION_MAX_PATH),
      clientInfo: clampString(input.clientInfo, REJECTION_MAX_CLIENT),
    };
  })
  .handler(async ({ data }) => {
    // Process-local rate cap. Drop silently (200 OK) so a probing client
    // can't tell whether their request landed — denying telemetry to the
    // attacker is itself a defence.
    if (!rejectionBucketAdmits()) {
      return { ok: true as const, throttled: true as const };
    }

    // No auth context here. user_id stays null; service role bypasses RLS
    // so the row lands. Admin queries can correlate spikes.
    const { error } = await (supabaseAdmin as any)
      .from("auth_callback_rejections")
      .insert({
        user_id: null,
        reason: data.reason,
        url_host: data.urlHost,
        url_path: data.urlPath,
        client_info: data.clientInfo,
      });

    if (error) {
      console.warn("[native:recordAuthCallbackRejection] insert failed:", error);
      return { ok: false as const };
    }
    return { ok: true as const };
  });
