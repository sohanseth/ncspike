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
