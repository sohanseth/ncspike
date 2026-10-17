/**
 * FCM (Firebase Cloud Messaging) sender. APNs is reached *through* FCM via
 * the .p8 auth-key path per N4, so this single module covers both platforms.
 *
 * Day-1 status: SIGNATURE STUB ONLY. The actual HTTP/v1 send to
 *   https://fcm.googleapis.com/v1/projects/<project-id>/messages:send
 * lands in Day-2/3 work alongside Firebase project provisioning + the
 * GOOGLE_SERVICE_ACCOUNT_JSON secret. Until then this module logs the intent
 * so the server fn that calls it (e.g. inbox notifier) can be wired and
 * unit-tested without a live Firebase project.
 *
 * Why service-role: this module is *never* called from a client. It reads
 * device_tokens via supabaseAdmin (bypassing RLS so we can fan-out to all of
 * a user's devices) and is invoked only from other server fns that have
 * already authorized the caller.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type PushPayload = {
  /** Required. Used by the OS notification UI. */
  title: string;
  body: string;
  /** Optional. App-handled deep link, e.g. `neuralconnexions://draft/<id>`.
   *  Must match the path allowlist enforced by handleDeepLink (N7). */
  deepLink?: string;
  /** Optional. Arbitrary key/value passed through to the foreground handler. */
  data?: Record<string, string>;
};

export type PushResult = {
  attempted: number;
  delivered: number;
  pruned: number;
  errors: string[];
};

/**
 * Fan out a push to every active device the user has registered. Tokens that
 * FCM reports as Unregistered/InvalidArgument are pruned from device_tokens
 * so we don't keep retrying a dead install.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<PushResult> {
  const result: PushResult = { attempted: 0, delivered: 0, pruned: 0, errors: [] };

  const { data: tokens, error } = await (supabaseAdmin as any)
    .from("device_tokens")
    .select("token, platform")
    .eq("user_id", userId);

  if (error) {
    result.errors.push(`list tokens failed: ${error.message ?? String(error)}`);
    return result;
  }

  const rows = (tokens ?? []) as Array<{ token: string; platform: string }>;
  result.attempted = rows.length;

  if (rows.length === 0) return result;

  // Day-1 stub: log and pretend everything succeeded. Replace with real FCM
  // HTTP/v1 call (OAuth2 access token from service account JSON, then POST
  // /messages:send per token) once Firebase project is provisioned.
  for (const row of rows) {
    // Never log push titles, deep links or user ids — they can hold
    // personal content. Platform + count only.
    console.log(`[push:STUB] would send platform=${row.platform}`);
    result.delivered += 1;
  }

  return result;
}
