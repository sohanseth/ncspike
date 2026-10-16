import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { claimSchema, publishSchema, MAX_RELAY_BODY, PAIRING_ALPHABET } from "@/lib/relay-schema";

type DB = SupabaseClient<Database>;
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomPairingCode(): string {
  const limit = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length;
  let code = "";
  while (code.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
      if (code.length === 8) break;
    }
  }
  return code;
}
export function normalizeRelayIP(address: string): string {
  if (!address.includes(":")) return address;
  let text = address.toLowerCase().split("%")[0];
  // IPv4-mapped IPv6 also expands before truncating to /64.
  const v4 = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return "unknown";
    text = text.slice(0, text.lastIndexOf(":") + 1) + ((octets[0] * 256) + octets[1]).toString(16) + ":" + ((octets[2] * 256) + octets[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return "unknown";
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const count = left.length + right.length;
  if ((halves.length === 1 && count !== 8) || (halves.length === 2 && count >= 8)) return "unknown";
  const groups = [...left, ...Array(8 - count).fill("0"), ...right];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return "unknown";
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":");
}
export async function hashRelayIP(address: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("relay-ip|" + normalizeRelayIP(address)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function createPairingCodeFor(db: DB, userId: string) {
  const raw = randomPairingCode();
  const expiresAt = new Date(Date.now() + 600000).toISOString();
  const { error: deletion } = await db.from("relay_pairing_codes").delete().eq("user_id", userId).is("used_at", null);
  if (deletion) throw new Error("Could not create pairing code");
  const { error } = await db.from("relay_pairing_codes").insert({ user_id: userId, code_hash: await sha256(raw), expires_at: expiresAt });
  if (error) throw new Error("Could not create pairing code");
  return { code: raw.slice(0, 4) + "-" + raw.slice(4), expiresAt };
}
class RequestError extends Error { constructor(public status: number) { super("Invalid request"); } }
async function readJSON(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new RequestError(415);
  const length = Number(request.headers.get("content-length"));
  if (length > MAX_RELAY_BODY) throw new RequestError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RELAY_BODY) { await reader.cancel(); throw new RequestError(413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RequestError(400); }
}
async function tokenDevice(db: DB, request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,512})$/);
  if (!match) throw new RequestError(401);
  const { data, error } = await db.from("relay_devices").select("id").eq("token_hash", await sha256(match[1])).is("revoked_at", null).maybeSingle();
  if (error || !data) throw new RequestError(401);
  return data.id;
}
export async function handleRelay(request: Request, action: "claim" | "publish" | "revoke", db: DB, secret: string): Promise<Response> {
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new RequestError(415);
    if (action === "claim") {
      const parsed = claimSchema.safeParse(await readJSON(request));
      if (!parsed.success) throw new RequestError(400);
      const { data, error } = await db.rpc("relay_claim", { p_ip_hash: await hashRelayIP(request.headers.get("cf-connecting-ip") ?? "unknown", secret), p_code_hash: await sha256(parsed.data.code) });
      if (error || !data || typeof data !== "object" || Array.isArray(data)) return json({ error: "Too many attempts" }, 429);
      if (data.status === "limited") return json({ error: "Too many attempts" }, 429);
      if (data.status !== "ok" || typeof data.user_id !== "string") return json({ error: "unknown or expired code" }, 404);
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const { data: device, error: insertError } = await db.from("relay_devices").insert({ user_id: data.user_id, name: parsed.data.deviceName, token_hash: await sha256(token) }).select("id").single();
      if (insertError || !device) throw new Error("Device registration failed");
      return json({ deviceId: device.id, token });
    }
    if (Number(request.headers.get("content-length")) > MAX_RELAY_BODY) throw new RequestError(413);
    const id = await tokenDevice(db, request);
    if (action === "revoke") {
      const { error } = await db.rpc("relay_revoke", { p_device: id });
      if (error) throw new Error("Revoke failed");
      return json({ ok: true });
    }
    const parsed = publishSchema.safeParse(await readJSON(request));
    if (!parsed.success) throw new RequestError(400);
    const { data, error } = await db.rpc("relay_publish", { p_device: id, p_seq: parsed.data.seq, p_key_id: parsed.data.keyId, p_rows: parsed.data.cards });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("Publish failed");
    if (data.status === "revoked") throw new RequestError(401);
    if (data.status === "stale") return json({ error: "stale", lastSeq: Number(data.lastSeq) }, 409);
    if (data.status !== "ok") throw new Error("Publish failed");
    return json({ stored: data.stored });
  } catch (error) {
    if (error instanceof RequestError) return json({ error: ({ 400: "Invalid request", 401: "Unauthorized", 413: "Body too large", 415: "Expected application/json" } as Record<number, string>)[error.status] }, error.status);
    return json({ error: "Connection temporarily unavailable" }, action === "claim" ? 429 : 503);
  }
}
export async function listDevicesFor(db: DB, userId: string) {
  const { data, error } = await db.from("relay_devices").select("id,name,created_at,last_seen_at").eq("user_id", userId).is("revoked_at", null).order("created_at", { ascending: false });
  if (error) throw new Error("Could not list devices");
  return data ?? [];
}
export async function revokeDeviceFor(db: DB, userId: string, id: string) {
  const { data, error } = await db.from("relay_devices").select("id").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error || !data) throw new Error("Device not found");
  const result = await db.rpc("relay_revoke", { p_device: data.id });
  if (result.error) throw new Error("Could not revoke device");
  return { ok: true };
}
export async function listCardsFor(db: DB, userId: string) {
  const { data, error } = await db.from("relay_cards")
    .select("key_id,ref,nonce,ciphertext,ord,expires_at,updated_at,device_id,relay_devices!inner(last_seen_at,revoked_at,user_id)")
    .eq("user_id", userId).eq("relay_devices.user_id", userId).is("relay_devices.revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) throw new Error("Could not list cards");
  return (data ?? []).sort((a, b) => (Date.parse(b.relay_devices.last_seen_at ?? "") || 0) - (Date.parse(a.relay_devices.last_seen_at ?? "") || 0) || a.ord - b.ord)
    .map(({ relay_devices: _device, ...card }) => card);
}