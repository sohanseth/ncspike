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

/** Strips internal fields (run_id, dedupe_key, payload) we don't render. */
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
