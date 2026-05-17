/**
 * Phase 3.0 — findings inbox (server-only handler).
 *
 * Server-only impl of `listFindingsFor`. Lives in a `.server.ts` sibling
 * to keep the `@/server/agents/error-scrub` import out of the client
 * bundle — see the long-form rationale in `agents.functions.server.ts`.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

import {
  ListFindingsInputSchema,
  type FindingItem,
  DEFAULT_LIMIT,
} from "./findings.functions";

export async function listFindingsFor(
  userId: string,
  raw: unknown,
): Promise<FindingItem[]> {
  const input = ListFindingsInputSchema.parse(raw);
  const limit = input.limit ?? DEFAULT_LIMIT;

  // `agents!inner(...)` + `.neq('agents.state', 'archived')` excludes
  // findings whose parent agent the user later archived — PR-14 review
  // hardening, see agents.functions.ts comment for the full rationale.
  let q = (supabaseAdmin as any)
    .from("agent_findings")
    .select(
      "id, agent_id, title, summary, source_url, score, urgency, state, created_at, agents!inner(display_name, state)",
    )
    .eq("user_id", userId)
    .neq("state", "archived")
    .neq("agents.state", "archived")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (input.sinceDays !== undefined) {
    const since = new Date(
      Date.now() - input.sinceDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    q = q.gte("created_at", since);
  }

  const { data, error } = await q;
  if (error) {
    throw new Error(
      `Findings list failed: ${scrubErrorMessage(error.message ?? String(error))}`,
    );
  }

  return (data ?? []).map(
    (r: {
      id: string;
      agent_id: string;
      title: string;
      summary: string | null;
      source_url: string | null;
      score: number;
      urgency: string;
      state: string;
      created_at: string;
      agents?: { display_name?: string } | null;
    }) => ({
      id: r.id,
      agent_id: r.agent_id,
      agent_display_name: r.agents?.display_name ?? "(unknown agent)",
      title: r.title,
      summary: r.summary,
      source_url: r.source_url,
      score: Number(r.score),
      urgency: r.urgency,
      state: r.state,
      created_at: r.created_at,
    }),
  );
}
