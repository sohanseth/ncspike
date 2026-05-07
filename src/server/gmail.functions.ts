import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptToken, encryptToken } from "./crypto.server";

type EmailCategory = "urgent" | "today" | "proactive" | "ignore";
type EmailDomain = "professional" | "learning" | "social" | "family" | "personal";

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
      console.error("AI categorize failed:", res.status, await res.text());
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
    console.error("AI categorize threw:", e);
    return emails.map(() => ({ category: "ignore" as const, domain: "personal" as const, reason: "" }));
  }
}

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
        const cat = categories[i] ?? { category: "ignore" as const, domain: "personal" as const, reason: "" };
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
            domain: cat.domain,
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
      .select("id, label, data, source, created_at, importance")
      .eq("user_id", context.userId)
      .like("source", "gmail:%")
      .order("importance", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return {
      items: (data ?? []).map((r) => {
        const d = (r.data ?? {}) as { from?: string; snippet?: string; date?: string; category?: string; domain?: string; reason?: string };
        return {
          id: r.id as string,
          subject: (r.label as string) || "(no subject)",
          from: d.from ?? "",
          snippet: d.snippet ?? "",
          date: d.date ?? "",
          category: (d.category as "urgent" | "today" | "proactive" | "ignore" | undefined) ?? "ignore",
          domain: (d.domain as "professional" | "learning" | "social" | "family" | "personal" | undefined) ?? "personal",
          reason: d.reason ?? "",
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
