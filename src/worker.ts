/**
 * Cloudflare Worker entry. Wraps the TanStack Start SSR fetch handler and
 * adds a `scheduled` handler so wrangler cron triggers can drive the
 * overnight research queue.
 *
 * Cron schedule lives in wrangler.jsonc. The actual work is in
 * src/server/research-cron.ts so this file stays a thin glue layer.
 */
import startEntry from "@tanstack/react-start/server-entry";
import { runResearchBatchAllUsers } from "@/server/research-cron";

// Minimal Cloudflare Workers types so we don't need the @cloudflare/workers-types
// devDep just for two parameter shapes.
type CfScheduledEvent = { cron: string; scheduledTime: number };
type CfExecutionContext = { waitUntil(p: Promise<unknown>): void };

export default {
  fetch: startEntry.fetch,
  async scheduled(
    _event: CfScheduledEvent,
    _env: unknown,
    ctx: CfExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runResearchBatchAllUsers().catch((e) => {
        console.error("[worker.scheduled] research cron threw:", e);
      }),
    );
  },
};
