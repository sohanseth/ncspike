import { createCipheriv, createDecipheriv, createHmac, randomBytes, createHash } from "crypto";

// Derive a stable 32-byte key from the service role key. Pragmatic for spike;
// swap to a dedicated APP_TOKEN_ENCRYPTION_KEY for production.
function getKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY for crypto");
  return createHash("sha256").update(secret).digest();
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptToken(payload: string): string {
  const [version, ivB64, tagB64, encB64] = payload.split(".");
  if (version !== "v1") throw new Error("Unsupported token version");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64url")), decipher.final()]);
  return dec.toString("utf8");
}

// Signed state for OAuth: payload = userId|provider|nonce|expiresAt; sig = HMAC-SHA256
export function signState(userId: string, provider: string): string {
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min
  const payload = `${userId}|${provider}|${nonce}|${expiresAt}`;
  const sig = createHmac("sha256", getKey()).update(payload).digest("base64url");
  return Buffer.from(`${payload}|${sig}`, "utf8").toString("base64url");
}

export function verifyState(state: string): { userId: string; provider: string } {
  const decoded = Buffer.from(state, "base64url").toString("utf8");
  const parts = decoded.split("|");
  if (parts.length !== 5) throw new Error("Malformed state");
  const [userId, provider, nonce, expiresAtStr, sig] = parts;
  const expected = createHmac("sha256", getKey())
    .update(`${userId}|${provider}|${nonce}|${expiresAtStr}`)
    .digest("base64url");
  if (sig !== expected) throw new Error("Invalid state signature");
  if (Date.now() > Number(expiresAtStr)) throw new Error("State expired");
  return { userId, provider };
}
