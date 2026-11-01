import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { relayAnswerSchema, relayAnswersSchema } from "@/lib/relay-answer-schema";
import { sha256, json } from "@/server/relay.server";

type DB = SupabaseClient<Database>;
export async function sendRelayAnswerFor(db: DB, userId: string, input: unknown) {
  const parsed = relayAnswerSchema.safeParse(input);
  if (!parsed.success) throw new Error("bad_answer");
  const { deviceId, keyId, ref, nonce, ciphertext } = parsed.data;
  const { data, error } = await db.rpc("relay_answer_put", {
    p_user: userId, p_device: deviceId, p_key_id: keyId, p_ref: ref, p_nonce: nonce, p_ciphertext: ciphertext,
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("Connection temporarily unavailable");
  if (data.status === "not_found") throw new Error("This card has changed on your Mac. Refresh to see the new ones.");
  if (data.status === "too_many") throw new Error("Too many answers for now. Try again later.");
  if (data.status !== "ok") throw new Error("Connection temporarily unavailable");
  return { ok: true as const };
}

export async function handleRelayAnswers(request: Request, db: DB): Promise<Response> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return json({ error: "Expected application/json" }, 415);
  if (Number(request.headers.get("content-length")) > 16384) return json({ error: "Body too large" }, 413);
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Invalid request" }, 400);
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); return json({ error: "Body too large" }, 413); }
      chunks.push(value);
    }
    const match = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,512})$/);
    if (!match) return json({ error: "Unauthorized" }, 401);
    const { data: device, error: deviceError } = await db.from("relay_devices").select("id").eq("token_hash", await sha256(match[1])).is("revoked_at", null).maybeSingle();
    if (deviceError || !device) return json({ error: "Unauthorized" }, 401);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: "Invalid request" }, 400); }
    const parsed = relayAnswersSchema.safeParse(body);
    if (!parsed.success) return json({ error: "Invalid request" }, 400);
    const { data, error } = await db.rpc("relay_answers_take", { p_device: device.id, p_ack: parsed.data.ack });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return json({ error: "Connection temporarily unavailable" }, 503);
    if (data.status === "revoked") return json({ error: "Unauthorized" }, 401);
    if (data.status !== "ok" || !Array.isArray(data.answers)) return json({ error: "Connection temporarily unavailable" }, 503);
    return json({ answers: data.answers });
  } catch { return json({ error: "Connection temporarily unavailable" }, 503); }
}