// Server-only Gmail helpers. Imported by gmail.functions.ts only inside handlers.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptToken, encryptToken } from "@/server/crypto.server";
import { rulesClassify, type EmailCategory, type EmailDomain } from "@/server/email-rules.server";
import { scrubErrorMessage } from "@/lib/error-scrub";
export { supabaseAdmin, rulesClassify, scrubErrorMessage };
export type { EmailCategory, EmailDomain };
async function categorizeEmails(
  emails: Array<{ subject: string; from: string; snippet: string; date: string }>,
): Promise<Array<{ category: EmailCategory; domain: EmailDomain; reason: string }>> {
  if (!emails.length) return [];
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("LOVABLE_API_KEY missing; defaulting all emails to 'ignore'");
    return emails.map(() => ({ category: "ignore" as const, domain: "personal" as const, reason: "" }));
  }

  const list = emails
    .map((e, i) => `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Snippet: ${e.snippet.slice(0, 200)}`)
    .join("\n\n");

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content:
              "You triage a user's inbox. Read the SUBJECT and SNIPPET carefully — do not classify based on sender alone (automated senders like greenhouse.io, ashbyhq.com, lever.co, linkedin.com still carry professional content).\n\nCategory:\n- 'urgent' = needs reply within 24h (deadlines, time-sensitive asks from real people, interview scheduling)\n- 'today' = calendar/event reminder happening today\n- 'proactive' = interesting opportunity worth following up on later (job leads, recruiter outreach, intros)\n- 'ignore' = newsletters, promotions, automated marketing, no action needed\n\nDomain:\n- 'professional' = work, clients, partnerships, business, AND job search: applications you submitted, interview invites, recruiter outreach, offers, rejections, ATS confirmations (Greenhouse, Ashby, Lever, Workday, LinkedIn Jobs)\n- 'learning' = courses, books, research papers, educational newsletters, tutorials, conferences\n- 'social' = friends, social events, casual chats, social platforms\n- 'family' = kids, school, household, partner, family logistics\n- 'personal' = shopping, travel, hobbies, personal admin, security alerts, banking, utilities\n\nExamples:\n- 'Your application to Nearform' from no-reply@greenhouse.io → professional / proactive (job search)\n- 'CrowdStrike — Application received' → professional / proactive\n- 'Interview with Acme on Thursday' → professional / urgent\n- 'Your Amazon order shipped' → personal / ignore\n- 'Stripe weekly digest' → professional / ignore (work tool, but no action)\n- 'Stanford CS229 lecture notes' → learning / proactive\n- 'Mom: school pickup tomorrow' → family / today\n\nReason must be under 10 words and explain WHY (e.g. 'job application confirmation', 'recruiter outreach').",
          },
          { role: "user", content: `Categorize these ${emails.length} emails:\n\n${list}` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "categorize_emails",
              description: "Return a category and life domain for each email in order.",
              parameters: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        category: { type: "string", enum: ["urgent", "today", "proactive", "ignore"] },
                        domain: { type: "string", enum: ["professional", "learning", "social", "family", "personal"] },
                        reason: { type: "string" },
                      },
                      required: ["category", "domain", "reason"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["results"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "categorize_emails" } },
      }),
    });
    if (!res.ok) {
      // Status only — the response body can echo the emails we sent up.
      console.error("AI categorize failed: http", res.status);
      return emails.map(() => ({ category: "ignore" as const, domain: "personal" as const, reason: "" }));
    }
    const json = await res.json();
    const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return emails.map(() => ({ category: "ignore" as const, domain: "personal" as const, reason: "" }));
    const parsed = JSON.parse(args) as { results: Array<{ category: EmailCategory; domain: EmailDomain; reason: string }> };
    const out = parsed.results ?? [];
    while (out.length < emails.length) out.push({ category: "ignore", domain: "personal", reason: "" });
    return out.slice(0, emails.length);
  } catch (e) {
    console.error("AI categorize threw:", e instanceof Error ? e.name : "Error");
    return emails.map(() => ({ category: "ignore" as const, domain: "personal" as const, reason: "" }));
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{
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

export async function getValidAccessToken(userId: string): Promise<{ token: string; label: string | null }> {
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

export function decodeHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Disconnect a Google connection. Gmail and Calendar share ONE Google
 * sign-in (include_granted_scopes), and revoking the token removes access
 * to every scope — so:
 *   - while the other Google connection is still present, we only delete
 *     the row and tell the person the other service still has access;
 *   - when the LAST Google connection goes, we try to revoke the token at
 *     Google first, then delete the row. The row is always deleted, even
 *     if revocation fails — in that case the UI shows the
 *     myaccount.google.com/permissions link.
 */
export type DisconnectResult = {
  ok: true;
  /** True when another Google connection still shares the token. */
  otherGoogleRemain: boolean;
  /** True when we tried to revoke at Google and it failed. */
  revokeFailed: boolean;
};

/**
 * Pure handler for disconnectProvider — exported for direct testing. The
 * server-fn wrapper only resolves the userId from auth context.
 */
export async function disconnectProviderFor(
  userId: string,
  provider: "gmail" | "google_calendar",
): Promise<DisconnectResult> {
  const otherProvider = provider === "gmail" ? "google_calendar" : "gmail";
  const { data: other } = await supabaseAdmin
    .from("connections")
    .select("id")
    .eq("user_id", userId)
    .eq("provider", otherProvider)
    .maybeSingle();

  let revokeFailed = false;
  if (!other) {
    // Last Google connection — try to revoke the shared token at Google.
    const { data: conn } = await supabaseAdmin
      .from("connections")
      .select("access_token_encrypted, refresh_token_encrypted")
      .eq("user_id", userId)
      .eq("provider", provider)
      .maybeSingle();
    try {
      const token = conn?.refresh_token_encrypted
        ? decryptToken(conn.refresh_token_encrypted)
        : conn?.access_token_encrypted
          ? decryptToken(conn.access_token_encrypted)
          : null;
      if (token) {
        const res = await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        });
        if (!res.ok) {
          revokeFailed = true;
          console.warn("[connections] google revoke failed: http", res.status);
        }
      }
    } catch (e) {
      revokeFailed = true;
      console.warn(
        "[connections] google revoke threw:",
        e instanceof Error ? e.name : "Error",
      );
    }
  }

  // Always delete the row, even if revocation failed.
  const { error } = await supabaseAdmin
    .from("connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw error;
  return { ok: true, otherGoogleRemain: !!other, revokeFailed };
}
