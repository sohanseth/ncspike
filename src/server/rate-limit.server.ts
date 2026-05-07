/**
 * Per-user, per-tool sliding-window rate limit for agent-tool invocations.
 *
 * Why DB-backed: the edge runtime is multi-instance with no shared memory, so
 * an in-process counter would let a user fan out across instances and bypass
 * the limit. Counting rows in `tool_invocations` over a recent window is the
 * cheapest correct option.
 *
 * Why permissive defaults: V1 limits are sized to catch runaway loops and
 * abuse, not to bill users. Tighten later when we have real usage curves.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type RateLimitDecision =
  | { ok: true; remaining: number }
  | { ok: false; limit: number; windowSeconds: number; retryAfterSeconds: number };

type Limit = { perHour: number };

// Conservative defaults. Mutating tools get tighter caps because they create
// real calendar events / send mail; read-only tools only burn LLM budget.
const DEFAULT_LIMIT: Limit = { perHour: 30 };
const TOOL_LIMITS: Record<string, Limit> = {
  block_prep_time:        { perHour: 20 },
  set_followup_reminder:  { perHour: 20 },
  suggest_availability:   { perHour: 60 },
  research_thread_context:{ perHour: 30 },
};

/**
 * Check the limit and (if allowed) record an invocation. Returns the decision
 * so the caller can surface a useful error. Failing closed on DB errors would
 * make the whole agent unusable during transient outages, so we fail open with
 * a console.warn — the limit is a guardrail, not a security boundary.
 *
 * Atomicity caveat: count + insert are separate statements, so a burst of
 * concurrent calls for the same (user, tool) can briefly overshoot the cap by
 * the parallelism factor. Acceptable for V1 because (a) the cap is a runaway
 * guard, not billing enforcement, and (b) tightening it requires a SQL fn or
 * advisory lock — worth the extra complexity only once we see real overshoot.
 */
export async function enforceToolRateLimit(
  userId: string,
  toolId: string,
): Promise<RateLimitDecision> {
  const limit = TOOL_LIMITS[toolId] ?? DEFAULT_LIMIT;
  const windowSeconds = 3600;
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();

  const { count, error: countErr } = await (supabaseAdmin as any)
    .from("tool_invocations")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("tool_id", toolId)
    .gte("created_at", since);

  if (countErr) {
    console.warn("[rate-limit] count failed; allowing call:", countErr);
    return { ok: true, remaining: limit.perHour };
  }
  const used = count ?? 0;
  if (used >= limit.perHour) {
    return {
      ok: false,
      limit: limit.perHour,
      windowSeconds,
      // Coarse: tell the user to retry in 5 min. Sliding-window precise math
      // would require pulling the oldest row's timestamp; not worth it for V1.
      retryAfterSeconds: 300,
    };
  }

  // Record the invocation. We do this before dispatch so a long-running tool
  // call can't be issued twice while the first is in flight. Errors logged but
  // not thrown — the count check above is the actual guard.
  const { error: insErr } = await (supabaseAdmin as any)
    .from("tool_invocations")
    .insert({ user_id: userId, tool_id: toolId });
  if (insErr) console.warn("[rate-limit] insert failed (non-fatal):", insErr);

  return { ok: true, remaining: limit.perHour - used - 1 };
}
