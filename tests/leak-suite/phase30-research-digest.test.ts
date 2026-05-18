/**
 * Phase 3.0 PR3b — ResearchDigest unit tests + invariant pass-condition.
 *
 * Two distinct concerns covered here:
 *
 *   1. **Template correctness** — config validation, URL canonicalisation
 *      (the dedupe-key surface), score-reply parsing, fetch/score/
 *      summarise return shapes, _costMicroUsd derivation from real
 *      pricing.ts.
 *
 *   2. **Invariant pass-condition for PR3b (Sneha):** ResearchDigest
 *      runs through the GENERIC runner (PR3a) with zero changes to
 *      `runner.ts` or `batch.ts`. We exercise the full execute() path
 *      with the real template, mocked supabase + budget, and assert
 *      both the run-row finalization AND a grep-style check that
 *      runner.ts hasn't been touched since the last main commit.
 *
 * Real-DB end-to-end coverage lives in
 * `phase30-pipeline-realdb.test.ts` (skip-on-no-DB).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock supabase admin (runner writes agent_runs / agent_findings / agent_state).
type Row = Record<string, unknown>;
let agentRunsRows: Row[] = [];
let agentFindingsInserts: Row[] = [];
let agentStateRows: Row[] = [];

beforeEach(() => {
  agentRunsRows = [];
  agentFindingsInserts = [];
  agentStateRows = [];
  searxngCalls = [];
  tavilyCalls = [];
  generateCalls = [];
  vi.clearAllMocks();
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table === "agent_runs") {
        return {
          insert(row: Row) {
            agentRunsRows.push({ ...row });
            return Promise.resolve({ error: null });
          },
          update(patch: Row) {
            const filters: Array<{ op: string; col: string; val: unknown }> = [];
            const chain = {
              eq(col: string, val: unknown) {
                filters.push({ op: "eq", col, val });
                return chain;
              },
              lt() { return chain; },
              select() { return Promise.resolve({ data: [], error: null }); },
              then(resolve: (v: { error: null }) => void) {
                const t = agentRunsRows.find((r) =>
                  filters.every((f) => f.op === "eq" && r[f.col] === f.val),
                );
                if (t) Object.assign(t, patch);
                resolve({ error: null });
              },
            };
            return chain;
          },
          // SELECT chain — added for v2 briefing's prior-briefing fetch
          // (docs/20 §5, 2026-05-18). Supports: select().eq().neq().not(col, "is", null).order().limit() then await.
          select(_cols: string) {
            const eqs: Array<{ col: string; val: unknown }> = [];
            const neqs: Array<{ col: string; val: unknown }> = [];
            const notNulls: string[] = [];
            let orderBy: { col: string; asc: boolean } | null = null;
            let limitN: number | null = null;
            const chain = {
              eq(col: string, val: unknown) { eqs.push({ col, val }); return chain; },
              neq(col: string, val: unknown) { neqs.push({ col, val }); return chain; },
              not(col: string, op: string, val: unknown) {
                if (op === "is" && val === null) notNulls.push(col);
                return chain;
              },
              order(col: string, opts?: { ascending?: boolean }) {
                orderBy = { col, asc: opts?.ascending ?? true };
                return chain;
              },
              limit(n: number) { limitN = n; return chain; },
              then(resolve: (v: { data: Row[]; error: null }) => void) {
                let result = agentRunsRows.filter(
                  (r) =>
                    eqs.every((f) => r[f.col] === f.val) &&
                    neqs.every((f) => r[f.col] !== f.val) &&
                    notNulls.every((c) => r[c] !== null && r[c] !== undefined),
                );
                if (orderBy) {
                  const o = orderBy as { col: string; asc: boolean };
                  result = [...result].sort((a, b) => {
                    const av = a[o.col] as string | number;
                    const bv = b[o.col] as string | number;
                    if (av === bv) return 0;
                    return (av < bv ? -1 : 1) * (o.asc ? 1 : -1);
                  });
                }
                if (limitN !== null) result = result.slice(0, limitN);
                resolve({ data: result, error: null });
              },
            };
            return chain;
          },
        };
      }
      if (table === "agent_findings") {
        return {
          insert(row: Row) {
            agentFindingsInserts.push({ ...row });
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "agent_state") {
        return {
          select() {
            const b = {
              _agentId: undefined as string | undefined,
              _key: undefined as string | undefined,
              eq(col: string, val: string) {
                if (col === "agent_id") b._agentId = val;
                if (col === "key") b._key = val;
                return b;
              },
              maybeSingle() {
                const f = agentStateRows.find(
                  (r) => r.agent_id === b._agentId && r.key === b._key,
                );
                return Promise.resolve({
                  data: f ? { value: f.value } : null,
                  error: null,
                });
              },
            };
            return b;
          },
          upsert(row: Row) {
            const idx = agentStateRows.findIndex(
              (r) => r.agent_id === row.agent_id && r.key === row.key,
            );
            if (idx >= 0) agentStateRows[idx] = { ...row };
            else agentStateRows.push({ ...row });
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected supabase.from(${table})`);
    },
  },
}));

vi.mock("@/server/agents/queue", () => ({
  claimDueAgents: vi.fn(),
  releaseAgentLease: vi.fn(),
  updateAgentLifecycleState: vi.fn(),
}));

vi.mock("@/server/agents/budget", () => ({
  checkBudget: vi.fn(),
  recordCost: vi.fn(),
  CPAUD_CEILING_USD: 1.5,
}));

// Mock `runSearch` (what ResearchDigest actually consumes) at the
// module boundary. Keep `resolveSearchProvider`/`resolveSearxngInstances`
// REAL via importOriginal — those are tested directly elsewhere.
//
// Why mock `runSearch` rather than the per-provider helpers: vi.mock's
// replacement of one export does NOT remap intra-module calls in the
// same file. `runSearch`'s body calls `searxngSearch`/`tavilySearch`
// via local bindings; mocking those exports wouldn't affect what
// `runSearch` actually invokes. Mocking `runSearch` directly sidesteps
// that. The dispatcher's 4-line `provider === 'tavily' ? ... : ...`
// branching is covered by separate tests on `resolveSearchProvider`.
let searxngCalls: string[] = [];
let tavilyCalls: string[] = [];
vi.mock("@/lib/search.functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search.functions")>();
  return {
    ...actual,
    runSearch: vi.fn(async (q: string) => {
      // Default: simulate the SearXNG path with canned hits, so
      // existing tests behave as before. Per-test overrides can
      // simulate Tavily / failure modes via mockResolvedValue.
      searxngCalls.push(q);
      return {
        provider: "searxng" as const,
        instance: "https://test.searxng.example",
        lastError: null,
        results: [
          {
            title: `${q} — article 1`,
            url: `https://example.test/${encodeURIComponent(q)}/1`,
            snippet: `Snippet about ${q}`,
            engine: "duckduckgo",
          },
          {
            title: `${q} — article 2`,
            url: `https://example.test/${encodeURIComponent(q)}/2?utm_source=test&id=keep`,
            snippet: `Another snippet about ${q}`,
            engine: "google",
          },
        ],
      };
    }),
  };
});

// Helper to drive Tavily-shaped responses through the runSearch mock
// in per-test setup. Mirrors what the real Tavily adapter would
// return on success.
function tavilyHits(q: string) {
  tavilyCalls.push(q);
  return {
    provider: "tavily" as const,
    instance: "tavily",
    lastError: null,
    results: [
      {
        title: `${q} — tavily 1`,
        url: `https://example.test/tavily/${encodeURIComponent(q)}/1`,
        snippet: `Tavily snippet about ${q}`,
      },
      {
        title: `${q} — tavily 2`,
        url: `https://example.test/tavily/${encodeURIComponent(q)}/2`,
        snippet: `Another tavily snippet about ${q}`,
      },
    ],
  };
}

// Mock the inference dispatcher — capture call args + return scripted text.
// Three call types: score (maxTokens<=16), briefing (maxTokens>=400),
// summarise (legacy, maxTokens~120 — dormant in v2). Default mock returns
// valid v2 JSON for briefing so happy-path tests don't have to override
// the mock just to satisfy briefing schema validation.
let generateCalls: Array<{ messages: unknown; maxTokens?: number }> = [];
let scriptedScores: number[] = [];
let nextSummariseText = "Two-sentence summary about the topic. It mentions things.";

function buildDefaultBriefingJsonV2(promptText: string): string {
  // Extract dedupeKeys from the prompt's `id=...` lines so support keys
  // actually reference items the briefing function will accept.
  const keys = Array.from(promptText.matchAll(/id=(\S+)/g)).map((m) => m[1]);
  const supportKeys = keys.slice(0, Math.min(3, keys.length));
  return JSON.stringify({
    version: 2,
    kind: "research",
    headline: "Test briefing (default mock).",
    synthesis: "From this batch I kept some items; this is the default-mock briefing.",
    memorableTakeaways:
      supportKeys.length > 0
        ? [
            {
              text: "Default-mock takeaway.",
              supportSourceKeys: supportKeys,
              provenance: "new",
            },
          ]
        : [],
    readFirst:
      supportKeys.length > 0
        ? [{ sourceKey: supportKeys[0], reason: "default mock pick", provenance: "new" }]
        : [],
    skipOrCollapse: [],
    distinctIdeas: [],
    nextSearchSuggestions: [],
  });
}

vi.mock("@/server/inference", () => ({
  generate: vi.fn(async (req: any) => {
    generateCalls.push({ messages: req.messages, maxTokens: req.maxTokens });
    // Score: maxTokens<=16.
    if (req.maxTokens && req.maxTokens <= 16) {
      const nextScore = scriptedScores.length > 0 ? scriptedScores.shift()! : 0.9;
      return {
        text: String(nextScore),
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        inputTokens: 80,
        outputTokens: 4,
      };
    }
    // Briefing: maxTokens>=400. Return valid v2 JSON so most tests
    // don't have to override the mock just to satisfy briefing validation.
    if (req.maxTokens && req.maxTokens >= 400) {
      const userMsg = (req.messages ?? []).find(
        (m: { role: string; content: string }) => m.role === "user",
      );
      const promptText = (userMsg?.content as string) ?? "";
      return {
        text: buildDefaultBriefingJsonV2(promptText),
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        inputTokens: 600,
        outputTokens: 200,
      };
    }
    // Summarise (legacy, dormant in v2 — kept for safety).
    return {
      text: nextSummariseText,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 90,
      outputTokens: 60,
    };
  }),
}));

// ─── Subjects under test (imported after all mocks) ───────────────────────

import {
  researchDigest,
  canonicaliseUrl,
  parseScoreReply,
  ResearchDigestConfigSchema,
} from "@/server/agents/templates/research-digest";
import { templates, resolveTemplate } from "@/server/agents/templates";
import { execute, type RunnerDeps } from "@/server/agents/runner";
import { checkBudget, recordCost } from "@/server/agents/budget";
import type { AgentRow, BrokerContext } from "@/server/agents/types";
import { resolveSearchProvider, runSearch } from "@/lib/search.functions";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const USER = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const BROKER: BrokerContext = { fragment: "(opaque broker fragment)", resolvedTier: 1 };
const FIXED_NOW = new Date("2026-05-17T12:00:00Z");

function makeResearchAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: AGENT_ID,
    user_id: USER,
    template_id: "research_digest",
    display_name: "AI safety daily",
    config: {
      topics: ["AI safety", "RLHF"],
      lookbackHours: 24,
      minScore: 0.5,
    },
    badge: "flash",
    state: "active",
    cadence_hours: 24,
    budget: {
      maxRunsPerDay: 1,
      maxItemsConsideredPerRun: 30,
      maxLLMHopsPerItem: 1,
      maxNotificationsPerDay: 1,
    },
    notify: {},
    created_at: FIXED_NOW.toISOString(),
    updated_at: FIXED_NOW.toISOString(),
    last_claimed_at: FIXED_NOW.toISOString(),
    last_completed_at: null,
    last_useful_at: null,
    claim_expires_at: new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString(),
    consecutive_failures: 0,
    ...overrides,
  };
}

function pipelineDeps(): RunnerDeps {
  return {
    resolveTemplate,
    assembleBroker: async () => BROKER,
    now: () => FIXED_NOW,
  };
}

// ─── Template unit tests (template-only) ─────────────────────────────────

describe("ResearchDigest — config validation", () => {
  it("accepts a minimal valid config", () => {
    const parsed = ResearchDigestConfigSchema.parse({ topics: ["alignment"] });
    expect(parsed.topics).toEqual(["alignment"]);
    expect(parsed.lookbackHours).toBe(24); // default
    expect(parsed.minScore).toBe(0.5);     // default
  });

  it("rejects empty topics list", () => {
    expect(() =>
      ResearchDigestConfigSchema.parse({ topics: [] }),
    ).toThrow();
  });

  it("rejects more than 5 topics", () => {
    expect(() =>
      ResearchDigestConfigSchema.parse({
        topics: ["a", "b", "c", "d", "e", "f"],
      }),
    ).toThrow();
  });

  it("rejects minScore outside [0, 1]", () => {
    expect(() =>
      ResearchDigestConfigSchema.parse({ topics: ["x"], minScore: 1.5 }),
    ).toThrow();
  });
});

describe("ResearchDigest — canonicaliseUrl (dedupe key)", () => {
  it("strips utm_* tracking params", () => {
    expect(canonicaliseUrl("https://example.com/post?utm_source=x&id=42")).toBe(
      "https://example.com/post?id=42",
    );
  });

  it("strips fbclid / gclid / ref / mc_* etc.", () => {
    expect(canonicaliseUrl("https://example.com/p?fbclid=abc")).toBe(
      "https://example.com/p",
    );
    expect(canonicaliseUrl("https://example.com/p?gclid=z&mc_eid=1")).toBe(
      "https://example.com/p",
    );
  });

  it("preserves real query params", () => {
    expect(canonicaliseUrl("https://example.com/p?article=42")).toBe(
      "https://example.com/p?article=42",
    );
  });

  it("strips trailing slash on non-root paths but keeps root /", () => {
    expect(canonicaliseUrl("https://example.com/p/")).toBe("https://example.com/p");
    expect(canonicaliseUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("drops URL fragments (TOC links shouldn't fork dedupe)", () => {
    expect(canonicaliseUrl("https://example.com/p#section-3")).toBe(
      "https://example.com/p",
    );
  });

  it("lowercases the host but preserves path case", () => {
    expect(canonicaliseUrl("https://Example.COM/MyArticle")).toBe(
      "https://example.com/MyArticle",
    );
  });

  it("falls back to the raw string on malformed input", () => {
    expect(canonicaliseUrl("not a url")).toBe("not a url");
  });
});

describe("ResearchDigest — parseScoreReply", () => {
  it("parses plain decimal", () => {
    expect(parseScoreReply("0.7")).toBe(0.7);
  });

  it("parses percentage-style 75 as 0.75", () => {
    expect(parseScoreReply("75")).toBe(0.75);
  });

  it("clips negatives to 0", () => {
    expect(parseScoreReply("-0.5")).toBe(0);
  });

  it("clips >1 floats (e.g. '1.5') to 1", () => {
    expect(parseScoreReply("1.5")).toBe(1);
  });

  it("tolerates trailing commentary", () => {
    expect(parseScoreReply("0.8 — quite relevant")).toBe(0.8);
  });

  it("returns 0 on unparseable", () => {
    expect(parseScoreReply("hmm")).toBe(0);
  });
});

describe("ResearchDigest — registry shape", () => {
  it("templates registry contains exactly research_digest in 3.0", () => {
    expect(Object.keys(templates)).toEqual(["research_digest"]);
  });

  it("resolveTemplate(id) round-trips", () => {
    expect(resolveTemplate("research_digest")).toBe(templates.research_digest);
    expect(resolveTemplate("nonexistent")).toBeUndefined();
  });

  it("registry-typed template can be invoked with unknown config", () => {
    // The registry erases TConfig/TItem to `unknown`. This proves the runner
    // can hand it `agent.config` (also unknown) without casting.
    const t = templates.research_digest;
    expect(typeof t.fetch).toBe("function");
    expect(typeof t.score).toBe("function");
    expect(typeof t.summarise).toBe("function");
    expect(typeof t.dedupeKey).toBe("function");
  });
});

// ─── Full pipeline through the GENERIC runner (PR3b invariant pass) ──────

describe("PR3b invariant: ResearchDigest runs through the generic runner unchanged", () => {
  it("execute(agent, deps) drives ResearchDigest end-to-end → status='ok' + findings", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9, 0.9, 0.9]; // all four results above 0.5 floor

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("ok");

    // 2 topics × 2 results each = 4 items considered, all kept.
    expect(run.items_fetched).toBe(4);
    expect(run.items_kept).toBe(4);
    // v2 (docs/19+20, 2026-05-18): summarise() is now a no-op
    // pass-through (no LLM call). The only LLM hop in the post-fetch
    // pipeline is the single briefing call. ~16× cost reduction vs v1.
    expect(run.llm_hops).toBe(1);
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(run.cost_usd).toBeLessThan(0.01);

    // SearXNG was called once per topic.
    expect(searxngCalls).toEqual(["AI safety", "RLHF"]);
    // generate() was called: 4× score + 0× summarise (v2 no-op) + 1× briefing
    // = 5 times total.
    expect(generateCalls).toHaveLength(5);

    // Findings persisted with the right shape. v2: summary is the Tavily
    // snippet (not an LLM-generated paragraph). Per docs/20 §3 amendment:
    // the snippet is the search provider's raw extract, preserves the
    // "no per-source LLM paragraphs" principle; v2 inbox hides summary
    // entirely so the user never sees it.
    expect(agentFindingsInserts).toHaveLength(4);
    const f = agentFindingsInserts[0];
    expect(f.title).toMatch(/article 1/);
    expect(f.summary).toMatch(/AI safety/); // the mock searxng snippet
    expect((f.payload as { url: string }).url).toMatch(/example\.test/);
    expect((f.payload as { matched_topic: string }).matched_topic).toBe("AI safety");
    // v2: no provider/model in payload (no LLM call in summarise).
    expect((f.payload as { snippet: string }).snippet).toMatch(/AI safety/);
    expect(f.score).toBe(0.9);
    expect(f.state).toBe("new");
  });

  it("low-scoring items are filtered before summarise (saves budget)", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    // Below default minScore=0.5 — should all be filtered out.
    scriptedScores = [0.1, 0.1, 0.1, 0.1];

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.items_fetched).toBe(4);
    expect(run.items_kept).toBe(0); // none passed the score floor
    expect(agentFindingsInserts).toHaveLength(0);
    // No summarise() calls were made for the filtered items.
    const summariseCallCount = generateCalls.filter(
      (c) => (c.maxTokens ?? 0) > 16,
    ).length;
    expect(summariseCallCount).toBe(0);
    expect(run.status).toBe("ok");
  });

  it("dedupe keys flow back to agent_state for future runs", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9, 0.9, 0.9];

    await execute(makeResearchAgent(), pipelineDeps());

    const seen = agentStateRows.find((r) => r.key === "seen_dedupe_keys");
    expect(seen).toBeDefined();
    expect((seen!.value as string[])).toHaveLength(4);
    // Every key should be a canonicalised URL (no utm params).
    for (const key of seen!.value as string[]) {
      expect(key).not.toMatch(/utm_/);
    }
  });
});

// ─── PR3b.1: per-hop recordCost attribution ───────────────────────────────

describe("PR3b.1: per-hop cost attribution via recordCost", () => {
  it("ResearchDigest records one briefing inference_usage row, tagged with the current run id", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    vi.mocked(recordCost).mockResolvedValue(undefined);
    scriptedScores = [0.9, 0.9, 0.9, 0.9];

    const run = await execute(makeResearchAgent(), pipelineDeps());

    // v2 (docs/19+20, 2026-05-18): summarise() is a no-op, so only the
    // briefing call records cost. Score-only LLM calls still don't
    // record cost. Net: 1 recordCost call per non-empty run.
    expect(vi.mocked(recordCost)).toHaveBeenCalledTimes(1);

    for (const call of vi.mocked(recordCost).mock.calls) {
      const args = call[0];
      // The headline assertion: every cost row carries the run id.
      expect(args.agentRunId).toBe(run.id);
      // And the user_id + badge come straight from the agent row.
      expect(args.userId).toBe(USER);
      expect(args.badge).toBe("flash");
      // Cost unit is micro-USD, not dollars.
      expect(typeof args.costMicroUsd).toBe("number");
      expect(args.costMicroUsd).toBeGreaterThan(0);
      // Status, provider, tokens come from the generate() result.
      expect(args.status).toBe("ok");
      expect(args.providerUsed).toBe("groq");
      expect(args.modelUsed).toBe("llama-3.3-70b-versatile");
    }
  });

  it("aggregate cost on agent_runs still matches per-hop sum (no double-counting after PR3b.1)", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    vi.mocked(recordCost).mockResolvedValue(undefined);
    scriptedScores = [0.9, 0.9, 0.9, 0.9];

    const run = await execute(makeResearchAgent(), pipelineDeps());

    const totalMicro = vi
      .mocked(recordCost)
      .mock.calls.reduce((acc, [args]) => acc + args.costMicroUsd, 0);

    // agent_runs.cost_usd should equal the sum of per-hop micro costs,
    // converted to USD. PR3b.1 must not introduce double-counting: each
    // summarise returns the SAME microCost it just pushed to recordCost,
    // not double the amount. This test pins that.
    expect(run.cost_usd).toBeCloseTo(totalMicro / 1_000_000, 6);
  });

  it("recordCost failure does NOT crash the digest run (cap fail-open invariant)", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    // Make every recordCost call throw — simulates the worst-case
    // ledger-write outage. The run must still complete with findings
    // persisted; the cost just doesn't land in inference_usage.
    vi.mocked(recordCost).mockRejectedValue(
      new Error("simulated ledger outage 'with quoted PII'"),
    );
    scriptedScores = [0.9, 0.9, 0.9, 0.9];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const run = await execute(makeResearchAgent(), pipelineDeps());

    // The run completed successfully.
    expect(run.status).toBe("ok");
    expect(run.items_kept).toBe(4);
    expect(agentFindingsInserts).toHaveLength(4);

    // Cost still aggregated on the run row (the in-memory accumulator
    // is independent of the ledger write).
    expect(run.cost_usd).toBeGreaterThan(0);

    // Each recordCost throw was caught + logged + scrubbed.
    expect(consoleSpy).toHaveBeenCalled();
    const logCalls = consoleSpy.mock.calls;
    const sawScrubbedMessage = logCalls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          a.includes("research-digest") &&
          a.includes("recordCost"),
      ),
    );
    expect(sawScrubbedMessage).toBe(true);
    // The 'with quoted PII' substring should NEVER appear in any log —
    // the scrubber redacts quoted content before it hits stderr.
    const allLogText = logCalls
      .flat()
      .filter((a) => typeof a === "string")
      .join(" ");
    expect(allLogText).not.toMatch(/with quoted PII/);
    consoleSpy.mockRestore();
  });
});

// ─── Static invariant: no template-specific code in runner.ts / batch.ts ─
//
// History: PR3b shipped this as a byte-identity check against origin/main.
// That was the right shape FOR PR3b — proved ResearchDigest plugged in
// without any runner touch. PR3b.1 legitimately added a single
// context-shape field (`run.id` on TemplateCallContext) to enable per-hop
// cost attribution; the byte-identity check would now reject a valid
// generic extension.
//
// Replaced with grep-style assertions (same shape as the existing
// "Invariant #7" suite in tests/leak-suite/phase30-runner.test.ts). These
// fail if anyone adds template-id branching or imports from `templates/`
// to the runtime — the real architectural concern.

describe("Static invariant: no template-specific code in runtime files", () => {
  const repoRoot = join(__dirname, "..", "..");
  const FILES_TO_PIN = [
    "src/server/agents/runner.ts",
    "src/server/agents/batch.ts",
  ];

  for (const path of FILES_TO_PIN) {
    const src = readFileSync(join(repoRoot, path), "utf8");

    it(`${path} does not branch on agent.template_id`, () => {
      expect(src, `${path} contains a template_id === string-literal branch`).not.toMatch(
        /template_id\s*===\s*['"]/,
      );
      expect(src, `${path} contains a template_id == string-literal branch`).not.toMatch(
        /template_id\s*==\s*['"]/,
      );
      expect(
        src,
        `${path} contains a switch/case on a known template id`,
      ).not.toMatch(
        /case\s+['"](research_digest|job|shopping|deal_watcher)['"]/,
      );
    });

    it(`${path} does not import from any templates/ path`, () => {
      expect(src, `${path} imports from a templates/ subpath`).not.toMatch(
        /from\s+['"][^'"]*templates[\/'"]/,
      );
      expect(src, `${path} imports a /templates module`).not.toMatch(
        /from\s+['"][^'"]*\/templates['"]/,
      );
    });
  }
});

// ─── PR #19: search-provider failure diagnostics ──────────────────────────
//
// Pre-2026-05-18, a fully-dead SearXNG instance list looked identical
// to a legitimate empty-result day: run finished status='ok' with
// items_fetched=0 and no error trail. Verified during deploy
// verification when all four hardcoded public instances were
// returning 503/429/502/NXDOMAIN.
//
// The new contract on ResearchDigest.fetch:
//   * If at least one topic was served (any result OR ok-empty), keep
//     going and yield what we got. Per-topic provider errors are
//     diagnostic-only here; partial-success runs still finish ok.
//   * If EVERY topic failed at the provider layer AND nothing was
//     yielded, throw. The runner's outer catch turns that into
//     status='failed' with a scrubbed message, and the lifecycle
//     counter trips at 5 consecutive failures → state='degraded'.

describe("PR #19: ResearchDigest fetch surfaces search provider failures", () => {
  it("throws when every topic's providers fail (run becomes status='failed')", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    vi.mocked(runSearch).mockResolvedValue({
      provider: "searxng",
      results: [],
      instance: null,
      lastError: "HTTP 503",
    });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("failed");
    expect(run.items_fetched).toBe(0);
    expect(run.items_kept).toBe(0);
    // The scrubbed message is recorded so future debugging has a trail.
    expect(run.error).toMatch(/Search provider failed for all/);
    // Topic names should appear (they're config-supplied, not user
    // content from an external source — same trust level as
    // display_name and survive the scrubber).
    expect(run.error).toMatch(/AI safety/);
  });

  it("does NOT throw when search returned ok-empty (no provider errors, no hits)", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    vi.mocked(runSearch).mockResolvedValue({
      provider: "searxng",
      results: [],
      instance: null,
      lastError: null,
    });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    // Benign zero-yield day. status='ok' (no findings, no error).
    expect(run.status).toBe("ok");
    expect(run.items_fetched).toBe(0);
    expect(run.items_kept).toBe(0);
    expect(run.error).toBeNull();
  });

  it("yields partial results when some topics succeed and others fail (no throw)", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9]; // both kept

    // First topic ("AI safety") fails at the provider layer.
    // Second topic ("RLHF") succeeds with two hits.
    vi.mocked(runSearch)
      .mockResolvedValueOnce({
        provider: "searxng",
        results: [],
        instance: null,
        lastError: "HTTP 503",
      })
      .mockResolvedValueOnce({
        provider: "searxng",
        results: [
          {
            title: "RLHF article 1",
            url: "https://example.test/rlhf/1",
            snippet: "About RLHF",
            engine: "duckduckgo",
          },
          {
            title: "RLHF article 2",
            url: "https://example.test/rlhf/2",
            snippet: "More about RLHF",
            engine: "google",
          },
        ],
        instance: "https://test.searxng.example",
        lastError: null,
      });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    // Partial success: we yielded items from the second topic; the
    // first topic's error is swallowed silently (no throw).
    expect(run.status).toBe("ok");
    expect(run.items_fetched).toBeGreaterThan(0);
    expect(run.items_kept).toBeGreaterThan(0);
    expect(run.error).toBeNull();
  });
});

// ─── PR #19: env-driven SearXNG instance list ──────────────────────────────
//
// Public SearXNG instances are unreliable. Production deploys should
// set `SEARXNG_INSTANCES` env to a self-hosted or known-good list.
// Defaults remain as a best-effort fallback.

describe("PR #19: resolveSearxngInstances honors SEARXNG_INSTANCES env", () => {
  const ORIGINAL_ENV = process.env.SEARXNG_INSTANCES;

  beforeEach(() => {
    delete process.env.SEARXNG_INSTANCES;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SEARXNG_INSTANCES;
    } else {
      process.env.SEARXNG_INSTANCES = ORIGINAL_ENV;
    }
  });

  it("uses default instance list when env is unset", async () => {
    // Re-import after env reset — modules cache the env at first read,
    // but resolveSearxngInstances reads at call-time so this just works.
    const { resolveSearxngInstances } = await import("@/lib/search.functions");
    const instances = resolveSearxngInstances();
    expect(Array.isArray(instances)).toBe(true);
    expect(instances.length).toBeGreaterThan(0);
    // Every default is an https URL — sanity check we didn't ship junk.
    for (const url of instances) {
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it("uses default list when env is empty string", async () => {
    process.env.SEARXNG_INSTANCES = "";
    const { resolveSearxngInstances } = await import("@/lib/search.functions");
    expect(resolveSearxngInstances().length).toBeGreaterThan(0);
  });

  it("uses default list when env is only whitespace", async () => {
    process.env.SEARXNG_INSTANCES = "   ";
    const { resolveSearxngInstances } = await import("@/lib/search.functions");
    expect(resolveSearxngInstances().length).toBeGreaterThan(0);
  });

  it("overrides defaults with env-supplied comma-separated list", async () => {
    process.env.SEARXNG_INSTANCES = "https://one.example,https://two.example";
    const { resolveSearxngInstances } = await import("@/lib/search.functions");
    expect(resolveSearxngInstances()).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  it("trims whitespace and drops empty entries from the env list", async () => {
    process.env.SEARXNG_INSTANCES = "  https://one.example  ,, https://two.example  ,";
    const { resolveSearxngInstances } = await import("@/lib/search.functions");
    expect(resolveSearxngInstances()).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });
});

// ─── PR after #20: SearchProvider dispatcher (docs/18 decision) ───────────
//
// runSearch dispatches between Tavily (production default) and SearXNG
// (dev fallback) based on SEARCH_PROVIDER env. The mock in this file
// keeps runSearch / resolveSearchProvider REAL — only the per-provider
// impls are mocked — so these tests exercise the routing end-to-end.

describe("PR Tavily: resolveSearchProvider env routing", () => {
  const ORIG = process.env.SEARCH_PROVIDER;
  beforeEach(() => {
    delete process.env.SEARCH_PROVIDER;
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.SEARCH_PROVIDER;
    else process.env.SEARCH_PROVIDER = ORIG;
  });

  it("routes to tavily when SEARCH_PROVIDER=tavily", () => {
    process.env.SEARCH_PROVIDER = "tavily";
    expect(resolveSearchProvider()).toBe("tavily");
  });

  it("case-insensitive match on tavily (e.g. TAVILY)", () => {
    process.env.SEARCH_PROVIDER = "TAVILY";
    expect(resolveSearchProvider()).toBe("tavily");
  });

  it("trims whitespace around the env value", () => {
    process.env.SEARCH_PROVIDER = "  tavily  ";
    expect(resolveSearchProvider()).toBe("tavily");
  });

  it("falls back to searxng when env is unset", () => {
    expect(resolveSearchProvider()).toBe("searxng");
  });

  it("falls back to searxng when env is empty", () => {
    process.env.SEARCH_PROVIDER = "";
    expect(resolveSearchProvider()).toBe("searxng");
  });

  it("falls back to searxng when env is misspelled (defensive)", () => {
    // Rather a typo lands on the dev path than silently breaks the cron.
    process.env.SEARCH_PROVIDER = "taviily";
    expect(resolveSearchProvider()).toBe("searxng");
  });
});

// Note: a dedicated "runSearch dispatches to resolved provider" describe
// was attempted here but vi.mock can't remap intra-module direct calls
// (runSearch's body calls searxngSearch/tavilySearch via local bindings,
// not module exports). The dispatcher's 4-line branching reads
// transparently and is covered by:
//   - resolveSearchProvider() env-routing tests above (this file)
//   - tavilySearch impl tests (search-tavily-adapter.test.ts)
//   - searxngSearch behavior tests via the existing PR3b/PR #19 paths
// That's sufficient — testing the 4-line branch with mocks would add
// brittleness without adding signal.

describe("PR Tavily: ResearchDigest end-to-end via runSearch (provider-agnostic at the template layer)", () => {
  it("Tavily-shaped success: fetch yields normalized items, agent_findings.payload.instance='tavily'", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9, 0.9, 0.9];
    // Override runSearch to return Tavily-shaped responses for both topics.
    vi.mocked(runSearch)
      .mockResolvedValueOnce(tavilyHits("AI safety"))
      .mockResolvedValueOnce(tavilyHits("RLHF"));

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("ok");
    expect(run.items_fetched).toBeGreaterThan(0);
    expect(run.items_kept).toBeGreaterThan(0);
    expect(tavilyCalls).toEqual(["AI safety", "RLHF"]);

    // The findings the runner persisted carry Tavily as the instance.
    expect(agentFindingsInserts.length).toBeGreaterThan(0);
    const firstPayload = agentFindingsInserts[0].payload as { instance: string };
    expect(firstPayload.instance).toBe("tavily");
  });

  it("Tavily-shaped failure on every topic: throws → run becomes status='failed'", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    vi.mocked(runSearch).mockResolvedValue({
      provider: "tavily",
      results: [],
      instance: null,
      lastError: "Tavily HTTP 401",
    });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("failed");
    expect(run.items_fetched).toBe(0);
    expect(run.items_kept).toBe(0);
    expect(run.error).toMatch(/Search provider failed for all/);
    // The per-topic prefix on the lastError lets a reader see WHICH
    // provider failed without checking SEARCH_PROVIDER separately.
    expect(run.error).toMatch(/Tavily HTTP 401/);
  });

  it("Mixed: Tavily fails one topic, succeeds another → ok, partial results", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9];

    vi.mocked(runSearch)
      .mockResolvedValueOnce({
        provider: "tavily",
        results: [],
        instance: null,
        lastError: "Tavily HTTP 429",
      })
      .mockResolvedValueOnce({
        provider: "tavily",
        results: [
          {
            title: "RLHF article",
            url: "https://example.test/rlhf/1",
            snippet: "About RLHF",
          },
        ],
        instance: "tavily",
        lastError: null,
      });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("ok");
    expect(run.items_fetched).toBeGreaterThan(0);
    expect(run.items_kept).toBeGreaterThan(0);
    expect(run.error).toBeNull();
  });
});

// ─── ResearchDigest v2 (docs/19+20) ──────────────────────────────────────
//
// The v2 briefing-first architecture. Briefing becomes the product;
// per-source summarise is removed; cross-run continuity via prior-briefing
// fetch; visible failure briefings instead of silent fallback.
//
// These tests cover Examples A / B / D / E from docs/20 §8 (Example C
// is operational-verification only). The file-top vi.clearAllMocks()
// clears calls but not impls — beforeEach in this block resets generate
// and runSearch to file defaults so earlier overrides don't leak.

import { researchDigest as researchDigestV2Import } from "@/server/agents/templates/research-digest";
import { generate as generateImportV2 } from "@/server/inference";
import { runSearch as runSearchImportV2 } from "@/lib/search.functions";

describe("ResearchDigest v2: briefing-first output (docs/19+20)", () => {
  // Reset generate / runSearch impls to file defaults before each test —
  // PR3b / PR3b.1 / earlier blocks override these and the calls-only
  // clear in beforeEach at file top doesn't reach impls.
  beforeEach(() => {
    vi.mocked(generateImportV2).mockImplementation(async (req: any) => {
      generateCalls.push({ messages: req.messages, maxTokens: req.maxTokens });
      if (req.maxTokens && req.maxTokens <= 16) {
        const nextScore = scriptedScores.length > 0 ? scriptedScores.shift()! : 0.9;
        return {
          text: String(nextScore),
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          inputTokens: 80,
          outputTokens: 4,
        };
      }
      return {
        text: nextSummariseText,
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        inputTokens: 90,
        outputTokens: 60,
      };
    });
    vi.mocked(runSearchImportV2).mockImplementation(async (q: string) => {
      searxngCalls.push(q);
      return {
        provider: "searxng" as const,
        instance: "https://test.searxng.example",
        lastError: null,
        results: [
          {
            title: `${q} — article 1`,
            url: `https://example.test/${encodeURIComponent(q)}/1`,
            snippet: `Snippet about ${q}`,
            engine: "duckduckgo",
          },
          {
            title: `${q} — article 2`,
            url: `https://example.test/${encodeURIComponent(q)}/2?utm_source=test&id=keep`,
            snippet: `Another snippet about ${q}`,
            engine: "google",
          },
        ],
      };
    });
    vi.mocked(recordCost).mockResolvedValue(undefined);
  });

  /**
   * Example A — first-run happy path.
   * Four sources, no prior briefing in DB. LLM returns valid v2 JSON.
   * Expected: briefing persisted with version=2, kind=research, no delta
   * (first run), all items provenance='new'.
   */
  it("Example A: first-run, valid LLM output → v2 briefing persisted with delta omitted", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.95, 0.85, 0.75, 0.6];

    const sourceKeys = [
      "https://example.test/AI%20safety/1",
      "https://example.test/AI%20safety/2?id=keep",
      "https://example.test/RLHF/1",
      "https://example.test/RLHF/2?id=keep",
    ];

    vi.mocked(generateImportV2).mockImplementation(async (req: any) => {
      generateCalls.push({ messages: req.messages, maxTokens: req.maxTokens });
      if (req.maxTokens && req.maxTokens >= 400) {
        return {
          text: JSON.stringify({
            version: 2,
            kind: "research",
            headline: "Today's batch covered four AI-safety pieces; two are worth your time.",
            synthesis:
              "From this batch, two sources stood out on safety methodology. The other two repeat introductory material.",
            memorableTakeaways: [
              {
                text: "Methodology specifics are emerging from two of these sources.",
                supportSourceKeys: [sourceKeys[0], sourceKeys[2]],
                provenance: "new",
              },
              {
                text: "Two of the four pieces are introductory restatements.",
                supportSourceKeys: [sourceKeys[1], sourceKeys[3]],
                provenance: "new",
              },
            ],
            readFirst: [
              {
                sourceKey: sourceKeys[0],
                reason: "Strongest methodology in the batch.",
                provenance: "new",
              },
            ],
            skipOrCollapse: [
              {
                reason: "Restates the basic definition.",
                sourceKeys: [sourceKeys[1], sourceKeys[3]],
              },
            ],
            distinctIdeas: [],
            nextSearchSuggestions: ["Recent red-team results on frontier models"],
          }),
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          inputTokens: 600,
          outputTokens: 300,
        };
      }
      // Score branch.
      const nextScore = scriptedScores.length > 0 ? scriptedScores.shift()! : 0.9;
      return {
        text: String(nextScore),
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        inputTokens: 80,
        outputTokens: 4,
      };
    });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("ok");
    expect(run.items_kept).toBe(4);

    const runRow = agentRunsRows[0];
    expect(runRow.briefing).toBeDefined();
    expect(runRow.briefing).not.toBeNull();
    const b = runRow.briefing as Record<string, unknown>;
    expect(b.version).toBe(2);
    expect(b.kind).toBe("research");
    expect(b.headline).toMatch(/AI-safety/i);
    expect(typeof b.synthesis).toBe("string");
    // First-run: delta omitted (no prior briefing existed).
    expect(b.delta).toBeUndefined();
    // All takeaways tagged 'new' on first run.
    const takeaways = b.memorableTakeaways as Array<{ provenance: string }>;
    expect(takeaways.length).toBeGreaterThan(0);
    for (const t of takeaways) expect(t.provenance).toBe("new");
    // readFirst populated.
    const readFirst = b.readFirst as Array<{ sourceKey: string; provenance: string }>;
    expect(readFirst.length).toBeGreaterThan(0);
    expect(readFirst[0].provenance).toBe("new");
  });

  /**
   * Example B — cross-run continuity (briefing-as-delta).
   * A prior v2 briefing exists for this agent in agent_runs. The current
   * run's briefing should fetch it, include it in the prompt, and the
   * LLM output includes a delta + at least one 'continuing' provenance.
   */
  it("Example B: cross-run continuity → fetches prior briefing, delta populated", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9, 0.9, 0.9];

    // Seed a prior v2 briefing row for this agent. Inserted directly into
    // the mock's agentRunsRows so fetchPriorBriefingV2's select chain
    // returns it.
    agentRunsRows.push({
      id: "prior-run-id",
      agent_id: AGENT_ID,
      user_id: USER,
      started_at: new Date("2026-05-17T12:00:00Z").toISOString(),
      briefing: {
        version: 2,
        kind: "research",
        headline: "Last week was all explainer content.",
        synthesis: "Sources defined red teaming; nothing new methodologically.",
        memorableTakeaways: [
          {
            text: "Red teaming = simulated adversarial testing of LLMs.",
            supportSourceKeys: ["prior-key-1"],
            provenance: "new",
          },
        ],
        readFirst: [],
        skipOrCollapse: [],
        distinctIdeas: [],
        nextSearchSuggestions: [],
      },
    });

    let priorIncludedInPrompt = false;
    vi.mocked(generateImportV2).mockImplementation(async (req: any) => {
      generateCalls.push({ messages: req.messages, maxTokens: req.maxTokens });
      if (req.maxTokens && req.maxTokens >= 400) {
        // Verify the prior briefing was included in the prompt.
        const userMsg = (req.messages ?? []).find(
          (m: { role: string; content: string }) => m.role === "user",
        );
        if (userMsg && /Last week was all explainer content/.test(userMsg.content)) {
          priorIncludedInPrompt = true;
        }
        const sourceKeys = [
          "https://example.test/AI%20safety/1",
          "https://example.test/AI%20safety/2?id=keep",
          "https://example.test/RLHF/1",
          "https://example.test/RLHF/2?id=keep",
        ];
        return {
          text: JSON.stringify({
            version: 2,
            kind: "research",
            headline: "Two new methodology pieces appeared since last week.",
            synthesis: "Continuing the explainer trend, but two new pieces add methodology specifics.",
            delta: {
              whatsNew: "Two new methodology pieces appeared this week.",
              whatsContinuing: "Sources are still predominantly explainer-level.",
            },
            memorableTakeaways: [
              {
                text: "Red teaming = simulated adversarial testing.",
                supportSourceKeys: [sourceKeys[0]],
                provenance: "continuing",
              },
              {
                text: "Two new methodology pieces detail attack vectors.",
                supportSourceKeys: [sourceKeys[2], sourceKeys[3]],
                provenance: "new",
              },
            ],
            readFirst: [
              {
                sourceKey: sourceKeys[2],
                reason: "Genuinely new methodology content.",
                provenance: "new",
              },
            ],
            skipOrCollapse: [],
            distinctIdeas: [],
            nextSearchSuggestions: [],
          }),
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          inputTokens: 800,
          outputTokens: 350,
        };
      }
      const nextScore = scriptedScores.length > 0 ? scriptedScores.shift()! : 0.9;
      return {
        text: String(nextScore),
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        inputTokens: 80,
        outputTokens: 4,
      };
    });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("ok");

    // Prior briefing made it into the prompt.
    expect(priorIncludedInPrompt).toBe(true);

    // New run's briefing has delta populated and mixed provenance.
    const newRunRow = agentRunsRows.find((r) => r.id !== "prior-run-id");
    expect(newRunRow).toBeDefined();
    const b = newRunRow!.briefing as Record<string, unknown>;
    expect(b.version).toBe(2);
    expect(b.delta).toBeDefined();
    expect((b.delta as { whatsNew?: string }).whatsNew).toMatch(/methodology/i);
    const takeaways = b.memorableTakeaways as Array<{ provenance: string }>;
    const provenances = new Set(takeaways.map((t) => t.provenance));
    expect(provenances.has("continuing")).toBe(true);
    expect(provenances.has("new")).toBe(true);
  });

  /**
   * Example D — items_kept === 0 (empty-batch briefing).
   * All sources scored below minScore. No LLM call for briefing; the
   * template short-circuits and persists the locked empty-batch copy.
   */
  it("Example D: items_kept=0 → empty-batch briefing persisted, no briefing LLM call", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.1, 0.1, 0.1, 0.1]; // all below 0.5 floor

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("ok");
    expect(run.items_kept).toBe(0);

    const runRow = agentRunsRows[0];
    expect(runRow.briefing).toBeDefined();
    expect(runRow.briefing).not.toBeNull();
    const b = runRow.briefing as Record<string, unknown>;
    expect(b.version).toBe(2);
    expect(b.kind).toBe("research");
    expect(b.headline).toMatch(/nothing worth keeping/i);
    expect(b.synthesis).toMatch(/narrowing the topic|changing the search angle/i);
    expect(b.memorableTakeaways).toEqual([]);
    expect(b.readFirst).toEqual([]);

    // No briefing LLM call — only score calls were made.
    const briefingCallCount = generateCalls.filter(
      (c) => (c.maxTokens ?? 0) >= 400,
    ).length;
    expect(briefingCallCount).toBe(0);
  });

  /**
   * Example E — visible failure briefing on chain-exhausted.
   * Briefing LLM throws (with one retry). Failure briefing persisted with
   * human-voice copy. Run still finishes status='ok' (briefing failure
   * does NOT fail the run per docs/19 §3).
   */
  it("Example E: LLM chain exhausted → human-voice failure briefing persisted", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9, 0.9, 0.9];

    vi.mocked(generateImportV2).mockImplementation(async (req: any) => {
      generateCalls.push({ messages: req.messages, maxTokens: req.maxTokens });
      if (req.maxTokens && req.maxTokens >= 400) {
        // Briefing call throws every attempt — both the initial and
        // the retry.
        throw Object.assign(new Error("simulated chain exhausted"), {
          errorClass: "chain_exhausted",
        });
      }
      const nextScore = scriptedScores.length > 0 ? scriptedScores.shift()! : 0.9;
      return {
        text: String(nextScore),
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        inputTokens: 80,
        outputTokens: 4,
      };
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const run = await execute(makeResearchAgent(), pipelineDeps());

    // Run still completes ok — briefing failure doesn't fail the run.
    expect(run.status).toBe("ok");
    expect(run.items_kept).toBe(4);

    const runRow = agentRunsRows[0];
    expect(runRow.briefing).toBeDefined();
    const b = runRow.briefing as Record<string, unknown>;
    expect(b.version).toBe(2);
    expect(b.kind).toBe("research");
    // Human-voice copy from FAILURE_COPY.chain_exhausted. No HTTP codes,
    // no "errorClass" leakage. Per docs/19 §10.4.
    expect(b.headline).toMatch(/couldn'?t complete this check/i);
    expect(b.headline).toMatch(/LLM providers were available/i);
    expect(b.headline).not.toMatch(/\b429\b|HTTP|chain_exhausted/i);
    expect(b.synthesis).not.toMatch(/\b429\b|HTTP|errorClass/i);
    // Failure briefings have empty content arrays.
    expect(b.memorableTakeaways).toEqual([]);
    expect(b.readFirst).toEqual([]);
    // No qualityNote on failure (per docs/20 §6).
    expect(b.qualityNote).toBeUndefined();

    consoleSpy.mockRestore();
  });

  /**
   * Negative test: invalid sourceKey references are stripped, not fatal.
   * LLM hallucinates a sourceKey that doesn't exist among the kept items.
   * Briefing strips that reference but still persists the rest of the
   * valid content (rather than treating as malformed).
   */
  it("invalid sourceKeys are stripped; surviving content persists", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    scriptedScores = [0.9, 0.9, 0.9, 0.9];

    const validKey = "https://example.test/AI%20safety/1";

    vi.mocked(generateImportV2).mockImplementation(async (req: any) => {
      generateCalls.push({ messages: req.messages, maxTokens: req.maxTokens });
      if (req.maxTokens && req.maxTokens >= 400) {
        return {
          text: JSON.stringify({
            version: 2,
            kind: "research",
            headline: "Test briefing with mixed valid/invalid keys.",
            synthesis: "From this batch I kept four items.",
            memorableTakeaways: [
              {
                text: "Valid takeaway.",
                supportSourceKeys: [validKey, "hallucinated-key-not-in-batch"],
                provenance: "new",
              },
              {
                text: "Takeaway with only hallucinated support.",
                supportSourceKeys: ["another-hallucinated-key"],
                provenance: "new",
              },
            ],
            readFirst: [
              { sourceKey: validKey, reason: "valid pick", provenance: "new" },
              {
                sourceKey: "totally-fake-key",
                reason: "should be stripped",
                provenance: "new",
              },
            ],
            skipOrCollapse: [],
            distinctIdeas: [],
            nextSearchSuggestions: [],
          }),
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          inputTokens: 600,
          outputTokens: 200,
        };
      }
      const nextScore = scriptedScores.length > 0 ? scriptedScores.shift()! : 0.9;
      return {
        text: String(nextScore),
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        inputTokens: 80,
        outputTokens: 4,
      };
    });

    const run = await execute(makeResearchAgent(), pipelineDeps());

    expect(run.status).toBe("ok");
    const b = agentRunsRows[0].briefing as Record<string, unknown>;
    // First takeaway: keeps only the valid sourceKey.
    const takeaways = b.memorableTakeaways as Array<{
      text: string;
      supportSourceKeys: string[];
    }>;
    expect(takeaways).toHaveLength(1);
    expect(takeaways[0].text).toBe("Valid takeaway.");
    expect(takeaways[0].supportSourceKeys).toEqual([validKey]);
    // readFirst: only the valid pick survives.
    const readFirst = b.readFirst as Array<{ sourceKey: string }>;
    expect(readFirst).toHaveLength(1);
    expect(readFirst[0].sourceKey).toBe(validKey);
  });
});
