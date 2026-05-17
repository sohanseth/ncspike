/**
 * Phase 3.0 PR3c — Cloudflare Worker scheduled-handler wiring.
 *
 * Pins the contract the cron deployment relies on:
 *
 *   - the agent cron ("*\/30 * * * *") invocations dispatch to
 *     `runAgentBatchTick`, which calls `runAgentBatch` with production
 *     deps (resolveTemplate + assembleBroker) and emits structured
 *     start/end logs.
 *   - the nightly cron ("7 3 * * *") invocations stay on the existing
 *     research-cron path
 *     (the agent wiring must not regress the nightly research run).
 *   - Unknown crons are logged and ignored — never throw, so a wrangler
 *     trigger added without a worker handler doesn't take down the deploy.
 *   - `runAgentBatch` throwing is caught and the failure log scrubs PII.
 *
 * Mocks the downstream modules (batch, templates, broker, research-cron,
 * supabase) so this test doesn't reach for real infrastructure. The test
 * exercises only the dispatch + log envelope in `src/worker.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (must precede the worker import) ────────────────────────────────

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: vi.fn(async () => new Response("ok")) },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
}));

vi.mock("@/server/agents/batch", () => ({
  runAgentBatch: vi.fn(),
}));

vi.mock("@/server/agents/templates", () => ({
  resolveTemplate: vi.fn(),
  templates: {},
}));

vi.mock("@/server/context-broker", () => ({
  assembleSystemPrompt: vi.fn(async () => ({
    fragment: "FRAGMENT",
    contextUsed: { categories: [], trait_paths: [] },
    scrubBlocked: false,
    traitSheetVersion: null,
  })),
}));

vi.mock("@/server/research-cron", () => ({
  runResearchBatchAllUsers: vi.fn(async () => ({ users: 0 })),
}));

// chainFor / strictestTierInChain are pure — let them run real. The
// runner.ts router exports a stable shape.

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import worker, {
  runAgentBatchTick,
  AGENT_CRON,
  RESEARCH_CRON,
} from "@/worker";
import { runAgentBatch } from "@/server/agents/batch";
import { runResearchBatchAllUsers } from "@/server/research-cron";
import { assembleSystemPrompt } from "@/server/context-broker";
import { resolveTemplate } from "@/server/agents/templates";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void promises.push(p) },
    settle: () => Promise.all(promises),
  };
}

const OK_RESULT = { sweptTimedOut: 0, claimed: 0, succeeded: 0, failed: 0 };

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ─── runAgentBatchTick — success path ──────────────────────────────────────

describe("runAgentBatchTick — success path", () => {
  it("calls runAgentBatch once with deps that include resolveTemplate + assembleBroker", async () => {
    vi.mocked(runAgentBatch).mockResolvedValue({
      sweptTimedOut: 2,
      claimed: 7,
      succeeded: 6,
      failed: 1,
    });

    await runAgentBatchTick();

    expect(vi.mocked(runAgentBatch)).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(runAgentBatch).mock.calls[0][0];
    expect(typeof deps.resolveTemplate).toBe("function");
    expect(typeof deps.assembleBroker).toBe("function");
    // resolveTemplate is the registry export — passed through, not wrapped.
    expect(deps.resolveTemplate).toBe(resolveTemplate);
  });

  it("emits structured start + end logs with batch counts and durationMs", async () => {
    vi.mocked(runAgentBatch).mockResolvedValue({
      sweptTimedOut: 2,
      claimed: 7,
      succeeded: 6,
      failed: 1,
    });

    await runAgentBatchTick();

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const start = lines.find((l) => l.startsWith("[worker.scheduled.agents] start"));
    const end = lines.find((l) => l.startsWith("[worker.scheduled.agents] end"));
    expect(start).toBeDefined();
    expect(start).toContain(`cron=${AGENT_CRON}`);
    expect(end).toBeDefined();
    expect(end).toMatch(/swept=2\b/);
    expect(end).toMatch(/claimed=7\b/);
    expect(end).toMatch(/succeeded=6\b/);
    expect(end).toMatch(/failed=1\b/);
    expect(end).toMatch(/durationMs=\d+/);
  });

  it("assembleBroker dep computes strictestTierInChain from the badge", async () => {
    vi.mocked(runAgentBatch).mockResolvedValue(OK_RESULT);
    await runAgentBatchTick();

    const deps = vi.mocked(runAgentBatch).mock.calls[0][0];
    const broker = await deps.assembleBroker({
      userId: "user-1",
      badge: "flash",
      query: "test query",
    });

    expect(broker.fragment).toBe("FRAGMENT");
    expect(typeof broker.resolvedTier).toBe("number");

    // assembleSystemPrompt was called with a derived tier (not undefined,
    // not the bare badge).
    expect(vi.mocked(assembleSystemPrompt)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(assembleSystemPrompt).mock.calls[0][0];
    expect(args.userId).toBe("user-1");
    expect(args.badge).toBe("flash");
    expect(args.query).toBe("test query");
    expect(typeof args.strictestTierInChain).toBe("number");
    expect(args.strictestTierInChain).toBe(broker.resolvedTier);
  });
});

// ─── runAgentBatchTick — failure path ──────────────────────────────────────

describe("runAgentBatchTick — failure path", () => {
  it("catches a thrown runAgentBatch and scrubs the failure log (no rethrow)", async () => {
    vi.mocked(runAgentBatch).mockRejectedValue(
      new Error("batch crashed with 'quoted PII' inside"),
    );

    // The tick must NOT propagate the throw — `ctx.waitUntil(runAgentBatchTick())`
    // expects an always-resolving promise.
    await expect(runAgentBatchTick()).resolves.toBeUndefined();

    const errLines = errSpy.mock.calls
      .flat()
      .filter((a) => typeof a === "string")
      .join(" ");
    expect(errLines).toContain("[worker.scheduled.agents] threw");
    // Scrubber redacts quoted spans; the PII substring must not appear.
    expect(errLines).not.toMatch(/quoted PII/);
  });

  it("does NOT emit the end log on the failure path", async () => {
    vi.mocked(runAgentBatch).mockRejectedValue(new Error("ledger outage"));
    await runAgentBatchTick();

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.find((l) => l.startsWith("[worker.scheduled.agents] start"))).toBeDefined();
    expect(lines.find((l) => l.startsWith("[worker.scheduled.agents] end"))).toBeUndefined();
  });
});

// ─── scheduled handler — cron dispatch ─────────────────────────────────────

describe("scheduled handler — cron dispatch", () => {
  it("routes the agent cron to runAgentBatch via runAgentBatchTick", async () => {
    vi.mocked(runAgentBatch).mockResolvedValue(OK_RESULT);
    const { ctx, settle } = makeCtx();

    await worker.scheduled(
      { cron: AGENT_CRON, scheduledTime: Date.now() },
      {},
      ctx,
    );
    await settle();

    expect(vi.mocked(runAgentBatch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runResearchBatchAllUsers)).not.toHaveBeenCalled();
  });

  it("routes the nightly cron to research-cron (existing path unchanged)", async () => {
    const { ctx, settle } = makeCtx();

    await worker.scheduled(
      { cron: RESEARCH_CRON, scheduledTime: Date.now() },
      {},
      ctx,
    );
    await settle();

    expect(vi.mocked(runResearchBatchAllUsers)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgentBatch)).not.toHaveBeenCalled();
  });

  it("ignores an unknown cron with a warn log (no throw)", async () => {
    const { ctx, settle } = makeCtx();

    await expect(
      worker.scheduled(
        { cron: "0 0 1 1 *", scheduledTime: Date.now() },
        {},
        ctx,
      ),
    ).resolves.toBeUndefined();
    await settle();

    expect(vi.mocked(runAgentBatch)).not.toHaveBeenCalled();
    expect(vi.mocked(runResearchBatchAllUsers)).not.toHaveBeenCalled();
    const warnLines = warnSpy.mock.calls
      .flat()
      .filter((a) => typeof a === "string")
      .join(" ");
    expect(warnLines).toContain("[worker.scheduled] unhandled cron=0 0 1 1 *");
  });
});

// ─── Static invariant: wrangler trigger ↔ worker dispatch ─────────────────
//
// The dispatcher uses `event.cron` strings, so wrangler.jsonc and worker.ts
// must agree on the literal patterns. A drift between them silently
// no-ops the corresponding tick (the unknown-cron branch logs but doesn't
// throw). This invariant pins the contract so divergence is caught at CI
// rather than discovered in prod via missing batch runs.

describe("Static invariant: wrangler crons match worker dispatch constants", () => {
  it("wrangler.jsonc contains both cron strings the worker dispatches on", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const wrangler = fs.readFileSync(
      path.join(__dirname, "..", "..", "wrangler.jsonc"),
      "utf8",
    );
    expect(wrangler).toContain(`"${AGENT_CRON}"`);
    expect(wrangler).toContain(`"${RESEARCH_CRON}"`);
  });
});
