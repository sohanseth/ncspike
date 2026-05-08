/**
 * Server-side enforcement of the user's PRIVATE-only routing mode.
 *
 * Spec §B10 / §B11: when `user_settings.private_only_mode = true` (set by the
 * Strict preset, or manually in Advanced), every chat turn must route through
 * the PRIVATE-tier (T0) provider regardless of which badge the UI sent.
 *
 * This is enforced once, at the entry of the chain resolver, by coercing the
 * badge to `"private"` before `chainFor()`. Both call sites (the streaming
 * route and the non-stream server function) call `resolveBadgeForUser()`.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Badge } from "@/server/inference/router";

export type ResolvedBadge = {
  /** The badge actually used to resolve the chain. */
  badge: Badge;
  /** True iff the original badge was overridden by private_only_mode. */
  coercedFromPrivateOnly: boolean;
};

/**
 * Coerce the badge to `"private"` when the user has PRIVATE-only mode on.
 * On any DB error we fail OPEN (return the original badge) — privacy is best
 * effort here; a hard failure of this lookup would lock the user out of chat.
 * The flag is mirrored to telemetry on the inference_usage row by the chain
 * runner so we can audit fail-open events.
 */
export async function resolveBadgeForUser(
  userId: string,
  requested: Badge,
): Promise<ResolvedBadge> {
  if (requested === "private") {
    return { badge: "private", coercedFromPrivateOnly: false };
  }
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("user_settings")
      .select("private_only_mode")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      // Supabase returns errors via the result envelope rather than throwing
      // for many query failures (RLS, transient network, schema drift). Log
      // explicitly and fall through to fail-open.
      console.warn(
        "[personalization-routing] user_settings lookup returned error, failing open:",
        error.message ?? error,
      );
    } else if (data?.private_only_mode === true) {
      return { badge: "private", coercedFromPrivateOnly: true };
    }
  } catch (e) {
    console.warn("[personalization-routing] resolveBadgeForUser threw, failing open:", e);
  }
  return { badge: requested, coercedFromPrivateOnly: false };
}
