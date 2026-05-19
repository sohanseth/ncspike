/**
 * Phase 3.0 — agent home (client-safe surface).
 *
 * Companion to `agent-home.functions.server.ts`. Same split rationale
 * as `findings.functions.ts` — top-level imports stay client-safe;
 * the handlers dynamically import the server impl so vite's
 * import-protection doesn't trip on `@/server/...`.
 *
 * Two serverFns:
 *   - listAgentRows()    — inbox-level: one row per non-archived agent
 *                          with status-line content (docs/25 §10)
 *   - getAgentHome(id)   — page-level: latest briefing + recent runs
 *                          + header data for a single agent
 *                          (docs/25 §1, §4)
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";

/** Recursive JSON value type — what TanStack Start's wire-serializer
 *  accepts. Used for the briefing JSONB blob which has a free-form
 *  template-defined shape. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

/** One row in the agent home list (the restyled inbox).
 *  status-line content per docs/25 §10. */
export type AgentRow = {
  id: string;
  display_name: string;
  template_id: string;
  state: string;
  cadence_hours: number;
  topics_label: string | null;
  /** Most-recent run for this agent (any status). null if never run. */
  latest_run: {
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    /** Whether the run produced a briefing of ANY version. */
    has_briefing: boolean;
    items_kept: number;
  } | null;
};

/** Payload for the agent home page. The page reads from existing tables
 *  (agents, agent_runs, agent_findings) — no new tables. */
export type AgentHome = {
  agent: {
    id: string;
    display_name: string;
    template_id: string;
    state: string;
    cadence_hours: number;
    topics_label: string | null;
  };
  /** The latest run that PRODUCED a briefing the page should render.
   *  Distinguishes from "the most recent run" (which may have failed
   *  or skipped). Used for the top-of-page briefing surface. */
  latest_briefing_run: {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    /** The briefing JSONB exactly as stored. The component handles
     *  v3 / v2 / v1 / null dispatch. */
    briefing: JsonValue;
    items_kept: number;
  } | null;
  /** Most recent run (any status) — drives the header's "alive" signals.
   *  May or may not match latest_briefing_run (a failed run is most-recent
   *  but the briefing surface still uses the prior successful one). */
  latest_run: {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    items_kept: number;
    has_briefing: boolean;
  } | null;
  /** Recent run history for the activity timeline. Newest first. */
  recent_runs: Array<{
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    items_kept: number;
    has_briefing: boolean;
    briefing: JsonValue;
  }>;
};

const GetAgentHomeInputSchema = z.object({
  agentId: z.string().uuid(),
});

export type GetAgentHomeInput = z.infer<typeof GetAgentHomeInputSchema>;

/**
 * List agents for the inbox/agent-home list. Returns one row per
 * non-archived agent with status-line content (last run + status +
 * has-briefing signal).
 */
export const listAgentRows = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<AgentRow[]> => {
    const mod = await import("./agent-home.functions.server");
    return mod.listAgentRowsFor(context.userId);
  });

/**
 * Fetch the agent home payload for a single agent. Returns null if
 * the agent doesn't exist OR belongs to a different user (per RLS).
 */
export const getAgentHome = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: GetAgentHomeInput) => GetAgentHomeInputSchema.parse(d))
  .handler(async ({ data, context }): Promise<AgentHome | null> => {
    const mod = await import("./agent-home.functions.server");
    return mod.getAgentHomeFor(context.userId, data.agentId);
  });
