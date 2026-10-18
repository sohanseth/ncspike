import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
// Loaded lazily so the server-only crypto module never enters the browser bundle.
let decryptToken: (raw: string) => string = () => {
  throw new Error("crypto not loaded");
};
let encryptToken: (raw: string) => string = () => {
  throw new Error("crypto not loaded");
};
async function loadCrypto(): Promise<void> {
  const mod = await import("@/server/crypto.server");
  decryptToken = mod.decryptToken;
  encryptToken = mod.encryptToken;
}
import { rulesClassify, type EmailCategory, type EmailDomain } from "@/server/email-rules.server";
import { scrubErrorMessage } from "@/lib/error-scrub";

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
  await loadCrypto();
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

    // Phase 1: deterministic rules-first triage. No external AI by default.
    // Ambiguous emails are tagged `needs_review`. Gemini fallback is opt-in
    // via ENABLE_LLM_FALLBACK=true (off by default — keeps email data local).
    const llmFallbackEnabled = process.env.ENABLE_LLM_FALLBACK === "true";
    const ruleResults = summaries.map((s) => rulesClassify(s.from, s.subject));

    const ambiguousIdx = ruleResults
      .map((r, i) => (r.confidence === "low" ? i : -1))
      .filter((i) => i !== -1);

    const llmHandled = new Set<number>();
    if (llmFallbackEnabled && ambiguousIdx.length > 0) {
      const ambiguousEmails = ambiguousIdx.map((i) => summaries[i]);
      const llmResults = await categorizeEmails(ambiguousEmails);
      ambiguousIdx.forEach((origIdx, j) => {
        const r = llmResults[j];
        if (r) {
          ruleResults[origIdx] = {
            category: r.category as EmailCategory,
            domain: r.domain,
            confidence: "high",
            reason: r.reason,
          };
          llmHandled.add(origIdx);
        }
      });
    }

    // Persist a memory node per email so NC can "learn" from your inbox.
    // Dedup against any prior pull so we don't reinsert the same gmail_id —
    // that would resurface emails the user already marked done. We fetch the
    // existing gmail_ids for this user and filter the new batch in-memory.
    let inserted = 0;
    const newGmailIds = new Set<string>();
    if (summaries.length) {
      const { data: existing, error: exErr } = await supabaseAdmin
        .from("memory_nodes")
        .select("data")
        .eq("user_id", context.userId)
        .like("source", "gmail:%");
      if (exErr) {
        // Fail closed: skip inserts entirely if we can't verify what's already
        // there, otherwise we'd resurface emails the user already marked done.
        console.error("dedup lookup failed; skipping insert this pull:", scrubErrorMessage(exErr.message));
        return { count: summaries.length, inserted: 0, account: label, summaries };
      }
      const seen = new Set<string>(
        (existing as Array<{ data: { gmail_id?: string } | null }>)
          .map((r) => r.data?.gmail_id)
          .filter((g): g is string => typeof g === "string"),
      );

      const candidates = summaries
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => !seen.has(s.id));
      for (const { s } of candidates) newGmailIds.add(s.id);
      const rows = candidates
        .map(({ s, i }) => {
          const cat = ruleResults[i];
          const importance =
            cat.category === "urgent" ? 3 :
            cat.category === "today" ? 2 :
            cat.category === "proactive" ? 1 :
            cat.category === "needs_review" ? 1 : 0;
          return {
            user_id: context.userId,
            node_type: "thread" as const,
            label: s.subject || "(no subject)",
            source: `gmail:${label ?? "me"}`,
            importance,
            data: {
              from: s.from,
              date: s.date,
              snippet: s.snippet,
              gmail_id: s.id,
              category: cat.category,
              domain: cat.domain,
              reason: cat.reason,
              classified_by: llmHandled.has(i) ? "llm" : "rules",
            },
          };
        });
      if (rows.length) {
        // App-layer dedup handles the common case. The partial unique index on
        // (user_id, data->>'gmail_id') is the race backstop — PostgREST can't
        // ON CONFLICT against an expression index, so we just insert and
        // swallow 23505 (unique_violation), which means a concurrent pull
        // already wrote the row.
        const { error: insErr, data: insData } = await supabaseAdmin
          .from("memory_nodes")
          .insert(rows)
          .select("id");
        if (insErr && insErr.code !== "23505") {
          console.error("memory_nodes insert error:", scrubErrorMessage(insErr.message));
        } else {
          inserted = insData?.length ?? 0;
        }
      }
    }

    // "Context on this sender" research runs only when the person asks for
    // it (the button on an email row, or "Research overnight"). The pull
    // itself never queues research tasks.
    void newGmailIds;

    return { count: summaries.length, inserted, account: label, summaries };
  });

export const getConnections = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("connections")
      .select("provider, account_label, expires_at, scopes, created_at")
      .eq("user_id", context.userId);
    if (error) throw error;
    return { connections: data ?? [] };
  });

export const getInboxItems = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("memory_nodes")
      .select("id, label, data, source, created_at, importance")
      .eq("user_id", context.userId)
      .like("source", "gmail:%")
      .is("data->>resolved_at", null)
      .order("importance", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return {
      items: (data ?? []).map((r) => {
        const d = (r.data ?? {}) as { from?: string; snippet?: string; date?: string; category?: string; domain?: string; reason?: string; classified_by?: string };
        return {
          id: r.id as string,
          subject: (r.label as string) || "(no subject)",
          from: d.from ?? "",
          snippet: d.snippet ?? "",
          date: d.date ?? "",
          category: (d.category as EmailCategory | undefined) ?? "needs_review",
          domain: (d.domain as EmailDomain | undefined) ?? "personal",
          reason: d.reason ?? "",
          classifiedBy: (d.classified_by as "rules" | "llm" | undefined) ?? "rules",
        };
      }),
    };
  });

export const markInboxItemDone = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { id: string; action?: "done" | "dismissed" }) => d)
  .handler(async ({ data, context }) => {
    // Atomic JSONB patch via SQL function — avoids the read-modify-write race
    // where two concurrent updates clobber each other.
    const { error } = await supabaseAdmin.rpc("mark_memory_node_resolved", {
      p_node_id: data.id,
      p_user_id: context.userId,
      p_action: data.action ?? "done",
    });
    if (error) throw error;
    return { ok: true };
  });

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
  await loadCrypto();
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

export const disconnectProvider = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { provider: "gmail" | "google_calendar" }) => d)
  .handler(({ data, context }): Promise<DisconnectResult> =>
    disconnectProviderFor(context.userId, data.provider),
  );
