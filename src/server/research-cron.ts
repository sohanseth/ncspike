/**
 * Cron driver for the overnight research queue.
 *
 * Two entry points:
 *   - runResearchBatchAllUsers()        — used by the Cloudflare Worker cron
 *                                          (src/worker.ts → triggers.crons)
 *   - runResearchBatchForUserId(userId) — used by the per-user server fn
 *                                          (src/server/native.functions.ts),
 *                                          which the native BackgroundTasks
 *                                          / WorkManager path calls. Per N3
 *                                          we never let the client trigger
 *                                          the all-users path.
 *
 * Both share the same per-user execution body so behaviour (limit, retention
 * sweep, error isolation) stays identical across triggers.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runResearchBatch } from "@/server/research-queue";

export type CronSummary = {
  users: number;
  attempted: number;
  succeeded: number;
  failed: number;
  errors: Array<{ userId: string; error: string }>;
};

export type PerUserResult = {
  userId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  error?: string;
};

const DEFAULT_PER_USER_LIMIT = 20;

/**
 * Run the research queue for a single user. Used by both the all-users
 * cron loop and the native per-user server fn. Never throws — caller gets a
 * summary object so one bad user can't poison batched callers.
 */
export async function runResearchBatchForUserId(
  userId: string,
  opts: { perUserLimit?: number } = {},
): Promise<PerUserResult> {
  const limit = opts.perUserLimit ?? DEFAULT_PER_USER_LIMIT;
  try {
    const r = await runResearchBatch(userId, { limit });
    return {
      userId,
      attempted: r.attempted,
      succeeded: r.succeeded,
      failed: r.failed,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[research-cron] user ${userId} failed:`, msg);
    return { userId, attempted: 0, succeeded: 0, failed: 0, error: msg };
  }
}

/**
 * Best-effort retention sweep. Idempotent — safe to call from concurrent
 * cron paths (Worker + native) without locking. Failures are logged, never
 * thrown, because the sweep is housekeeping, not a contract.
 */
async function sweepRetention(): Promise<void> {
  try {
    const { data: cleaned, error } = await (supabaseAdmin as any).rpc(
      "cleanup_phase2_retention",
    );
    if (error) {
      console.warn("[research-cron] retention sweep failed:", error);
      return;
    }
    const row = Array.isArray(cleaned) ? cleaned[0] : cleaned;
    console.log(
      `[research-cron] retention swept: research_tasks=${row?.research_tasks_deleted ?? 0} tool_invocations=${row?.tool_invocations_deleted ?? 0} device_tokens=${row?.device_tokens_deleted ?? 0} cron_run=${row?.cron_run_deleted ?? 0} push_permission_events=${row?.push_permission_events_deleted ?? 0} auth_callback_rejections=${row?.auth_callback_rejections_deleted ?? 0}`,
    );
  } catch (e) {
    console.warn("[research-cron] retention sweep threw:", e);
  }
}

export async function runResearchBatchAllUsers(
  opts: { perUserLimit?: number } = {},
): Promise<CronSummary> {
  const summary: CronSummary = {
    users: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  const { data, error } = await (supabaseAdmin as any)
    .from("research_tasks")
    .select("user_id")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString());

  if (error) {
    console.error("[research-cron] list users failed:", error);
    summary.errors.push({ userId: "<list>", error: error.message ?? String(error) });
    return summary;
  }

  const userIds = Array.from(
    new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
  );
  summary.users = userIds.length;

  for (const userId of userIds) {
    const r = await runResearchBatchForUserId(userId, opts);
    summary.attempted += r.attempted;
    summary.succeeded += r.succeeded;
    summary.failed += r.failed;
    if (r.error) summary.errors.push({ userId, error: r.error });
  }

  await sweepRetention();

  console.log(
    `[research-cron] done: users=${summary.users} attempted=${summary.attempted} ok=${summary.succeeded} fail=${summary.failed} errs=${summary.errors.length}`,
  );
  return summary;
}

// Re-export for callers that want to trigger the sweep without running a batch
// (e.g. a future "manual cleanup" admin button).
export { sweepRetention };
