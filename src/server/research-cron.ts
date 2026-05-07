/**
 * Cron driver for the overnight research queue.
 *
 * Invoked by the Cloudflare Worker `scheduled` handler (see src/worker.ts and
 * the `triggers.crons` block in wrangler.jsonc). Lists every user that has at
 * least one due `pending` research_tasks row and runs `runResearchBatch` for
 * each, sequentially. One user's failures are isolated; the cron always
 * returns a summary instead of throwing so a single bad row can't poison the
 * scheduled execution.
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
    try {
      const r = await runResearchBatch(userId, { limit: opts.perUserLimit ?? 20 });
      summary.attempted += r.attempted;
      summary.succeeded += r.succeeded;
      summary.failed += r.failed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[research-cron] user ${userId} failed:`, msg);
      summary.errors.push({ userId, error: msg });
    }
  }

  console.log(
    `[research-cron] done: users=${summary.users} attempted=${summary.attempted} ok=${summary.succeeded} fail=${summary.failed} errs=${summary.errors.length}`,
  );
  return summary;
}
