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
  type AgentBriefing,
  type JsonValue,
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
      "id, agent_id, title, summary, source_url, score, urgency, state, created_at, dedupe_key, agents!inner(display_name, state)",
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
      dedupe_key: string;
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
      dedupe_key: r.dedupe_key,
    }),
  );
}

/**
 * Most recent briefing per non-archived agent for the user. Server-side
 * dedupes by agent_id (keeps the newest `started_at`). Caller gets at
 * most one briefing per agent; agents with no successful briefing yet
 * simply don't appear in the result.
 *
 * Same owner-scope discipline as `listFindingsFor`: `.eq('user_id',
 * userId)` is the load-bearing guard since the admin client bypasses
 * RLS. `agents!inner` + `.neq('agents.state', 'archived')` mirrors the
 * inbox's archive filter so a briefing for an archived agent doesn't
 * leak through.
 */
export async function listBriefingsFor(userId: string): Promise<AgentBriefing[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("agent_runs")
    .select(
      "agent_id, id, briefing, started_at, finished_at, agents!inner(state)",
    )
    .eq("user_id", userId)
    .neq("agents.state", "archived")
    .not("briefing", "is", null)
    .order("started_at", { ascending: false })
    .limit(200);

  if (error) {
    throw new Error(
      `Briefings list failed: ${scrubErrorMessage(error.message ?? String(error))}`,
    );
  }

  // Dedupe by agent_id, keep newest started_at (results are already
  // sorted desc — first occurrence wins).
  const byAgent = new Map<string, AgentBriefing>();
  for (const r of (data ?? []) as Array<{
    agent_id: string;
    id: string;
    briefing: Record<string, unknown> | null;
    started_at: string;
    finished_at: string | null;
  }>) {
    if (byAgent.has(r.agent_id) || !r.briefing) continue;
    byAgent.set(r.agent_id, {
      agent_id: r.agent_id,
      run_id: r.id,
      // Coerce through unknown: the DB returns Record<string, unknown>
      // but TanStack's wire types expect JsonValue. The runtime value
      // is already JSON (just came from JSONB); the inbox UI runs its
      // own defensive narrowing.
      briefing: r.briefing as unknown as JsonValue,
      run_started_at: r.started_at,
      run_finished_at: r.finished_at,
    });
  }
  return Array.from(byAgent.values());
}
