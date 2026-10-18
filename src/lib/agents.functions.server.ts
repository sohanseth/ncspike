/**
 * Phase 3.0 — agent create + manage (server-only handlers).
 *
 * The pure `*For(userId, raw)` handlers + every import that's gated by
 * vite's `import-protection` plugin (anything under `src/server/**`).
 * The companion `agents.functions.ts` file keeps the client-safe
 * `createServerFn` wrappers + Zod input schemas; its handler bodies
 * dynamically `import("./agents.functions.server")` so this module
 * never ends up in the browser bundle.
 *
 * Why the split (the bug this file fixes):
 *   `createServerFn` tree-shakes the handler BODY from the client, but
 *   top-level `import` statements in the wrapper file are evaluated by
 *   vite's import-analysis pass regardless. A top-level `import …from
 *   "@/server/agents/templates/research-digest"` in agents.functions.ts
 *   therefore tripped the `**\/server/**` denylist and produced an
 *   in-browser overlay: `[plugin:vite:import-analysis] Import denied`.
 *
 * Pattern lifted from the TanStack Start docs' import-protection
 * suggestion: "Move the server-only import out of this file into a
 * separate .server.ts module that is not imported by any client code."
 *
 * Behavior is unchanged from before the split. Tests still target the
 * `*For` handlers directly; only the import path moves.
 */
import { researchDigest, ResearchDigestConfigSchema } from "@/server/agents/templates/research-digest";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { scrubErrorMessage } from "@/lib/error-scrub";
import { macAgentIdsFor } from "./mac-agent-owner.server";

import {
  CreateResearchDigestAgentInputSchema,
  AgentIdSchema,
  type CreatedAgentSummary,
  type MutationResult,
  type AgentListItem,
} from "./agents.functions";

// ─── Create ────────────────────────────────────────────────────────────────

export async function createResearchDigestAgentFor(
  userId: string,
  raw: unknown,
): Promise<CreatedAgentSummary> {
  const input = CreateResearchDigestAgentInputSchema.parse(raw);
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
  };

  const { data, error } = await (supabaseAdmin as any)
    .from("agents")
    .insert(row)
    .select("id, template_id, display_name, badge, state, cadence_hours")
    .single();

  if (error) {
    throw new Error(
      `Agent create failed: ${scrubErrorMessage(error.message ?? String(error))}`,
    );
  }
  return data as CreatedAgentSummary;
}

// ─── List ──────────────────────────────────────────────────────────────────

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
  const macIds = await macAgentIdsFor(userId);
  return (data ?? []).map((row: AgentListItem) => ({ ...row, from_mac: macIds.has(row.id) }));
}

// ─── State transitions (pause / resume / archive) ─────────────────────────

async function transitionAgentState(
  userId: string,
  raw: unknown,
  expectedSourceStates: string[] | null,
  targetState: string,
  opName: string,
  options: { requireNoActiveLease?: boolean } = {},
): Promise<MutationResult> {
  const { agentId } = AgentIdSchema.parse(raw);
  if ((await macAgentIdsFor(userId)).has(agentId)) return { affected: false };

  let q = (supabaseAdmin as any)
    .from("agents")
    .update({ state: targetState })
    .eq("id", agentId)
    .eq("user_id", userId);
  if (expectedSourceStates !== null) {
    q = q.in("state", expectedSourceStates);
  } else {
    q = q.neq("state", "archived");
  }
  if (options.requireNoActiveLease) {
    const nowIso = new Date().toISOString();
    q = q.or(`claim_expires_at.is.null,claim_expires_at.lt.${nowIso}`);
  }
  const { data, error } = await q.select("id");

  if (error) {
    throw new Error(
      `Agent ${opName} failed: ${scrubErrorMessage(error.message ?? String(error))}`,
    );
  }
  return { affected: Array.isArray(data) && data.length > 0 };
}

export function pauseAgentFor(userId: string, raw: unknown): Promise<MutationResult> {
  return transitionAgentState(userId, raw, ["active"], "paused", "pause");
}

export function resumeAgentFor(userId: string, raw: unknown): Promise<MutationResult> {
  return transitionAgentState(userId, raw, ["paused"], "active", "resume");
}

export function archiveAgentFor(userId: string, raw: unknown): Promise<MutationResult> {
  return transitionAgentState(userId, raw, null, "archived", "archive", {
    requireNoActiveLease: true,
  });
}
