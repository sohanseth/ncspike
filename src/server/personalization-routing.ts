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
import { scrubErrorMessage } from "@/server/agents/error-scrub";

export type ResolvedBadge = {
  /** The badge actually used to resolve the chain. */
  badge: Badge;
  /** True iff the original badge was overridden because user_settings said
   *  private_only_mode = true. */
  coercedFromPrivateOnly: boolean;
  /** True iff the badge was coerced because we could not verify the user's
   *  private_only_mode flag (DB error / network hiccup). Fail-closed: when
   *  we don't know the user's choice, the safest assumption is that they
   *  asked for PRIVATE — never the other way around. The chain runner mirrors
   *  this onto inference_usage so we can audit fail-closed events. */
  coercedFromDbFailure: boolean;
};

/**
 * Coerce the badge to `"private"` when the user has PRIVATE-only mode on.
 *
 * **Fail-closed contract** (replit.md "no silent fallbacks"): if the
 * user_settings lookup errors or throws, we coerce to `"private"` rather
 * than honour the requested hosted badge. Rationale: a user who turned
 * Strict on must never be routed to a hosted provider just because Supabase
 * hiccupped. The reverse error (a non-Strict user briefly downgraded to
 * PRIVATE on a flap) is preferable — it's recoverable on the next turn and
 * never violates the privacy promise.
 */
export async function resolveBadgeForUser(
  userId: string,
  requested: Badge,
): Promise<ResolvedBadge> {
  if (requested === "private") {
    return {
      badge: "private",
      coercedFromPrivateOnly: false,
      coercedFromDbFailure: false,
    };
  }
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("user_settings")
      .select("private_only_mode")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      // Supabase returns errors via the result envelope rather than throwing
      // for many query failures (RLS, transient network, schema drift).
      // Fail-closed: route to PRIVATE because we can't verify the user's
      // explicit choice, and the most-private chain is the only safe default.
      console.warn(
        "[personalization-routing] user_settings lookup returned error, failing closed to PRIVATE:",
        scrubErrorMessage(error.message ?? error),
      );
      return {
        badge: "private",
        coercedFromPrivateOnly: false,
        coercedFromDbFailure: true,
      };
    }
    if (data?.private_only_mode === true) {
      return {
        badge: "private",
        coercedFromPrivateOnly: true,
        coercedFromDbFailure: false,
      };
    }
    return {
      badge: requested,
      coercedFromPrivateOnly: false,
      coercedFromDbFailure: false,
    };
  } catch (e) {
    console.warn(
      "[personalization-routing] resolveBadgeForUser threw, failing closed to PRIVATE:",
      scrubErrorMessage(e),
    );
    return {
      badge: "private",
      coercedFromPrivateOnly: false,
      coercedFromDbFailure: true,
    };
  }
}
