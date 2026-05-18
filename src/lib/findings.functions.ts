/**
 * Phase 3.0 — findings inbox (client-safe surface).
 *
 * Companion to `findings.functions.server.ts`. Mirrors the split rationale
 * documented in `agents.functions.ts` — top-level imports here are only
 * the client-safe ones; the handler dynamically pulls the server-only
 * impl so vite's import-protection doesn't trip on `@/server/...`.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";

/** Strips internal fields (run_id, payload) we don't render. `dedupe_key`
 *  is surfaced so the inbox can look up per-finding briefing labels
 *  (briefings key labels by dedupeKey, not by the DB-generated `id`). */
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
  /** Template-defined stable key (canonicalized URL for ResearchDigest).
   *  Used as the join key into `AgentBriefing.findingLabels`. */
  dedupe_key: string;
};

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

/** Most recent briefing per agent. Inbox shows it ABOVE that agent's
 *  findings. `briefing` is the JSONB blob from `agent_runs.briefing` —
 *  shape is template-defined (see ResearchDigestBriefingSchema in
 *  src/server/agents/templates/research-digest.ts). The inbox UI runs
 *  its own defensive narrowing via `safeBriefing(raw)`. */
export type AgentBriefing = {
  agent_id: string;
  run_id: string;
  briefing: JsonValue;
  run_started_at: string;
  run_finished_at: string | null;
};

/** Default page size; comfortably above one day's high-cadence output
 *  and well under any reasonable UI scroll budget. */
export const DEFAULT_LIMIT = 50;
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

export const listFindings = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: ListFindingsInput | undefined) => d ?? {})
  .handler(async ({ data, context }): Promise<FindingItem[]> => {
    const mod = await import("./findings.functions.server");
    return mod.listFindingsFor(context.userId, data);
  });

/**
 * Fetch the most recent briefing for each of the user's non-archived
 * agents (one per agent). Used by the inbox to render the briefing
 * block above the per-agent finding cards.
 *
 * Returns only briefings that successfully landed in agent_runs —
 * runs that fell back to deterministic OR threw at briefing-generation
 * time produced either a deterministic briefing OR no row update, so
 * an agent without any successful briefing simply doesn't appear here.
 * The inbox UI treats that as "no briefing yet" and renders findings
 * without the briefing block (back-compat with pre-2026-05-18 runs).
 */
export const listBriefings = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<AgentBriefing[]> => {
    const mod = await import("./findings.functions.server");
    return mod.listBriefingsFor(context.userId);
  });
