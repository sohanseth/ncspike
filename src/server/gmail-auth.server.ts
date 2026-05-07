/**
 * Shared Gmail OAuth helper. Used by gmail.functions.ts and voice-drafts.functions.ts.
 * Server-only — touches supabaseAdmin and decrypts tokens.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptToken, encryptToken } from "@/server/crypto.server";

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export type GoogleProvider = "gmail" | "google_calendar";

export async function getValidGoogleAccessToken(
  userId: string,
  provider: GoogleProvider,
): Promise<{ token: string; label: string | null }> {
  const { data: conn, error } = await supabaseAdmin
    .from("connections")
    .select("id, access_token_encrypted, refresh_token_encrypted, expires_at, account_label")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) throw error;
  if (!conn) throw new Error(`${provider} not connected`);

  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  const fresh = expiresAt - Date.now() > 60_000;

  if (fresh && conn.access_token_encrypted) {
    return { token: decryptToken(conn.access_token_encrypted), label: conn.account_label };
  }

  if (!conn.refresh_token_encrypted) throw new Error(`No refresh token; please reconnect ${provider}`);
  const refreshed = await refreshAccessToken(decryptToken(conn.refresh_token_encrypted));
  await supabaseAdmin
    .from("connections")
    .update({
      access_token_encrypted: encryptToken(refreshed.access_token),
      expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    })
    .eq("id", conn.id);
  return { token: refreshed.access_token, label: conn.account_label };
}

/** Back-compat alias — Gmail-specific call sites keep working. */
export async function getValidGmailAccessToken(userId: string) {
  return getValidGoogleAccessToken(userId, "gmail");
}
