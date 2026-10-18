/**
 * GDPR posture — privacy fixes (prompt D).
 *
 * Two surfaces, both bound to the authenticated user via the supabase auth
 * middleware:
 *
 *   exportAccountData() → full JSON dump of every per-user table the broker
 *                         + memory + chat pipeline touches. Connections are
 *                         exported WITHOUT any token columns; drafts and the
 *                         voice profile are decrypted so the file is
 *                         readable. Pre-stringified so the server-fn
 *                         serializer doesn't reject `unknown`.
 *
 *   deleteAccount()     → deletes the ACCOUNT, not just the data:
 *                           a. signs out every session (global), so another
 *                              device can't keep writing mid-delete;
 *                           b. tries to revoke each Google token at Google
 *                              (failures are logged by error class only and
 *                              reported to the user with the
 *                              myaccount.google.com/permissions link);
 *                           c. wipes every Storage object under "<userId>/"
 *                              in every bucket the app uses — and refuses to
 *                              continue if anything is left, because the
 *                              sign-in can't be deleted while it still owns
 *                              stored files;
 *                           d. wipes every per-user row via the
 *                              single-transaction `delete_user_data(uuid)`
 *                              Postgres function (service_role-only);
 *                           e. deletes the sign-in itself.
 *                         The browser then signs out locally.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
// Loaded lazily so the server-only crypto module never enters the browser bundle.
let decryptToken: (raw: string) => string = () => {
  throw new Error("crypto not loaded");
};
async function loadCrypto(): Promise<void> {
  const mod = await import("@/server/crypto.server");
  decryptToken = mod.decryptToken;
}
import { scrubErrorMessage } from "@/server/agents/error-scrub";
import { RELAY_GDPR_TABLES } from "@/lib/gdpr.coverage";

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
  ...RELAY_GDPR_TABLES,
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
  "search_queries",
  "agents",
  "agent_runs",
  "agent_findings",
  "agent_state",
  "connections",
  "drafts",
  "voice_profiles",
  "research_tasks",
  "user_endpoints",
  "watchers",
] as const;

/** Columns that must never appear in an export. */
const SECRET_COLUMNS = new Set([
  "access_token_encrypted",
  "refresh_token_encrypted",
  "db_url_encrypted",
  "model_url_encrypted",
  "model_key_encrypted",
]);

function stripSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_COLUMNS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Decrypt a column in place, renaming it to drop the `_encrypted` suffix. */
function decryptColumn(
  row: Record<string, unknown>,
  column: string,
): Record<string, unknown> {
  const out = stripSecrets(row);
  const raw = row[column];
  if (typeof raw === "string" && raw.length > 0) {
    try {
      out[column.replace(/_encrypted$/, "")] = decryptToken(raw);
    } catch {
      out[column.replace(/_encrypted$/, "")] = null;
    }
  }
  delete out[column];
  return out;
}

function shapeRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "connections" || table === "user_endpoints") return stripSecrets(row);
  if (table === "drafts") return decryptColumn(row, "body_encrypted");
  if (table === "voice_profiles") return decryptColumn(row, "profile_encrypted");
  return row;
}

/**
 * Pure handler for exportAccountData. Exposed for direct testing — the
 * server-fn wrapper just resolves the userId from auth context and calls
 * this. Keep all data-shaping logic here so tests don't need to mock
 * tanstack/react-start.
 */
export async function exportAccountDataFor(userId: string): Promise<AccountExport> {
  await loadCrypto();
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
    tables[table] = rows.map((r) =>
      r && typeof r === "object" ? shapeRow(table, r as Record<string, unknown>) : r,
    );
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
  /**
   * True when at least one Google token could not be revoked at Google.
   * The UI then tells the person to remove NeuralConnexions at
   * https://myaccount.google.com/permissions.
   */
  googleRevokeFailed: boolean;
};

/** Map RPC return columns → human-readable table names for the UI. */
export const RPC_COLUMN_TO_TABLE: Record<string, string> = {
  relay_pairing_codes_deleted: "relay_pairing_codes",
  relay_devices_deleted: "relay_devices",
  relay_cards_deleted: "relay_cards",
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
  search_queries_deleted: "search_queries",
  agent_findings_deleted: "agent_findings",
  agent_state_deleted: "agent_state",
  agent_runs_deleted: "agent_runs",
  agents_deleted: "agents",
  connections_deleted: "connections",
  drafts_deleted: "drafts",
  voice_profiles_deleted: "voice_profiles",
  research_tasks_deleted: "research_tasks",
  user_endpoints_deleted: "user_endpoints",
  watchers_deleted: "watchers",
};

/** Storage buckets the app writes per-user files into. */
const STORAGE_BUCKETS = ["chat-attachments"] as const;
const LIST_PAGE = 1000;
const REMOVE_BATCH = 1000;

type StorageApi = {
  from: (bucket: string) => {
    list: (
      path: string,
      opts?: { limit?: number; offset?: number },
    ) => Promise<{ data: Array<{ name: string; id: string | null }> | null; error: unknown }>;
    remove: (paths: string[]) => Promise<{ error: unknown }>;
  };
};

/**
 * Recursively list every object key under `<prefix>` in one bucket, page by
 * page. Folders are entries with a null id.
 */
async function listAllObjects(
  storage: StorageApi,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  const queue: string[] = [prefix];
  while (queue.length) {
    const dir = queue.shift()!;
    let offset = 0;
    for (;;) {
      const { data, error } = await storage.from(bucket).list(dir, {
        limit: LIST_PAGE,
        offset,
      });
      if (error) throw new Error(`storage list failed in ${bucket}`);
      const entries = data ?? [];
      for (const e of entries) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        if (e.id === null) queue.push(path);
        else keys.push(path);
      }
      if (entries.length < LIST_PAGE) break;
      offset += LIST_PAGE;
    }
  }
  return keys;
}

/**
 * Delete every Storage object whose name starts with `<userId>/` in every
 * bucket the app uses. Throws if anything is left afterwards — Supabase
 * won't delete a sign-in that still owns stored files, so a partial wipe
 * must stop the whole account deletion.
 */
export async function wipeUserStorage(userId: string): Promise<void> {
  const storage = supabaseAdmin.storage as unknown as StorageApi;
  for (const bucket of STORAGE_BUCKETS) {
    const keys = await listAllObjects(storage, bucket, userId);
    for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
      const { error } = await storage.from(bucket).remove(keys.slice(i, i + REMOVE_BATCH));
      if (error) throw new Error(`storage remove failed in ${bucket}`);
    }
    const remaining = await listAllObjects(storage, bucket, userId);
    if (remaining.length > 0) {
      throw new Error(
        `storage wipe incomplete in ${bucket}: ${remaining.length} object(s) left; account not deleted`,
      );
    }
  }
}

const GOOGLE_PROVIDERS = new Set(["gmail", "google_calendar"]);

/**
 * Try to revoke each Google token at Google. Never throws — a token that
 * can't be decrypted or a failed revocation is logged by error class only
 * and reported via the return flag so the UI can point the person at
 * https://myaccount.google.com/permissions.
 */
export async function revokeGoogleTokens(userId: string): Promise<{ failed: boolean }> {
  await loadCrypto();
  let failed = false;
  const { data, error } = await supabaseAdmin
    .from("connections")
    .select("id, provider, access_token_encrypted, refresh_token_encrypted")
    .eq("user_id", userId);
  if (error) {
    console.warn("[gdpr] connections lookup failed:", scrubErrorMessage(error.message));
    return { failed: true };
  }
  for (const conn of (data ?? []) as Array<{
    id: string;
    provider: string;
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
  }>) {
    if (!GOOGLE_PROVIDERS.has(conn.provider)) continue;
    try {
      const token = conn.refresh_token_encrypted
        ? decryptToken(conn.refresh_token_encrypted)
        : conn.access_token_encrypted
          ? decryptToken(conn.access_token_encrypted)
          : null;
      if (!token) {
        failed = true;
        continue;
      }
      const res = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
      if (!res.ok) {
        failed = true;
        console.warn("[gdpr] google token revoke failed: http", res.status);
      }
    } catch (e) {
      failed = true;
      console.warn(
        "[gdpr] google token revoke threw:",
        e instanceof Error ? e.name : "Error",
      );
    }
  }
  return { failed };
}

/**
 * Pure handler for deleteAccount. Same rationale as exportAccountDataFor:
 * keep the data path testable without mocking tanstack/react-start.
 *
 * Order matters: sessions out → tokens revoked → storage wiped → rows wiped
 * → sign-in deleted. If the storage wipe is incomplete we stop BEFORE
 * touching rows or the sign-in, so the account is never left half-deleted
 * with unreachable files.
 */
export async function deleteAccountFor(
  userId: string,
  accessToken?: string,
): Promise<AccountDeleteResult> {
  // a. Sign out every session, so another device can't keep writing.
  if (accessToken) {
    try {
      await supabaseAdmin.auth.admin.signOut(accessToken, "global");
    } catch (e) {
      console.warn(
        "[gdpr] global sign-out failed:",
        e instanceof Error ? e.name : "Error",
      );
    }
  }

  // b. Best-effort Google token revocation.
  const { failed: googleRevokeFailed } = await revokeGoogleTokens(userId);

  // c. Storage wipe — refuses to continue if anything is left.
  await wipeUserStorage(userId);

  // d. Single-transaction row wipe.
  const { data, error } = await (supabaseAdmin as any).rpc("delete_user_data", {
    target_user_id: userId,
  });
  if (error) {
    throw new Error(`Account delete failed: ${scrubErrorMessage(error.message)}`);
  }

  // e. Delete the sign-in itself.
  const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    throw new Error(
      `Account sign-in delete failed: ${scrubErrorMessage(deleteUserError.message)}`,
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  const perTable: Record<string, number> = {};
  if (row && typeof row === "object") {
    for (const [col, label] of Object.entries(RPC_COLUMN_TO_TABLE)) {
      const v = (row as Record<string, unknown>)[col];
      perTable[label] = typeof v === "number" ? v : 0;
    }
  }
  return { deleted: true, perTable, googleRevokeFailed };
}

export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(({ context }): Promise<AccountDeleteResult> => {
    const authHeader = getRequest()?.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    return deleteAccountFor(context.userId, token);
  });
