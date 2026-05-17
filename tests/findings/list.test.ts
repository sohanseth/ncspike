/**
 * Phase 3.0 product surface — `listFindingsFor` tests.
 *
 * Pin the contract the inbox UI depends on:
 *   - returns only the current user's findings (RLS is the safety net;
 *     the explicit user_id filter is the load-bearing guard since the
 *     admin client bypasses RLS)
 *   - excludes 'archived' state (future-proofing for 3.1's dismiss UX)
 *   - orders newest first
 *   - honors limit (default 50, max 200)
 *   - honors sinceDays filter
 *   - flattens the joined agents.display_name into agent_display_name
 *   - scrubs supabase error envelopes before re-throw
 *
 * Tests target the pure handler `listFindingsFor(userId, raw)`. The
 * server-fn shim is a thin wrapper that mirrors the handler-pair
 * pattern used in agents.functions.ts.
 *
 * Mock strategy: in-memory `findings_rows` with a query builder that
 * supports .select(), .eq(), .neq(), .gte(), .order(), .limit() —
 * enough to exercise every WHERE/ORDER/LIMIT the handler emits. The
 * builder also models the joined `agents:agent_id(display_name)`
 * embedding by looking up display_name from a parallel `agents_rows`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type FindingRow = {
  id: string;
  agent_id: string;
  user_id: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  score: number;
  urgency: string;
  state: string;
  created_at: string;
};

type AgentRow = { id: string; display_name: string; state?: string };

let findings_rows: FindingRow[] = [];
let agents_rows: AgentRow[] = [];
let nextError: { message: string } | null = null;

beforeEach(() => {
  findings_rows = [];
  agents_rows = [];
  nextError = null;
});

function makeBuilder(table: string) {
  if (table !== "agent_findings") {
    throw new Error(`unexpected table: ${table}`);
  }

  type Filter =
    | { kind: "eq"; col: string; val: unknown }
    | { kind: "neq"; col: string; val: unknown }
    | { kind: "gte"; col: string; val: string };

  const filters: Filter[] = [];
  let selectExpr = "";
  let orderCol: string | null = null;
  let orderAsc = true;
  let limitN: number | null = null;

  function getCol(r: FindingRow, col: string): unknown {
    // Support dotted-column filters that reference the joined table,
    // e.g. `.neq("agents.state", "archived")` — read from the parent
    // agents row. The handler uses this to filter findings by parent
    // agent state via the `agents!inner` embed.
    if (col.startsWith("agents.")) {
      const subCol = col.slice("agents.".length);
      const a = agents_rows.find((x) => x.id === r.agent_id);
      return a ? (a as unknown as Record<string, unknown>)[subCol] : undefined;
    }
    return (r as unknown as Record<string, unknown>)[col];
  }

  function apply(): FindingRow[] {
    const isInner = /agents!inner\s*\(/.test(selectExpr);
    let out = findings_rows.filter((r) => {
      // For inner joins, a missing parent agent excludes the finding
      // entirely — same semantics as SQL INNER JOIN.
      if (isInner && !agents_rows.find((x) => x.id === r.agent_id)) {
        return false;
      }
      return filters.every((f) => {
        const v = getCol(r, f.col);
        if (f.kind === "eq") return v === f.val;
        if (f.kind === "neq") return v !== f.val;
        if (f.kind === "gte") return typeof v === "string" && v >= f.val;
        return false;
      });
    });
    if (orderCol) {
      out = [...out].sort((a, b) => {
        const av = (a as unknown as Record<string, string>)[orderCol!];
        const bv = (b as unknown as Record<string, string>)[orderCol!];
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (orderAsc ? 1 : -1);
      });
    }
    if (limitN !== null) out = out.slice(0, limitN);
    return out;
  }

  function finalize(): { data: unknown; error: unknown } {
    if (nextError) return { data: null, error: nextError };
    const matched = apply();
    // If the select expression embeds agents (left embed `agents:agent_id(...)`
    // OR inner `agents!inner(...)`), synthesize the join column. The
    // handler's mapper reads `r.agents?.display_name` and flattens it.
    const embedsAgents = /agents(?:!inner)?(?::\w+)?\s*\(/.test(selectExpr);
    const data = matched.map((r) => {
      const base = { ...r } as Record<string, unknown>;
      if (embedsAgents) {
        const a = agents_rows.find((x) => x.id === r.agent_id);
        // For inner joins, apply() already filtered out rows without a
        // parent, so `a` is always defined here. For left embeds, fall
        // back to null (mirrors PostgREST behavior).
        base.agents = a ? { display_name: a.display_name } : null;
      }
      return base;
    });
    return { data, error: null };
  }

  const builder = {
    select(expr: string) {
      selectExpr = expr;
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push({ kind: "eq", col, val });
      return builder;
    },
    neq(col: string, val: unknown) {
      filters.push({ kind: "neq", col, val });
      return builder;
    },
    gte(col: string, val: string) {
      filters.push({ kind: "gte", col, val });
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return builder;
    },
    limit(n: number) {
      limitN = n;
      return builder;
    },
    then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown) {
      return Promise.resolve(finalize()).then(onFulfilled);
    },
  };

  return builder as any;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => makeBuilder(table),
  },
}));

import { listFindingsFor } from "@/lib/findings.functions.server";

const USER_A = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const USER_B = "22222222-2222-2222-2222-bbbbbbbbbbbb";
const AGENT_1 = "33333333-3333-3333-3333-aaaaaaaaaaaa";
const AGENT_2 = "44444444-4444-4444-4444-aaaaaaaaaaaa";
const AGENT_OTHER = "55555555-5555-5555-5555-bbbbbbbbbbbb";

function seedRows() {
  agents_rows.push(
    { id: AGENT_1, display_name: "AI digest", state: "active" },
    { id: AGENT_2, display_name: "Climate digest", state: "active" },
    { id: AGENT_OTHER, display_name: "Other user's agent", state: "active" },
  );
  findings_rows.push(
    // USER_A · AGENT_1 · newest
    {
      id: "f1",
      agent_id: AGENT_1,
      user_id: USER_A,
      title: "Llama 4 announced",
      summary: "Meta released ...",
      source_url: "https://example.com/llama4",
      score: 0.95,
      urgency: "normal",
      state: "new",
      created_at: "2026-05-18T10:00:00Z",
    },
    // USER_A · AGENT_2 · middle
    {
      id: "f2",
      agent_id: AGENT_2,
      user_id: USER_A,
      title: "Heatwave forecast",
      summary: null,
      source_url: null,
      score: 0.78,
      urgency: "urgent",
      state: "new",
      created_at: "2026-05-17T08:00:00Z",
    },
    // USER_A · AGENT_1 · older
    {
      id: "f3",
      agent_id: AGENT_1,
      user_id: USER_A,
      title: "Yesterday's AI news",
      summary: "Yesterday ...",
      source_url: "https://example.com/yest",
      score: 0.81,
      urgency: "normal",
      state: "new",
      created_at: "2026-05-17T07:00:00Z",
    },
    // USER_A · archived (should be filtered out)
    {
      id: "f4_archived",
      agent_id: AGENT_1,
      user_id: USER_A,
      title: "Old dismissed thing",
      summary: null,
      source_url: null,
      score: 0.5,
      urgency: "normal",
      state: "archived",
      created_at: "2026-04-01T00:00:00Z",
    },
    // USER_B · finding (should NOT appear for USER_A)
    {
      id: "f5_other_user",
      agent_id: AGENT_OTHER,
      user_id: USER_B,
      title: "Not yours",
      summary: "Cross-user leak check",
      source_url: null,
      score: 0.9,
      urgency: "normal",
      state: "new",
      created_at: "2026-05-18T11:00:00Z",
    },
  );
}

// ─── Owner scoping ────────────────────────────────────────────────────────

describe("listFindingsFor — only current user's findings", () => {
  beforeEach(seedRows);

  it("returns only USER_A's findings (no USER_B leak)", async () => {
    const out = await listFindingsFor(USER_A, {});
    const ids = out.map((r) => r.id);
    expect(ids).toContain("f1");
    expect(ids).toContain("f2");
    expect(ids).toContain("f3");
    expect(ids).not.toContain("f5_other_user");
  });

  it("returns USER_B's only own row for USER_B", async () => {
    const out = await listFindingsFor(USER_B, {});
    expect(out.map((r) => r.id)).toEqual(["f5_other_user"]);
  });

  it("returns [] for a user with no findings", async () => {
    const out = await listFindingsFor("99999999-9999-9999-9999-999999999999", {});
    expect(out).toEqual([]);
  });
});

// ─── State filter ─────────────────────────────────────────────────────────

describe("listFindingsFor — excludes archived state", () => {
  beforeEach(seedRows);

  it("'archived' findings are filtered out by default", async () => {
    const out = await listFindingsFor(USER_A, {});
    expect(out.map((r) => r.id)).not.toContain("f4_archived");
  });
});

// ─── Sort ─────────────────────────────────────────────────────────────────

describe("listFindingsFor — sort newest first", () => {
  beforeEach(seedRows);

  it("orders by created_at descending", async () => {
    const out = await listFindingsFor(USER_A, {});
    expect(out.map((r) => r.id)).toEqual(["f1", "f2", "f3"]);
  });
});

// ─── Joined agent display name ────────────────────────────────────────────

describe("listFindingsFor — embeds agent display_name", () => {
  beforeEach(seedRows);

  it("flattens agents.display_name into agent_display_name", async () => {
    const out = await listFindingsFor(USER_A, {});
    const f1 = out.find((r) => r.id === "f1");
    const f2 = out.find((r) => r.id === "f2");
    expect(f1?.agent_display_name).toBe("AI digest");
    expect(f2?.agent_display_name).toBe("Climate digest");
  });

  it("excludes findings whose parent agent row is missing (inner-join semantics)", async () => {
    // With agents!inner(...), a missing parent removes the finding from
    // the result entirely — same as SQL INNER JOIN. The defensive
    // `(unknown agent)` fallback in the mapper is now unreachable in
    // production (on delete cascade + inner join close every gap), but
    // we keep it as belt-and-suspenders.
    agents_rows = agents_rows.filter((a) => a.id !== AGENT_1);
    const out = await listFindingsFor(USER_A, {});
    expect(out.find((r) => r.id === "f1")).toBeUndefined();
    expect(out.find((r) => r.id === "f3")).toBeUndefined();
    // f2 (AGENT_2 still present) survives.
    expect(out.find((r) => r.id === "f2")).toBeDefined();
  });
});

// ─── Archived-agent filter (PR-14 review hardening) ───────────────────────

describe("listFindingsFor — excludes findings for archived agents", () => {
  beforeEach(seedRows);

  it("a finding produced by an agent the user later archived is hidden from the inbox", async () => {
    // Sneha's PR-14 review concern: previous query used a left embed +
    // filter on `agent_findings.state`, which let findings for an
    // archived agent leak through (their finding-state is still 'new').
    // With agents!inner(...) + .neq('agents.state', 'archived'), the
    // archived agent is excluded by the query itself.
    const archivedAgent = agents_rows.find((a) => a.id === AGENT_1)!;
    archivedAgent.state = "archived";

    const out = await listFindingsFor(USER_A, {});
    // f1 and f3 both belong to AGENT_1 → must NOT appear.
    expect(out.find((r) => r.id === "f1")).toBeUndefined();
    expect(out.find((r) => r.id === "f3")).toBeUndefined();
    // f2 (AGENT_2 still active) remains.
    expect(out.map((r) => r.id)).toEqual(["f2"]);
  });

  it("paused agents still surface their findings (only archive hides)", async () => {
    // Pause intent is "stop future runs, keep past findings visible".
    const pausedAgent = agents_rows.find((a) => a.id === AGENT_1)!;
    pausedAgent.state = "paused";

    const out = await listFindingsFor(USER_A, {});
    expect(out.find((r) => r.id === "f1")).toBeDefined();
    expect(out.find((r) => r.id === "f3")).toBeDefined();
  });

  it("degraded/inactive/error agents still surface their findings", async () => {
    // Only the user-initiated 'archived' state hides past findings.
    const ag1 = agents_rows.find((a) => a.id === AGENT_1)!;
    ag1.state = "degraded";
    const out1 = await listFindingsFor(USER_A, {});
    expect(out1.find((r) => r.id === "f1")).toBeDefined();

    ag1.state = "error";
    const out2 = await listFindingsFor(USER_A, {});
    expect(out2.find((r) => r.id === "f1")).toBeDefined();
  });
});

// ─── Field mapping ────────────────────────────────────────────────────────

describe("listFindingsFor — maps DB fields to FindingItem shape", () => {
  beforeEach(seedRows);

  it("includes all UI-required fields, omits internal ones", async () => {
    const out = await listFindingsFor(USER_A, {});
    const f1 = out.find((r) => r.id === "f1")!;
    expect(f1).toEqual({
      id: "f1",
      agent_id: AGENT_1,
      agent_display_name: "AI digest",
      title: "Llama 4 announced",
      summary: "Meta released ...",
      source_url: "https://example.com/llama4",
      score: 0.95,
      urgency: "normal",
      state: "new",
      created_at: "2026-05-18T10:00:00Z",
    });
    // Internal fields not surfaced:
    expect(f1).not.toHaveProperty("run_id");
    expect(f1).not.toHaveProperty("dedupe_key");
    expect(f1).not.toHaveProperty("payload");
    expect(f1).not.toHaveProperty("user_id");
  });

  it("coerces score to a number (Supabase returns numeric as string in some clients)", async () => {
    findings_rows[0].score = "0.95" as unknown as number;
    const out = await listFindingsFor(USER_A, {});
    expect(out[0].score).toBe(0.95);
    expect(typeof out[0].score).toBe("number");
  });
});

// ─── Limit ────────────────────────────────────────────────────────────────

describe("listFindingsFor — limit", () => {
  beforeEach(seedRows);

  it("respects an explicit limit", async () => {
    const out = await listFindingsFor(USER_A, { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(["f1", "f2"]);
  });

  it("rejects limit > MAX_LIMIT (200)", async () => {
    await expect(listFindingsFor(USER_A, { limit: 1000 })).rejects.toThrow();
  });

  it("rejects limit < 1", async () => {
    await expect(listFindingsFor(USER_A, { limit: 0 })).rejects.toThrow();
  });

  it("default limit is applied when not provided", async () => {
    // 3 visible rows < default 50; just verify the call doesn't fail
    // and returns all 3.
    const out = await listFindingsFor(USER_A, {});
    expect(out).toHaveLength(3);
  });
});

// ─── sinceDays filter ─────────────────────────────────────────────────────

describe("listFindingsFor — sinceDays", () => {
  beforeEach(() => {
    seedRows();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T12:00:00Z"));
  });

  it("filters to findings newer than N days ago", async () => {
    // sinceDays=1 → cutoff = 2026-05-17T12:00:00Z. Only f1 qualifies.
    const out = await listFindingsFor(USER_A, { sinceDays: 1 });
    expect(out.map((r) => r.id)).toEqual(["f1"]);
  });

  it("rejects sinceDays > 365", async () => {
    await expect(
      listFindingsFor(USER_A, { sinceDays: 400 }),
    ).rejects.toThrow();
  });

  it("rejects sinceDays < 1", async () => {
    await expect(listFindingsFor(USER_A, { sinceDays: 0 })).rejects.toThrow();
  });
});

// ─── Error scrubbing ──────────────────────────────────────────────────────

describe("listFindingsFor — scrubs supabase error envelopes", () => {
  beforeEach(seedRows);

  it("scrubs error.message before re-throwing", async () => {
    nextError = {
      message: "syntax error near 'select * from secret-table-user@example.com'",
    };
    await expect(listFindingsFor(USER_A, {})).rejects.toMatchObject({
      message: expect.stringMatching(/^Findings list failed: /),
    });
    try {
      await listFindingsFor(USER_A, {});
    } catch (e) {
      const msg = (e as Error).message;
      // Scrubber strips quoted spans + emails.
      expect(msg).not.toMatch(/secret-table-user@example\.com/);
      expect(msg).not.toMatch(/'select \* from/);
    }
  });
});
