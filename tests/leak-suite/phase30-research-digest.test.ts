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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

// Mock SearXNG search — capture calls + return canned hits.
let searxngCalls: string[] = [];
vi.mock("@/lib/search.functions", () => ({
  searxngSearch: vi.fn(async (q: string) => {
    searxngCalls.push(q);
    return {
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
}));

// Mock the inference dispatcher — capture call args + return scripted text.
let generateCalls: Array<{ messages: unknown; maxTokens?: number }> = [];
let scriptedScores: number[] = [];
let nextSummariseText = "Two-sentence summary about the topic. It mentions things.";
vi.mock("@/server/inference", () => ({
  generate: vi.fn(async (req: any) => {
    generateCalls.push({ messages: req.messages, maxTokens: req.maxTokens });
    // Distinguish score (maxTokens=8) from summarise (maxTokens=120) calls.
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
import { checkBudget } from "@/server/agents/budget";
import type { AgentRow, BrokerContext } from "@/server/agents/types";

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
    expect(run.llm_hops).toBe(4); // 4 summarise calls
    // Cost: 4 summarise calls; each per pricing.ts at ~groq rates.
    // Just verify it's positive and reasonable (< $0.01 for 4 small calls).
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(run.cost_usd).toBeLessThan(0.01);

    // SearXNG was called once per topic.
    expect(searxngCalls).toEqual(["AI safety", "RLHF"]);
    // generate() was called: 4× score + 4× summarise = 8 times total.
    expect(generateCalls).toHaveLength(8);

    // Findings persisted with the right shape.
    expect(agentFindingsInserts).toHaveLength(4);
    const f = agentFindingsInserts[0];
    expect(f.title).toMatch(/article 1/);
    expect(f.summary).toBe(nextSummariseText);
    expect((f.payload as { url: string }).url).toMatch(/example\.test/);
    expect((f.payload as { matched_topic: string }).matched_topic).toBe("AI safety");
    expect((f.payload as { provider: string }).provider).toBe("groq");
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

// ─── Static invariant: runner.ts + batch.ts unchanged in PR3b ────────────

describe("PR3b static invariant: no runner.ts or batch.ts changes", () => {
  // The test passes if these files match what's on main. If a PR3b commit
  // accidentally edited the runner to accommodate ResearchDigest, this
  // fails — which is the exact signal that the abstraction broke.
  //
  // We compare against `origin/main` to avoid drift from local commits
  // accumulating during PR3b development. Skip if main isn't available
  // (sandbox runs, clean checkouts, etc.).
  const repoRoot = join(__dirname, "..", "..");
  const FILES_TO_PIN = [
    "src/server/agents/runner.ts",
    "src/server/agents/batch.ts",
  ];

  let mainAvailable = true;
  try {
    execSync("git rev-parse origin/main", { cwd: repoRoot, stdio: "pipe" });
  } catch {
    mainAvailable = false;
  }

  for (const path of FILES_TO_PIN) {
    (mainAvailable ? it : it.skip)(
      `${path} is byte-identical to origin/main`,
      () => {
        const current = readFileSync(join(repoRoot, path), "utf8");
        const onMain = execSync(`git show origin/main:${path}`, {
          cwd: repoRoot,
          encoding: "utf8",
        });
        if (current !== onMain) {
          throw new Error(
            `${path} has diverged from origin/main during PR3b.\n` +
              `PR3b's invariant pass-condition is that ResearchDigest can run ` +
              `through the runner with ZERO runner changes. If you changed ` +
              `${path} to accommodate ResearchDigest, the abstraction is wrong — ` +
              `fix the AgentTemplate contract instead of the runner.`,
          );
        }
      },
    );
  }
});
