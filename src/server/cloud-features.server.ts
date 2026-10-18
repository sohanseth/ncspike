/**
 * Cloud-feature consent: the server-side source of truth.
 *
 * A feature is on only when the person's newest cloud_consents row for it is
 * granted AND carries the feature's current wording version. Every check
 * fails closed: if the lookup errors, the feature counts as off.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  CLOUD_FEATURES,
  CLOUD_FEATURE_KEYS,
  isConsentCurrent,
  type CloudFeature,
} from "@/lib/cloud-features";
import { scrubErrorMessage } from "@/lib/error-scrub";

export type ConsentSource = "settings" | "prompt" | "preset";

export class CloudFeatureOffError extends Error {
  readonly code = "cloud_feature_off" as const;
  constructor(readonly feature: CloudFeature) {
    super(`cloud_feature_off:${feature}`);
    this.name = "CloudFeatureOffError";
  }
}

export function isCloudFeatureOffError(e: unknown): e is CloudFeatureOffError {
  return (
    !!e &&
    typeof e === "object" &&
    (e as { code?: unknown }).code === "cloud_feature_off"
  );
}

/** JSON 403 body for API routes. */
export function cloudFeatureOffResponse(feature: CloudFeature): Response {
  return new Response(JSON.stringify({ error: "cloud_feature_off", feature }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

// Loose typing: the generated client types lag behind new tables in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

export type CloudFeatureState = {
  feature: CloudFeature;
  on: boolean;
  changedAt: string | null;
  agreedVersion: string | null;
  currentVersion: string;
};

type ConsentRow = {
  feature: string;
  granted: boolean;
  wording_version: string;
  created_at: string;
  id: number;
};

export async function getCloudFeaturesFor(userId: string): Promise<CloudFeatureState[]> {
  const { data, error } = await db()
    .from("cloud_consents")
    .select("id, feature, granted, wording_version, created_at")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(1000);
  if (error) throw new Error("cloud_consents lookup failed");
  const newest = new Map<string, ConsentRow>();
  for (const r of (data ?? []) as ConsentRow[]) if (!newest.has(r.feature)) newest.set(r.feature, r);
  return CLOUD_FEATURE_KEYS.map((feature) => {
    const row = newest.get(feature) ?? null;
    return {
      feature,
      on: isConsentCurrent(feature, row),
      changedAt: row?.created_at ?? null,
      agreedVersion: row && row.granted ? row.wording_version : null,
      currentVersion: CLOUD_FEATURES[feature].version,
    };
  });
}

export async function isCloudFeatureOn(userId: string, feature: CloudFeature): Promise<boolean> {
  try {
    const { data, error } = await db()
      .from("cloud_consents")
      .select("granted, wording_version")
      .eq("user_id", userId)
      .eq("feature", feature)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return false;
    return isConsentCurrent(feature, data);
  } catch {
    return false;
  }
}

/** Throws CloudFeatureOffError when off (or when the check itself fails). */
export async function requireCloudFeature(userId: string, feature: CloudFeature): Promise<void> {
  if (!(await isCloudFeatureOn(userId, feature))) throw new CloudFeatureOffError(feature);
}

/** One content-free row per cloud call that went ahead. Best effort. */
export async function noteCloudActivity(
  userId: string,
  feature: CloudFeature,
  provider: string,
): Promise<void> {
  try {
    const { error } = await db()
      .from("cloud_activity")
      .insert({ user_id: userId, feature, provider: provider.slice(0, 64) });
    if (error) console.warn("[cloud] activity insert failed:", scrubErrorMessage(error.message));
  } catch (e) {
    console.warn("[cloud] activity insert threw:", e instanceof Error ? e.name : "Error");
  }
}

export async function recordConsent(
  userId: string,
  feature: CloudFeature,
  granted: boolean,
  source: ConsentSource,
): Promise<void> {
  const { error } = await db().from("cloud_consents").insert({
    user_id: userId,
    feature,
    granted,
    wording_version: CLOUD_FEATURES[feature].version,
    source,
  });
  if (error) throw new Error("cloud_consents insert failed");
}

/** Simple preset's provider-category blocks (kept identical to the preset). */
export const SIMPLE_PRESET_BLOCKS = [
  { providerTier: 2, category: "wellness" },
  { providerTier: 3, category: "physical" },
  { providerTier: 3, category: "professional" },
] as const;

async function upsertSettings(userId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from("user_settings")
    .upsert({ user_id: userId, ...patch }, { onConflict: "user_id" });
  if (error) throw new Error("user_settings update failed");
}

const CHAT_BUCKET = "chat-attachments";

async function removeStoragePaths(paths: string[]): Promise<number> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += 500) {
    const batch = paths.slice(i, i + 500);
    if (!batch.length) continue;
    const { error } = await db().storage.from(CHAT_BUCKET).remove(batch);
    if (error) throw new Error("storage remove failed");
    removed += batch.length;
  }
  return removed;
}

/** Delete every hosted (non-private) chat thread with its messages and photos. */
export async function deleteHostedChats(userId: string): Promise<{ threads: number; files: number }> {
  const { data: msgs, error } = await db()
    .from("chat_messages")
    .select("id, thread_id, badge")
    .eq("user_id", userId);
  if (error) throw new Error("chat lookup failed");
  const all = (msgs ?? []) as Array<{ id: string; thread_id: string; badge: string | null }>;
  const privateThreads = new Set(all.filter((m) => m.badge === "private").map((m) => m.thread_id));
  const hosted = all.filter((m) => m.badge !== "private");
  const hostedThreads = [...new Set(hosted.map((m) => m.thread_id))];
  const hostedIds = hosted.map((m) => m.id);
  let files = 0;
  for (let i = 0; i < hostedIds.length; i += 200) {
    const ids = hostedIds.slice(i, i + 200);
    const { data: atts } = await db()
      .from("chat_message_attachments")
      .select("id, storage_path")
      .eq("user_id", userId)
      .in("message_id", ids);
    const paths = ((atts ?? []) as Array<{ storage_path: string }>).map((a) => a.storage_path);
    files += await removeStoragePaths(paths);
    await db().from("chat_message_attachments").delete().eq("user_id", userId).in("message_id", ids);
    await db().from("chat_messages").delete().eq("user_id", userId).in("id", ids);
  }
  const emptyThreads = hostedThreads.filter((t) => !privateThreads.has(t));
  for (let i = 0; i < emptyThreads.length; i += 200) {
    await db().from("chat_threads").delete().eq("user_id", userId).in("id", emptyThreads.slice(i, i + 200));
  }
  return { threads: emptyThreads.length, files };
}

/** Count PRIVATE chat messages and files still stored on the server. */
export async function countPrivateServerChats(userId: string): Promise<{ messages: number; files: number }> {
  const { data: msgs, error } = await db()
    .from("chat_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("badge", "private");
  if (error) throw new Error("chat lookup failed");
  const ids = ((msgs ?? []) as Array<{ id: string }>).map((m) => m.id);
  let files = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const { data: atts } = await db()
      .from("chat_message_attachments")
      .select("id")
      .eq("user_id", userId)
      .in("message_id", ids.slice(i, i + 200));
    files += (atts ?? []).length;
  }
  const imagegen = await listImagegenPaths(userId);
  return { messages: ids.length, files: files + imagegen.length };
}

async function listImagegenPaths(userId: string): Promise<string[]> {
  const out: string[] = [];
  const prefix = `${userId}/imagegen`;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db().storage.from(CHAT_BUCKET).list(prefix, { limit: 1000, offset });
    if (error || !data) break;
    for (const e of data as Array<{ name: string; id: string | null }>) {
      if (e.id) out.push(`${prefix}/${e.name}`);
    }
    if (data.length < 1000) break;
  }
  return out;
}

/** Delete PRIVATE messages, their files (incl. <userId>/imagegen/) and threads left empty. */
export async function deletePrivateServerChats(
  userId: string,
): Promise<{ messages: number; files: number; threads: number }> {
  const { data: msgs, error } = await db()
    .from("chat_messages")
    .select("id, thread_id")
    .eq("user_id", userId)
    .eq("badge", "private");
  if (error) throw new Error("chat lookup failed");
  const rows = (msgs ?? []) as Array<{ id: string; thread_id: string }>;
  const ids = rows.map((r) => r.id);
  let files = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { data: atts } = await db()
      .from("chat_message_attachments")
      .select("storage_path")
      .eq("user_id", userId)
      .in("message_id", batch);
    files += await removeStoragePaths(((atts ?? []) as Array<{ storage_path: string }>).map((a) => a.storage_path));
    await db().from("chat_message_attachments").delete().eq("user_id", userId).in("message_id", batch);
    await db().from("chat_messages").delete().eq("user_id", userId).in("id", batch);
  }
  files += await removeStoragePaths(await listImagegenPaths(userId));
  // Threads left with no messages.
  const touched = [...new Set(rows.map((r) => r.thread_id))];
  let threads = 0;
  for (const t of touched) {
    const { data: left } = await db().from("chat_messages").select("id").eq("thread_id", t).limit(1);
    if (!left || left.length === 0) {
      await db().from("chat_threads").delete().eq("user_id", userId).eq("id", t);
      threads++;
    }
  }
  return { messages: ids.length, files, threads };
}

/** What turning a feature off deletes. Runs after the person confirmed. */
export async function deleteFeatureData(
  userId: string,
  feature: CloudFeature,
  opts: { deleteCloudChats?: boolean } = {},
): Promise<void> {
  switch (feature) {
    case "email_on_server": {
      const { disconnectProviderFor } = await import("@/lib/gmail.server");
      const { data: conn } = await db()
        .from("connections")
        .select("id")
        .eq("user_id", userId)
        .eq("provider", "gmail")
        .maybeSingle();
      if (conn) await disconnectProviderFor(userId, "gmail");
      await db().from("memory_nodes").delete().eq("user_id", userId).like("source", "gmail:%");
      await db().from("voice_profiles").delete().eq("user_id", userId);
      return;
    }
    case "calendar_on_server": {
      const { disconnectProviderFor } = await import("@/lib/gmail.server");
      const { data: conn } = await db()
        .from("connections")
        .select("id")
        .eq("user_id", userId)
        .eq("provider", "google_calendar")
        .maybeSingle();
      if (conn) await disconnectProviderFor(userId, "google_calendar");
      return;
    }
    case "email_ai":
      await db().from("drafts").delete().eq("user_id", userId);
      await db().from("research_tasks").delete().eq("user_id", userId);
      return;
    case "web_search":
      await db().from("search_queries").delete().eq("user_id", userId);
      return;
    case "nightly_traits":
      await db().from("user_traits").delete().eq("user_id", userId);
      return;
    case "overnight_research":
      await db().from("agents").update({ state: "paused" }).eq("user_id", userId).eq("state", "active");
      return;
    case "cloud_chat":
      if (opts.deleteCloudChats) await deleteHostedChats(userId);
      return;
    case "voice_replies":
    case "voice_input":
      return;
  }
}

/**
 * Record a consent change and apply its side effects. Turning a feature off
 * also deletes what it stored (the browser asks for confirmation first).
 */
export async function setCloudFeatureFor(
  userId: string,
  feature: CloudFeature,
  granted: boolean,
  source: ConsentSource,
  opts: { deleteCloudChats?: boolean } = {},
): Promise<CloudFeatureState[]> {
  await recordConsent(userId, feature, granted, source);
  if (feature === "cloud_chat") {
    await upsertSettings(userId, { private_only_mode: !granted });
    if (granted) {
      const { data: blocks } = await db()
        .from("user_provider_category_blocks")
        .select("category")
        .eq("user_id", userId)
        .limit(1);
      if (!blocks || blocks.length === 0) {
        const { error } = await db()
          .from("user_provider_category_blocks")
          .insert(
            SIMPLE_PRESET_BLOCKS.map((b) => ({
              user_id: userId,
              provider_tier: b.providerTier,
              category: b.category,
            })),
          );
        if (error) throw new Error("preset blocks insert failed");
      }
    }
  }
  if (feature === "nightly_traits") await upsertSettings(userId, { personalization_v1_enabled: granted });
  if (feature === "email_ai" && !granted) await upsertSettings(userId, { voice_drafts_consent_at: null });
  if (!granted) await deleteFeatureData(userId, feature, opts);
  return getCloudFeaturesFor(userId);
}
