/**
 * Cloudflare Worker entry. Wraps the TanStack Start SSR fetch handler and
 * dispatches scheduled invocations by cron pattern.
 *
 * Two crons are wired (see wrangler.jsonc `triggers.crons`):
 *
 *   - `7 3 * * *`     — nightly research queue (existing; `src/server/research-cron.ts`)
 *   - the AGENT_CRON  — agent runtime batch tick every 30 min (PR3c; `src/server/agents/batch.ts`)
 *
 * The handler stays a thin dispatch + log layer. All durable work lives in
 * the modules behind it — runner/batch/template/budget are not touched from
 * here.
 */
import startEntry from "@tanstack/react-start/server-entry";
import { runResearchBatchAllUsers } from "@/server/research-cron";
import { runAgentBatch } from "@/server/agents/batch";
import { resolveTemplate } from "@/server/agents/templates";
import { assembleSystemPrompt } from "@/server/context-broker";
import { chainFor, type Badge } from "@/server/inference/router";
import { strictestTierInChain } from "@/lib/provider-tiers";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

// Minimal Cloudflare Workers types so we don't need the @cloudflare/workers-types
// devDep just for two parameter shapes.
type CfScheduledEvent = { cron: string; scheduledTime: number };
type CfExecutionContext = { waitUntil(p: Promise<unknown>): void };

export const AGENT_CRON = "*/30 * * * *";
export const RESEARCH_CRON = "7 3 * * *";

/**
 * Production broker wrapper. Maps `RunnerDeps.assembleBroker`'s shape
 * (`{userId, badge, query} → {fragment, resolvedTier}`) onto the existing
 * `assembleSystemPrompt` from the context broker, computing
 * `strictestTierInChain` from the badge's provider chain (matches the chat
 * path's behaviour in `src/lib/chat.functions.ts`).
 */
async function productionAssembleBroker(args: {
  userId: string;
  badge: Badge;
  query: string;
}): Promise<{ fragment: string; resolvedTier: number }> {
  const chain = chainFor(args.badge).chain;
  const tier = strictestTierInChain(chain);
  const r = await assembleSystemPrompt({
    userId: args.userId,
    query: args.query,
    badge: args.badge,
    strictestTierInChain: tier,
  });
  return { fragment: r.fragment, resolvedTier: tier };
}

/**
 * One agent-batch tick. Owns the start/end/failure log envelope so the
 * scheduled handler stays a pure dispatcher.
 *
 * Exported for test injection — tests mock the underlying `runAgentBatch`
 * and assert this function's log envelope + dispatch behaviour without
 * spinning up the full TanStack server entry.
 *
 * Never throws. A throw from `runAgentBatch` (very unlikely — the batch
 * already catches per-agent failures) is caught here and scrubbed; the
 * stuck-run sweep on the next tick reconciles any half-finalized rows.
 */
export async function runAgentBatchTick(): Promise<void> {
  const startedAt = Date.now();
  console.log(`[worker.scheduled.agents] start cron=${AGENT_CRON}`);
  try {
    const result = await runAgentBatch({
      resolveTemplate,
      assembleBroker: productionAssembleBroker,
    });
    console.log(
      `[worker.scheduled.agents] end ` +
        `swept=${result.sweptTimedOut} ` +
        `claimed=${result.claimed} ` +
        `succeeded=${result.succeeded} ` +
        `failed=${result.failed} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
  } catch (e) {
    console.error(
      `[worker.scheduled.agents] threw after ${Date.now() - startedAt}ms:`,
      scrubErrorMessage(e),
    );
  }
}

export default {
  fetch: startEntry.fetch,
  async scheduled(
    event: CfScheduledEvent,
    _env: unknown,
    ctx: CfExecutionContext,
  ): Promise<void> {
    if (event.cron === AGENT_CRON) {
      ctx.waitUntil(runAgentBatchTick());
      return;
    }
    if (event.cron === RESEARCH_CRON) {
      ctx.waitUntil(
        runResearchBatchAllUsers().catch((e) => {
          console.error("[worker.scheduled] research cron threw:", scrubErrorMessage(e));
        }),
      );
      return;
    }
    // Wrangler added a trigger that the handler doesn't know about.
    // Log and ignore so the deploy doesn't silently no-op on the new cron.
    console.warn(
      `[worker.scheduled] unhandled cron=${event.cron}; check wrangler.jsonc vs worker dispatch`,
    );
  },
};
