/**
 * GDPR posture — Phase 2.7 D8 Day 6/7.
 *
 * Two surfaces, both bound to the authenticated user via the supabase auth
 * middleware:
 *
 *   exportAccountData() → full JSON dump of every per-user table the broker
 *                         + memory + chat pipeline touches. Pre-stringified
 *                         so the server-fn serializer doesn't reject
 *                         `unknown`.
 *
 *   deleteAccount()     → SINGLE-TRANSACTION wipe via the
 *                         `public.delete_user_data(uuid)` Postgres function
 *                         (migration 20260514000000_phase27_gdpr_and_retention).
 *                         Spec §14: "Single transaction. If any delete fails,
 *                         rollback and surface the error — never leave
 *                         half-wiped state."
 *
 * Tables covered (export AND delete):
 *   user_traits, user_trait_blocks, user_provider_category_blocks,
 *   user_known_names, chat_context_log, pii_scrub_events,
 *   extraction_failures, memory_nodes, memory_edges, chat_threads,
 *   chat_messages, inference_usage, user_settings.
 *
 * Note: we do NOT delete the auth.users row itself — that's a Supabase
 * dashboard / admin-API operation outside the per-user SQL scope.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ─── Export ─────────────────────────────────────────────────────────────────

export type AccountExport = {
  /** Pre-serialized JSON of {schema, userId, exportedAt, tables}. */
  json: string;
  /** Suggested filename for the download. */
  filename: string;
  /** Row count per table for display. */
  counts: Record<string, number>;
};

export const EXPORT_TABLES = [
  "user_traits",
  "user_trait_blocks",
  "user_provider_category_blocks",
  "user_known_names",
  "chat_context_log",
  "pii_scrub_events",
  "extraction_failures",
  "memory_nodes",
  "memory_edges",
  "chat_threads",
  "chat_messages",
  "chat_message_attachments",
  "inference_usage",
  "inference_usage_daily",
  "user_settings",
] as const;

/**
 * Pure handler for exportAccountData. Exposed for direct testing — the
 * server-fn wrapper just resolves the userId from auth context and calls
 * this. Keep all data-shaping logic here so tests don't need to mock
 * tanstack/react-start.
 */
export async function exportAccountDataFor(userId: string): Promise<AccountExport> {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of EXPORT_TABLES) {
    const { data, error } = await (supabaseAdmin as any)
      .from(table)
      .select("*")
      .eq("user_id", userId);
    if (error) {
      // Tables that may not exist yet in this environment shouldn't block
      // the export — record an empty array and continue.
      if (/relation .* does not exist|schema cache/i.test(String(error.message))) {
        tables[table] = [];
        counts[table] = 0;
        continue;
      }
      throw error;
    }
    const rows = Array.isArray(data) ? data : [];
    tables[table] = rows;
    counts[table] = rows.length;
  }

  const payload = {
    schema: "neuralconnexions.account-export.v1",
    userId,
    exportedAt: new Date().toISOString(),
    tables,
  };
  const json = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { json, filename: `nc-account-export-${stamp}.json`, counts };
}

export const exportAccountData = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(({ context }): Promise<AccountExport> => exportAccountDataFor(context.userId));

// ─── Delete ─────────────────────────────────────────────────────────────────

export type AccountDeleteResult = {
  deleted: boolean;
  /** Per-table delete count returned by the Postgres function. */
  perTable: Record<string, number>;
};

/** Map RPC return columns → human-readable table names for the UI. */
export const RPC_COLUMN_TO_TABLE: Record<string, string> = {
  chat_messages_deleted: "chat_messages",
  chat_message_attachments_deleted: "chat_message_attachments",
  chat_threads_deleted: "chat_threads",
  chat_context_log_deleted: "chat_context_log",
  pii_scrub_events_deleted: "pii_scrub_events",
  extraction_failures_deleted: "extraction_failures",
  user_trait_blocks_deleted: "user_trait_blocks",
  user_provider_category_blocks_del: "user_provider_category_blocks",
  user_known_names_deleted: "user_known_names",
  user_traits_deleted: "user_traits",
  memory_edges_deleted: "memory_edges",
  memory_nodes_deleted: "memory_nodes",
  inference_usage_deleted: "inference_usage",
  inference_usage_daily_deleted: "inference_usage_daily",
  user_settings_deleted: "user_settings",
};

/**
 * Pure handler for deleteAccount. Same rationale as exportAccountDataFor:
 * keep the data path testable without mocking tanstack/react-start.
 */
export async function deleteAccountFor(userId: string): Promise<AccountDeleteResult> {
  const { data, error } = await (supabaseAdmin as any).rpc("delete_user_data", {
    target_user_id: userId,
  });
  if (error) {
    throw new Error(`Account delete failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const perTable: Record<string, number> = {};
  if (row && typeof row === "object") {
    for (const [col, label] of Object.entries(RPC_COLUMN_TO_TABLE)) {
      const v = (row as Record<string, unknown>)[col];
      perTable[label] = typeof v === "number" ? v : 0;
    }
  }
  return { deleted: true, perTable };
}

export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(({ context }): Promise<AccountDeleteResult> => deleteAccountFor(context.userId));
