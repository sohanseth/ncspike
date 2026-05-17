/**
 * Phase 3.0 — findings inbox (read-only).
 *
 * Third product-surface slice after agent create (#11) and manage (#13).
 * One endpoint: `listFindings({limit?, sinceDays?})`. Read-only by design
 * — per `supabase/migrations/20260601000000_phase30_agent_runtime.sql:204`
 * comment, dismiss/accept/snooze ship with the 3.1 notification UX. Here
 * we just surface what the runner has produced.
 *
 * Auth + scoping conventions (same as agents.functions.ts):
 *   - requireSupabaseAuth middleware (authoritative)
 *   - user_id derived from auth context, never from client payload
 *   - WHERE includes `.eq('user_id', userId)` explicitly even though RLS
 *     gates it — the admin client bypasses RLS, so the explicit filter
 *     is the load-bearing guard
 *
 * Findings are joined with the parent `agents` row to surface
 * display_name in one query (avoid N+1). Supabase PostgREST embedding
 * handles this via `select("..., agents(display_name)")` over the FK.
 *
 * 'archived' findings are excluded from the default list — futureproofing
 * for when 3.1 ships the dismiss/archive surface. Today every finding is
 * in state='new'; tomorrow this filter does real work.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

/** UI-shaped finding row. Strips internal fields (run_id, dedupe_key,
 *  payload) we don't render in the MVP inbox. */
export type FindingItem = {
  id: string;
  agent_id: string;
  agent_display_name: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  score: number;
  urgency: string;
  state: string;
  created_at: string;
};

/** Default page size. 50 is comfortably above one day of high-cadence
 *  agents (BATCH_LIMIT=10 agents/tick × handful of findings each) and
 *  well under any reasonable UI scroll budget. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const ListFindingsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    /** Reserved for the run-history PR — filter to findings created in
     *  the last N days. Omit for "all non-archived". */
    sinceDays: z.number().int().min(1).max(365).optional(),
  })
  .optional()
  .default({});

export type ListFindingsInput = z.infer<typeof ListFindingsInputSchema>;

/**
 * Pure handler. Returns the user's non-archived findings, newest first,
 * embedding `agents.display_name` per row.
 *
 * Shape of the joined select per supabase-js: `agents:agent_id (display_name)`
 * yields `{ ..., agents: { display_name: string } }` on each row. We
 * flatten that into `agent_display_name` before returning so the UI
 * stays simple.
 */
export async function listFindingsFor(
  userId: string,
  raw: unknown,
): Promise<FindingItem[]> {
  const input = ListFindingsInputSchema.parse(raw);
  const limit = input.limit ?? DEFAULT_LIMIT;

  // `agents!inner(...)` makes the embed an inner join. That, plus the
  // `.neq("agents.state", "archived")` filter, means findings for an
  // agent the user later archived are excluded by the query itself —
  // no JS post-filtering, no row returned in the first place.
  //
  // PR-14 review (Sneha 2026-05-18): the previous select used
  // `agents:agent_id(display_name)` which is a left embed, so an
  // archived agent's findings still surfaced. Inner join + parent-state
  // filter closes that gap server-side without any runtime change.
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

export const listFindings = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: ListFindingsInput | undefined) => d ?? {})
  .handler(({ data, context }): Promise<FindingItem[]> =>
    listFindingsFor(context.userId, data),
  );
