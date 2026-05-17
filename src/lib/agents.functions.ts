/**
 * Phase 3.0 — agent creation (MVP).
 *
 * First product surface on top of the runtime foundation (PR1 → PR3c + the
 * hardening sweep). One endpoint: `createResearchDigestAgent({display_name,
 * topics})`. Everything else is template-supplied or table-default:
 *
 *   template_id    = 'research_digest'                 (the only 3.0 template)
 *   badge          = template.defaultBadge ('flash')
 *   state          = 'active'                          (overrides table 'draft')
 *   cadence_hours  = template.defaultCadenceHours (24)
 *   budget         = template.defaultBudget            (AgentBudget jsonb)
 *   config         = ResearchDigestConfigSchema.parse({topics})
 *                    → fills lookbackHours + minScore defaults
 *   last_completed_at = NULL                           (claim_due_agents
 *                                                       treats NULL as due)
 *
 * **Why state='active' + last_completed_at=NULL together**: a draft row
 * stays out of `claim_due_agents`' state filter; a NULL `last_completed_at`
 * is what tells that filter the row has never run, so it's eligible on the
 * very next cron tick. Both pieces are required for a freshly-created
 * agent to actually run.
 *
 * Validation is split into two layers — top-level input validates
 * display_name + topics shape (rejects empty strings and >5 topics);
 * `ResearchDigestConfigSchema.parse(...)` re-validates topics and supplies
 * the template-internal defaults. The latter is the source of truth for
 * what shape the runner consumes.
 *
 * Advanced config (cadence, budget, minScore, lookback) is deliberately
 * NOT surfaced in this MVP — see PR body for the rationale + follow-ups.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  researchDigest,
  ResearchDigestConfigSchema,
} from "@/server/agents/templates/research-digest";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

export const CreateResearchDigestAgentInputSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  topics: z.array(z.string().trim().min(1).max(120)).min(1).max(5),
});

export type CreateResearchDigestAgentInput = z.infer<
  typeof CreateResearchDigestAgentInputSchema
>;

export type CreatedAgentSummary = {
  id: string;
  template_id: string;
  display_name: string;
  badge: string;
  state: string;
  cadence_hours: number;
};

/**
 * Pure handler — auth-free, input is already-known userId + raw payload.
 * Mirrors the gdpr.functions.ts handler-pair pattern so tests can exercise
 * the data path without mocking @tanstack/react-start middleware.
 */
export async function createResearchDigestAgentFor(
  userId: string,
  raw: unknown,
): Promise<CreatedAgentSummary> {
  // Layer 1 — input shape validation (display_name + topics).
  const input = CreateResearchDigestAgentInputSchema.parse(raw);

  // Layer 2 — template's own config validation. This also fills the
  // default lookbackHours + minScore so the persisted config matches
  // exactly what the runner expects to read.
  const config = ResearchDigestConfigSchema.parse({ topics: input.topics });

  const row = {
    user_id: userId,
    template_id: researchDigest.id,
    display_name: input.display_name,
    config,
    badge: researchDigest.defaultBadge,
    state: "active",
    cadence_hours: researchDigest.defaultCadenceHours,
    budget: researchDigest.defaultBudget,
    // notify left to the JSONB default '{}'.
    // last_completed_at left NULL → due immediately on next cron tick.
  };

  const { data, error } = await (supabaseAdmin as any)
    .from("agents")
    .insert(row)
    .select("id, template_id, display_name, badge, state, cadence_hours")
    .single();

  if (error) {
    // Don't echo Supabase error envelopes raw — they can carry constraint
    // values (e.g., a unique-key violation could include the display_name).
    throw new Error(
      `Agent create failed: ${scrubErrorMessage(error.message ?? String(error))}`,
    );
  }
  return data as CreatedAgentSummary;
}

export const createResearchDigestAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: CreateResearchDigestAgentInput) => d)
  .handler(({ data, context }): Promise<CreatedAgentSummary> =>
    createResearchDigestAgentFor(context.userId, data),
  );

// ─── List / pause / resume / archive ─────────────────────────────────────
//
// Manage surface for the user's own agents. Conventions, applied to every
// handler below:
//
//   1. user_id is taken from auth context (never from client payload).
//   2. Every UPDATE/SELECT WHERE includes `.eq('user_id', userId)`. RLS
//      already gates this (policy `agents_owner_all`), but admin client
//      bypasses RLS — the explicit filter is the load-bearing guard.
//   3. State transitions are strict:
//        pause   : 'active'   → 'paused'    (no-op on already paused)
//        resume  : 'paused'   → 'active'    (no-op if not paused)
//        archive : !archived  → 'archived'  (terminal state for the UI)
//      The WHERE clauses encode these so a stale client click can't
//      accidentally bump a runner-managed state ('degraded', 'inactive',
//      'error') into 'active'. Stale-click → 0 rows affected → caller
//      sees `affected: false` and can refetch.
//   4. No hard delete affordance. Archive is the terminal user action.
//      `agents_runs`/`agent_findings` history is preserved.

export type AgentListItem = {
  id: string;
  display_name: string;
  template_id: string;
  state: string;
  cadence_hours: number;
  last_completed_at: string | null;
  created_at: string;
};

export type MutationResult = { affected: boolean };

const AgentIdSchema = z.object({
  agentId: z.string().uuid(),
});

export type AgentIdInput = z.infer<typeof AgentIdSchema>;

/**
 * Pure handler — returns the user's non-archived agents, newest first.
 * Archived agents are hidden from the default list per Sneha's
 * archive-over-delete decision; a future "Show archived" toggle can
 * call this with `{includeArchived: true}` (not in MVP).
 */
export async function listAgentsFor(userId: string): Promise<AgentListItem[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("agents")
    .select(
      "id, display_name, template_id, state, cadence_hours, last_completed_at, created_at",
    )
    .eq("user_id", userId)
    .neq("state", "archived")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(
      `Agent list failed: ${scrubErrorMessage(error.message ?? String(error))}`,
    );
  }
  return (data ?? []) as AgentListItem[];
}

export const listAgents = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(({ context }): Promise<AgentListItem[]> =>
    listAgentsFor(context.userId),
  );

/**
 * Shared shape for the three state-transition handlers. Returns
 * `{affected: true}` iff exactly one row's state changed. `false` means
 * the row didn't exist, isn't owned by this user, or wasn't in the
 * expected source state — all three indistinguishable to the client by
 * design (avoid leaking row existence to a non-owner).
 */
async function transitionAgentState(
  userId: string,
  raw: unknown,
  expectedSourceStates: string[] | null,
  targetState: string,
  opName: string,
): Promise<MutationResult> {
  const { agentId } = AgentIdSchema.parse(raw);

  let q = (supabaseAdmin as any)
    .from("agents")
    .update({ state: targetState })
    .eq("id", agentId)
    .eq("user_id", userId);
  if (expectedSourceStates !== null) {
    q = q.in("state", expectedSourceStates);
  } else {
    // archive: refuse to update an already-archived row (avoids a no-op
    // bump on updated_at when the user double-clicks).
    q = q.neq("state", "archived");
  }
  const { data, error } = await q.select("id");

  if (error) {
    throw new Error(
      `Agent ${opName} failed: ${scrubErrorMessage(error.message ?? String(error))}`,
    );
  }
  return { affected: Array.isArray(data) && data.length > 0 };
}

export function pauseAgentFor(
  userId: string,
  raw: unknown,
): Promise<MutationResult> {
  return transitionAgentState(userId, raw, ["active"], "paused", "pause");
}

export function resumeAgentFor(
  userId: string,
  raw: unknown,
): Promise<MutationResult> {
  return transitionAgentState(userId, raw, ["paused"], "active", "resume");
}

export function archiveAgentFor(
  userId: string,
  raw: unknown,
): Promise<MutationResult> {
  return transitionAgentState(userId, raw, null, "archived", "archive");
}

export const pauseAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: AgentIdInput) => d)
  .handler(({ data, context }): Promise<MutationResult> =>
    pauseAgentFor(context.userId, data),
  );

export const resumeAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: AgentIdInput) => d)
  .handler(({ data, context }): Promise<MutationResult> =>
    resumeAgentFor(context.userId, data),
  );

export const archiveAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: AgentIdInput) => d)
  .handler(({ data, context }): Promise<MutationResult> =>
    archiveAgentFor(context.userId, data),
  );
