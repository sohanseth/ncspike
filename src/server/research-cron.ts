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
import { runTraitExtractionAllUsers } from "@/server/trait-extraction";
import { runImageBlockedAlertCheck } from "@/server/cpaud-alerts";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

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
    // Independent best-effort relay sweep; never log rows or credentials.
    try {
      const { data: relay, error: relayError } = await supabaseAdmin.rpc("cleanup_relay");
      if (!relayError && relay && typeof relay === "object" && !Array.isArray(relay)) {
        console.log(`[research-cron] relay swept: cards=${Number(relay.cards) || 0} codes=${Number(relay.codes) || 0} attempts=${Number(relay.attempts) || 0} devices=${Number(relay.devices) || 0}`);
      }
    } catch { /* Telemetry failures must not interrupt retention. */ }
    if (error) {
      console.warn("[research-cron] retention sweep failed:", scrubErrorMessage(error.message ?? String(error)));
      return;
    }
    const row = Array.isArray(cleaned) ? cleaned[0] : cleaned;
    console.log(
      `[research-cron] retention swept: research_tasks=${row?.research_tasks_deleted ?? 0} tool_invocations=${row?.tool_invocations_deleted ?? 0} device_tokens=${row?.device_tokens_deleted ?? 0} cron_run=${row?.cron_run_deleted ?? 0} push_permission_events=${row?.push_permission_events_deleted ?? 0} auth_callback_rejections=${row?.auth_callback_rejections_deleted ?? 0} chat_context_log=${row?.chat_context_log_deleted ?? 0} pii_scrub_events=${row?.pii_scrub_events_deleted ?? 0} extraction_failures=${row?.extraction_failures_deleted ?? 0}`,
    );
  } catch (e) {
    console.warn("[research-cron] retention sweep threw:", scrubErrorMessage(e));
  }
}

/**
 * Storage retention. Stored files can't be deleted from SQL (Supabase
 * blocks deletes on its storage tables), so the nightly job uses the
 * Storage API: delete files in chat-attachments that are more than a day
 * old and have no chat_message_attachments row. Anything the app links to
 * — including images it shows from `<userId>/imagegen/` — is kept.
 * Best-effort: logged, never thrown.
 */
async function sweepOrphanedAttachments(): Promise<void> {
  const BUCKET = "chat-attachments";
  const KEEP_PREFIX = "/imagegen/";
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  try {
    const storage = supabaseAdmin.storage as unknown as {
      from: (b: string) => {
        list: (path: string, opts?: { limit?: number; offset?: number }) => Promise<{
          data: Array<{ name: string; id: string | null; created_at?: string }> | null;
          error: unknown;
        }>;
        remove: (paths: string[]) => Promise<{ error: unknown }>;
      };
    };
    const cutoff = Date.now() - MAX_AGE_MS;

    // Root entries are per-user folders.
    const { data: roots, error: rootErr } = await storage.from(BUCKET).list("", { limit: 1000 });
    if (rootErr) {
      console.warn("[research-cron] attachment sweep list failed:", scrubErrorMessage((rootErr as { message?: string }).message));
      return;
    }
    const orphans: string[] = [];
    for (const root of roots ?? []) {
      if (root.id !== null) continue; // not a folder
      const userDir = root.name;
      let offset = 0;
      for (;;) {
        const { data: entries, error } = await storage.from(BUCKET).list(userDir, { limit: 1000, offset });
        if (error) break;
        const list = entries ?? [];
        for (const e of list) {
          if (e.id === null) continue; // subfolder (e.g. imagegen/) — kept
          const created = e.created_at ? Date.parse(e.created_at) : 0;
          if (created && created > cutoff) continue; // too new to sweep
          orphans.push(`${userDir}/${e.name}`);
        }
        if (list.length < 1000) break;
        offset += 1000;
      }
    }
    if (!orphans.length) return;

    // Keep anything still referenced by a chat_message_attachments row.
    const { data: linked } = await (supabaseAdmin as any)
      .from("chat_message_attachments")
      .select("storage_path")
      .in("storage_path", orphans);
    const linkedSet = new Set(((linked ?? []) as Array<{ storage_path: string }>).map((r) => r.storage_path));
    const deletable = orphans.filter((p) => !linkedSet.has(p) && !p.includes(KEEP_PREFIX));
    for (let i = 0; i < deletable.length; i += 1000) {
      const { error } = await storage.from(BUCKET).remove(deletable.slice(i, i + 1000));
      if (error) {
        console.warn("[research-cron] attachment sweep remove failed:", scrubErrorMessage((error as { message?: string }).message));
        return;
      }
    }
    if (deletable.length) {
      console.log(`[research-cron] orphaned attachments swept: ${deletable.length}`);
    }
  } catch (e) {
    console.warn("[research-cron] attachment sweep threw:", scrubErrorMessage(e));
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
    console.error("[research-cron] list users failed:", scrubErrorMessage(error.message ?? String(error)));
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

  // Phase 2.7 D8: trait sheet extraction for all users with recent memory.
  // Runs after the research queue and BEFORE retention sweep so any
  // extraction_failures rows we just wrote aren't immediately swept away.
  // Errors isolated inside runTraitExtractionAllUsers — never thrown here.
  try {
    await runTraitExtractionAllUsers();
  } catch (e) {
    console.error("[research-cron] trait extraction batch threw:", scrubErrorMessage(e));
  }

  await sweepRetention();
  await sweepOrphanedAttachments();

  // Task #50 — push alert when on-device image refusals spike. Best-effort:
  // never throws here, never blocks the cron summary.
  try {
    const r = await runImageBlockedAlertCheck();
    if (r.alerts.length > 0) {
      console.log(
        `[research-cron] image-blocked alert fired for ${r.alerts.length} adapter(s); webhook attempted=${r.webhookAttempted} delivered=${r.webhookDelivered}`,
      );
    }
  } catch (e) {
    console.warn("[research-cron] image-blocked alert check threw:", scrubErrorMessage(e));
  }

  console.log(
    `[research-cron] done: users=${summary.users} attempted=${summary.attempted} ok=${summary.succeeded} fail=${summary.failed} errs=${summary.errors.length}`,
  );
  return summary;
}

// Re-export for callers that want to trigger the sweep without running a batch
// (e.g. a future "manual cleanup" admin button).
export { sweepRetention };
