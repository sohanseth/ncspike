/**
 * Phase 3.0 agent template registry.
 *
 * The cron entrypoint (PR3c) wires `runAgentBatch` with
 * `resolveTemplate: (id) => templates[id]`. Concrete templates
 * self-register here.
 *
 * **3.0 ships exactly one template** (ResearchDigest). 3.1+ adds
 * JobAgent / ShoppingAgent / DealWatcher; 3.4 adds AST-driven
 * dynamic templates. Each registers via a single export entry.
 *
 * **Invariant:** the runtime imports ONLY this index file, never the
 * concrete template modules directly. The `templates` constant is
 * typed as `Record<string, AgentTemplate<unknown, unknown>>` so the
 * runner can't accidentally rely on a concrete TConfig/TItem shape.
 */
import type { AgentTemplate } from "../types";
import { researchDigest } from "./research-digest";

export const templates: Record<string, AgentTemplate<unknown, unknown>> = {
  [researchDigest.id]: researchDigest as AgentTemplate<unknown, unknown>,
};

/** Convenience for the cron wiring in PR3c. Always returns the same shape
 *  whether the id matches or not (undefined for unknown ids), matching
 *  the `RunnerDeps.resolveTemplate` contract. */
export function resolveTemplate(
  id: string,
): AgentTemplate<unknown, unknown> | undefined {
  return templates[id];
}
