import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { relayListsSchema, relayListsDeleteSchema } from "@/lib/relay-lists-schema";
import { sha256, json } from "@/server/relay.server";
type DB = SupabaseClient<Database>;
export async function listRelayListsFor(db: DB, userId: string) {
  const { data, error } = await db.rpc("relay_lists_for", { p_user: userId });
  if (error) throw new Error("Connection temporarily unavailable");
  return data ?? [];
}
export async function handleRelayLists(request: Request, db: DB, remove = false): Promise<Response> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return json({ error: "Expected application/json" }, 415);
  if (Number(request.headers.get("content-length")) > 96 * 1024) return json({ error: "Body too large" }, 413);
  try {
    const match = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,512})$/);
    if (!match) return json({ error: "Unauthorized" }, 401);
    const { data: device, error: deviceError } = await db.from("relay_devices").select("id").eq("token_hash", await sha256(match[1])).is("revoked_at", null).maybeSingle();
    if (deviceError || !device) return json({ error: "Unauthorized" }, 401);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Invalid request" }, 400);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 96 * 1024) { await reader.cancel(); return json({ error: "Body too large" }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: "Invalid request" }, 400); }
    const parsed = remove ? relayListsDeleteSchema.safeParse(body) : relayListsSchema.safeParse(body);
    if (!parsed.success) return json({ error: "Invalid request" }, 400);
    const result = remove
      ? await db.rpc("relay_lists_delete", { p_device: device.id })
      : await (async () => {
        const input = relayListsSchema.parse(parsed.data);
        return db.rpc("relay_lists_put", { p_device: device.id, p_seq: input.seq, p_key_id: input.keyId, p_nonce: input.nonce, p_ciphertext: input.ciphertext, p_refs: input.refs, p_expires: input.expiresAt });
      })();
    const { data, error } = result;
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return json({ error: "Connection temporarily unavailable" }, 503);
    if (data.status === "revoked") return json({ error: "Unauthorized" }, 401);
    if (data.status === "stale") return json({ error: "stale", lastSeq: data.lastSeq }, 409);
    if (data.status !== "ok") return json({ error: "Connection temporarily unavailable" }, 503);
    return json(remove ? { ok: true } : { stored: true });
  } catch { return json({ error: "Connection temporarily unavailable" }, 503); }
}