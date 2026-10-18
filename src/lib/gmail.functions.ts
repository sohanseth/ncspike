import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import type { EmailCategory, EmailDomain } from "@/server/email-rules.server";
import type { DisconnectResult } from "./gmail.server";
export type { DisconnectResult };

export const pullRecentEmails = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin, rulesClassify, scrubErrorMessage, getValidAccessToken, categorizeEmails, decodeHeader } = await import("./gmail.server");
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
    const { supabaseAdmin, rulesClassify, scrubErrorMessage, getValidAccessToken, categorizeEmails, decodeHeader } = await import("./gmail.server");
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
    const { supabaseAdmin, rulesClassify, scrubErrorMessage, getValidAccessToken, categorizeEmails, decodeHeader } = await import("./gmail.server");
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
    const { supabaseAdmin, rulesClassify, scrubErrorMessage, getValidAccessToken, categorizeEmails, decodeHeader } = await import("./gmail.server");
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

export const disconnectProvider = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { provider: "gmail" | "google_calendar" }) => d)
  .handler(async ({ data, context }): Promise<DisconnectResult> => {
    const { disconnectProviderFor } = await import("./gmail.server");
    return disconnectProviderFor(context.userId, data.provider);
  });
