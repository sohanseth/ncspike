/**
 * Phase 3.0 — agents product surface (client-safe surface).
 *
 * This file is what `/workspace/agents` (and any future agent UI) imports.
 * It must NOT import anything under `src/server/**` at module top level,
 * because vite's `import-protection` plugin denies those from any
 * client-reachable module — even when the import is consumed only inside
 * a `createServerFn` handler body (top-level imports are evaluated by
 * static analysis before tree-shaking runs).
 *
 * What lives here:
 *   - Zod input schemas (the wire contract)
 *   - Type exports (UI-shaped row types)
 *   - `createServerFn` wrappers
 *
 * What lives in the companion `agents.functions.server.ts`:
 *   - The pure `*For(userId, raw)` handlers
 *   - Every server-only dep they pull in (researchDigest template,
 *     scrubErrorMessage)
 *
 * Each `createServerFn` handler body dynamically imports its impl from
 * `./agents.functions.server`. Dynamic imports inside the handler body
 * are NOT walked by the client-side import-protection check, AND the
 * entire handler body is replaced with an RPC stub on the client at
 * build time — so the server-only module never reaches the browser.
 *
 * Tests target the `*For` handlers directly via `@/lib/agents.functions.server`.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";

// ─── Wire schemas (client-safe — no server imports) ──────────────────────

export const CreateResearchDigestAgentInputSchema = z.object({
  display_name: z.string().trim().min(1).max(80),
  topics: z.array(z.string().trim().min(1).max(120)).min(1).max(5),
});

export type CreateResearchDigestAgentInput = z.infer<
  typeof CreateResearchDigestAgentInputSchema
>;

export const AgentIdSchema = z.object({
  agentId: z.string().uuid(),
});

export type AgentIdInput = z.infer<typeof AgentIdSchema>;

// ─── Return shapes (types — erased at runtime, safe everywhere) ──────────

export type CreatedAgentSummary = {
  id: string;
  template_id: string;
  display_name: string;
  badge: string;
  state: string;
  cadence_hours: number;
};

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

// ─── createServerFn wrappers ─────────────────────────────────────────────
//
// Handler bodies do a dynamic import of the server-only impl so the
// server-only deps never reach the client bundle. The createServerFn
// machinery already replaces the body with an RPC stub on the client,
// but vite's static import-analysis runs first and would still deny
// a top-level server import — hence the dynamic form.

export const createResearchDigestAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: CreateResearchDigestAgentInput) => d)
  .handler(async ({ data, context }): Promise<CreatedAgentSummary> => {
    const mod = await import("./agents.functions.server");
    return mod.createResearchDigestAgentFor(context.userId, data);
  });

export const listAgents = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<AgentListItem[]> => {
    const mod = await import("./agents.functions.server");
    return mod.listAgentsFor(context.userId);
  });

export const pauseAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: AgentIdInput) => d)
  .handler(async ({ data, context }): Promise<MutationResult> => {
    const mod = await import("./agents.functions.server");
    return mod.pauseAgentFor(context.userId, data);
  });

export const resumeAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: AgentIdInput) => d)
  .handler(async ({ data, context }): Promise<MutationResult> => {
    const mod = await import("./agents.functions.server");
    return mod.resumeAgentFor(context.userId, data);
  });

export const archiveAgent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: AgentIdInput) => d)
  .handler(async ({ data, context }): Promise<MutationResult> => {
    const mod = await import("./agents.functions.server");
    return mod.archiveAgentFor(context.userId, data);
  });
