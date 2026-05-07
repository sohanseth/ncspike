import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptToken, encryptToken } from "./crypto.server";

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

async function getValidAccessToken(userId: string): Promise<{ token: string; label: string | null }> {
  const { data: conn, error } = await supabaseAdmin
    .from("connections")
    .select("id, access_token_encrypted, refresh_token_encrypted, expires_at, account_label")
    .eq("user_id", userId)
    .eq("provider", "gmail")
    .maybeSingle();

  if (error) throw error;
  if (!conn) throw new Error("Gmail not connected");

  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  const fresh = expiresAt - Date.now() > 60_000; // >1 min left

  if (fresh && conn.access_token_encrypted) {
    return { token: decryptToken(conn.access_token_encrypted), label: conn.account_label };
  }

  if (!conn.refresh_token_encrypted) throw new Error("No refresh token; please reconnect Gmail");
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

function decodeHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export const pullRecentEmails = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { token, label } = await getValidAccessToken(context.userId);

    const listRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=in:inbox",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status} ${await listRes.text()}`);
    const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
    const ids = (list.messages ?? []).map((m) => m.id);

    const summaries: Array<{ id: string; subject: string; from: string; snippet: string; date: string }> = [];

    for (const id of ids) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!msgRes.ok) continue;
      const msg = (await msgRes.json()) as {
        id: string;
        snippet: string;
        payload: { headers: Array<{ name: string; value: string }> };
      };
      summaries.push({
        id: msg.id,
        subject: decodeHeader(msg.payload.headers, "Subject"),
        from: decodeHeader(msg.payload.headers, "From"),
        date: decodeHeader(msg.payload.headers, "Date"),
        snippet: msg.snippet ?? "",
      });
    }

    // Categorize each email with Lovable AI (urgent / today / proactive / ignore)
    const categories = await categorizeEmails(summaries);

    // Persist a memory node per email so NC can "learn" from your inbox.
    if (summaries.length) {
      const rows = summaries.map((s, i) => {
        const cat = categories[i] ?? { category: "ignore", reason: "" };
        return {
          user_id: context.userId,
          node_type: "thread" as const,
          label: s.subject || "(no subject)",
          source: `gmail:${label ?? "me"}`,
          importance: cat.category === "urgent" ? 3 : cat.category === "today" ? 2 : cat.category === "proactive" ? 1 : 0,
          data: {
            from: s.from,
            date: s.date,
            snippet: s.snippet,
            gmail_id: s.id,
            category: cat.category,
            reason: cat.reason,
          },
        };
      });
      const { error: insErr } = await supabaseAdmin.from("memory_nodes").insert(rows);
      if (insErr) console.error("memory_nodes insert error:", insErr);
    }

    return { count: summaries.length, account: label, summaries };
  });

export const getConnections = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("connections")
      .select("provider, account_label, expires_at, scopes, created_at")
      .eq("user_id", context.userId);
    if (error) throw error;
    return { connections: data ?? [] };
  });

export const getInboxItems = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("memory_nodes")
      .select("id, label, data, source, created_at")
      .eq("user_id", context.userId)
      .like("source", "gmail:%")
      .order("created_at", { ascending: false })
      .limit(8);
    if (error) throw error;
    return {
      items: (data ?? []).map((r) => {
        const d = (r.data ?? {}) as { from?: string; snippet?: string; date?: string };
        return {
          id: r.id as string,
          subject: (r.label as string) || "(no subject)",
          from: d.from ?? "",
          snippet: d.snippet ?? "",
          date: d.date ?? "",
        };
      }),
    };
  });

export const disconnectProvider = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { provider: "gmail" | "google_calendar" }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("connections")
      .delete()
      .eq("user_id", context.userId)
      .eq("provider", data.provider);
    if (error) throw error;
    return { ok: true };
  });
