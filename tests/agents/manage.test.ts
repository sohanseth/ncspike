/**
 * Phase 3.0 product surface — list / pause / resume / archive.
 *
 * Acceptance criteria from the PR spec:
 *   1. User sees only their own agents
 *   2. Active → paused prevents future claims (state transition lands)
 *   3. Paused → active makes it eligible again
 *   4. Archived agents are hidden from default list
 *   5. Archive is NOT hard delete (row stays in table)
 *   6. No changes to runner/batch/cron/templates/budget (asserted by the
 *      existing static invariant in `tests/agents/create.test.ts`).
 *
 * Tests target the pure handlers `*For(userId, raw)` — the auth-wrapped
 * server fns are thin shims that mirror the gdpr.functions.ts pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── In-memory supabase mock ───────────────────────────────────────────────
//
// Models just enough of the supabase chain to verify:
//   - .select / .update / .insert / .delete carry the .eq('user_id', X)
//     filter every time (auth scoping invariant)
//   - .neq, .in apply the expected state-transition guards
//   - .order is honored on list
//   - rows that don't match the WHERE simply don't appear in `.select(...)`'s
//     return — same behavior as Postgres
//
// The mock holds a single `rows` array (the `agents` table). Each query
// builder captures filters, applies them in `_apply`, and returns the
// matching subset (for select) or mutates + returns the changed rows
// (for update).

type Row = {
  id: string;
  user_id: string;
  template_id: string;
  display_name: string;
  state: string;
  cadence_hours: number;
  last_completed_at: string | null;
  created_at: string;
  claim_expires_at?: string | null;
};

let rows: Row[] = [];
let nextError: { message: string } | null = null;

beforeEach(() => {
  rows = [];
  nextError = null;
});

function makeBuilder(table: string) {
  if (table !== "agents") throw new Error(`unexpected table: ${table}`);

  type Filter =
    | { kind: "eq"; col: string; val: unknown }
    | { kind: "neq"; col: string; val: unknown }
    | { kind: "in"; col: string; vals: unknown[] }
    | { kind: "or"; predicates: OrPredicate[] };

  type OrPredicate =
    | { col: string; op: "is.null" }
    | { col: string; op: "lt"; val: string };

  const filters: Filter[] = [];
  let op: "select" | "update" | null = null;
  let updatePatch: Partial<Row> | null = null;
  let orderCol: string | null = null;
  let orderAsc = true;

  function apply(): Row[] {
    return rows.filter((r) =>
      filters.every((f) => {
        if (f.kind === "or") {
          return f.predicates.some((p) => {
            const v = (r as unknown as Record<string, unknown>)[p.col];
            if (p.op === "is.null") return v === null || v === undefined;
            if (p.op === "lt") return typeof v === "string" && v < p.val;
            return false;
          });
        }
        const v = (r as unknown as Record<string, unknown>)[f.col];
        if (f.kind === "eq") return v === f.val;
        if (f.kind === "neq") return v !== f.val;
        if (f.kind === "in") return f.vals.includes(v);
        return false;
      }),
    );
  }

  const builder = {
    select(_cols: string) {
      op = "select";
      // Allow chained .eq/.neq/.order after select.
      return builder;
    },
    update(patch: Partial<Row>) {
      op = "update";
      updatePatch = patch;
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
    in(col: string, vals: unknown[]) {
      filters.push({ kind: "in", col, vals });
      return builder;
    },
    or(expr: string) {
      // Parse PostgREST .or() syntax for the limited set we use:
      //   "claim_expires_at.is.null,claim_expires_at.lt.<iso>"
      const predicates: OrPredicate[] = expr.split(",").map((part) => {
        const m = part.match(/^(\w+)\.(is\.null|lt)(?:\.(.+))?$/);
        if (!m) throw new Error(`unsupported or-predicate: ${part}`);
        const [, col, op, val] = m;
        if (op === "is.null") return { col, op: "is.null" as const };
        return { col, op: "lt" as const, val: val ?? "" };
      });
      filters.push({ kind: "or", predicates });
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      // Terminal for select-with-no-explicit-await — vitest awaits the builder
      return Promise.resolve(finalize());
    },
    // Some calls chain .select(...) after .update(...) to return the changed rows.
    _selectAfterUpdate() {
      return Promise.resolve(finalize());
    },
    then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown) {
      return Promise.resolve(finalize()).then(onFulfilled);
    },
  };

  function finalize(): { data: unknown; error: unknown } {
    if (nextError) return { data: null, error: nextError };
    if (op === "update" && updatePatch) {
      const matching = apply();
      for (const r of matching) Object.assign(r, updatePatch);
      // Return only id (mirrors what `.select("id")` would yield).
      return { data: matching.map((r) => ({ id: r.id })), error: null };
    }
    // select path.
    let out = apply();
    if (orderCol) {
      out = [...out].sort((a, b) => {
        const av = (a as unknown as Record<string, string>)[orderCol!];
        const bv = (b as unknown as Record<string, string>)[orderCol!];
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (orderAsc ? 1 : -1);
      });
    }
    return { data: out, error: null };
  }

  // Wire .update -> .eq -> .select chain: when .select is called after .update,
  // return a thenable that finalizes the update + returns the changed rows.
  const origSelect = builder.select;
  builder.select = function selectWrap(cols: string) {
    if (op === "update") {
      return { then: (cb: any) => Promise.resolve(finalize()).then(cb) } as any;
    }
    return origSelect.call(this, cols);
  };

  return builder as any;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => makeBuilder(table),
  },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import {
  listAgentsFor,
  pauseAgentFor,
  resumeAgentFor,
  archiveAgentFor,
} from "@/lib/agents.functions";

const USER_A = "11111111-1111-1111-1111-aaaaaaaaaaaa";
const USER_B = "22222222-2222-2222-2222-bbbbbbbbbbbb";
const AGENT_1 = "33333333-3333-3333-3333-aaaaaaaaaaaa";
const AGENT_2 = "44444444-4444-4444-4444-aaaaaaaaaaaa";
const AGENT_3_ARCHIVED = "55555555-5555-5555-5555-aaaaaaaaaaaa";
const AGENT_4_OTHER_USER = "66666666-6666-6666-6666-bbbbbbbbbbbb";

function seedDefaultRows() {
  rows.push(
    {
      id: AGENT_1,
      user_id: USER_A,
      template_id: "research_digest",
      display_name: "newer agent",
      state: "active",
      cadence_hours: 24,
      last_completed_at: null,
      created_at: "2026-05-18T10:00:00Z",
    },
    {
      id: AGENT_2,
      user_id: USER_A,
      template_id: "research_digest",
      display_name: "paused agent",
      state: "paused",
      cadence_hours: 24,
      last_completed_at: "2026-05-17T03:30:00Z",
      created_at: "2026-05-17T08:00:00Z",
    },
    {
      id: AGENT_3_ARCHIVED,
      user_id: USER_A,
      template_id: "research_digest",
      display_name: "should be hidden",
      state: "archived",
      cadence_hours: 24,
      last_completed_at: "2026-04-01T00:00:00Z",
      created_at: "2026-04-01T00:00:00Z",
    },
    {
      id: AGENT_4_OTHER_USER,
      user_id: USER_B,
      template_id: "research_digest",
      display_name: "not yours",
      state: "active",
      cadence_hours: 24,
      last_completed_at: null,
      created_at: "2026-05-18T11:00:00Z",
    },
  );
}

// ─── listAgents ───────────────────────────────────────────────────────────

describe("listAgentsFor — only the user's own non-archived agents, newest first", () => {
  beforeEach(seedDefaultRows);

  it("returns only USER_A's non-archived rows (no other user's, no archived)", async () => {
    const out = await listAgentsFor(USER_A);
    const ids = out.map((r) => r.id);
    expect(ids).toContain(AGENT_1);
    expect(ids).toContain(AGENT_2);
    expect(ids).not.toContain(AGENT_3_ARCHIVED);
    expect(ids).not.toContain(AGENT_4_OTHER_USER);
  });

  it("orders by created_at descending (newest first)", async () => {
    const out = await listAgentsFor(USER_A);
    expect(out.map((r) => r.id)).toEqual([AGENT_1, AGENT_2]);
  });

  it("returns empty when user has no agents", async () => {
    rows = [];
    const out = await listAgentsFor(USER_A);
    expect(out).toEqual([]);
  });

  it("isolates users — USER_B sees only their row", async () => {
    const out = await listAgentsFor(USER_B);
    expect(out.map((r) => r.id)).toEqual([AGENT_4_OTHER_USER]);
  });

  it("propagates supabase errors with a scrubbed message", async () => {
    nextError = {
      message: "boom 'quoted PII here' boom",
    };
    await expect(listAgentsFor(USER_A)).rejects.toThrow(
      /^Agent list failed: /,
    );
    try {
      await listAgentsFor(USER_A);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/quoted PII here/);
    }
  });
});

// ─── pauseAgent ───────────────────────────────────────────────────────────

describe("pauseAgentFor — active → paused, owner-scoped", () => {
  beforeEach(seedDefaultRows);

  it("flips an active agent owned by the user to paused", async () => {
    const result = await pauseAgentFor(USER_A, { agentId: AGENT_1 });
    expect(result.affected).toBe(true);
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("paused");
  });

  it("does nothing for an already-paused agent (state filter rejects)", async () => {
    const result = await pauseAgentFor(USER_A, { agentId: AGENT_2 });
    expect(result.affected).toBe(false);
    expect(rows.find((r) => r.id === AGENT_2)?.state).toBe("paused");
  });

  it("refuses to touch another user's agent (no row affected, no state change)", async () => {
    const result = await pauseAgentFor(USER_A, { agentId: AGENT_4_OTHER_USER });
    expect(result.affected).toBe(false);
    expect(rows.find((r) => r.id === AGENT_4_OTHER_USER)?.state).toBe("active");
  });

  it("rejects malformed agentId payload via Zod", async () => {
    await expect(
      pauseAgentFor(USER_A, { agentId: "not-a-uuid" }),
    ).rejects.toThrow();
  });
});

// ─── resumeAgent ──────────────────────────────────────────────────────────

describe("resumeAgentFor — paused → active, owner-scoped", () => {
  beforeEach(seedDefaultRows);

  it("flips a paused agent owned by the user to active", async () => {
    const result = await resumeAgentFor(USER_A, { agentId: AGENT_2 });
    expect(result.affected).toBe(true);
    expect(rows.find((r) => r.id === AGENT_2)?.state).toBe("active");
  });

  it("does nothing for an already-active agent (state filter rejects)", async () => {
    const result = await resumeAgentFor(USER_A, { agentId: AGENT_1 });
    expect(result.affected).toBe(false);
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("active");
  });

  it("refuses to resume an archived agent (state filter rejects)", async () => {
    const result = await resumeAgentFor(USER_A, { agentId: AGENT_3_ARCHIVED });
    expect(result.affected).toBe(false);
    expect(rows.find((r) => r.id === AGENT_3_ARCHIVED)?.state).toBe("archived");
  });

  it("refuses to touch another user's agent", async () => {
    const result = await resumeAgentFor(USER_A, { agentId: AGENT_4_OTHER_USER });
    expect(result.affected).toBe(false);
  });
});

// ─── archiveAgent ─────────────────────────────────────────────────────────

describe("archiveAgentFor — anything-but-archived → archived, owner-scoped", () => {
  beforeEach(seedDefaultRows);

  it("archives an active agent", async () => {
    const result = await archiveAgentFor(USER_A, { agentId: AGENT_1 });
    expect(result.affected).toBe(true);
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("archived");
  });

  it("archives a paused agent", async () => {
    const result = await archiveAgentFor(USER_A, { agentId: AGENT_2 });
    expect(result.affected).toBe(true);
    expect(rows.find((r) => r.id === AGENT_2)?.state).toBe("archived");
  });

  it("is a soft delete — the row is NOT removed from the table", async () => {
    await archiveAgentFor(USER_A, { agentId: AGENT_1 });
    expect(rows.find((r) => r.id === AGENT_1)).toBeDefined();
    expect(rows.length).toBe(4); // unchanged
  });

  it("does nothing on an already-archived agent (no second bump)", async () => {
    const result = await archiveAgentFor(USER_A, { agentId: AGENT_3_ARCHIVED });
    expect(result.affected).toBe(false);
  });

  it("refuses to archive another user's agent", async () => {
    const result = await archiveAgentFor(USER_A, { agentId: AGENT_4_OTHER_USER });
    expect(result.affected).toBe(false);
    expect(rows.find((r) => r.id === AGENT_4_OTHER_USER)?.state).toBe("active");
  });

  it("archived agents disappear from listAgents on subsequent fetch", async () => {
    await archiveAgentFor(USER_A, { agentId: AGENT_1 });
    const out = await listAgentsFor(USER_A);
    expect(out.map((r) => r.id)).toEqual([AGENT_2]);
  });
});

// ─── archiveAgent lease guard ─────────────────────────────────────────────
//
// Background: even though `agent_state_enum` has no `running` state,
// the runner holds a `claim_expires_at` lease while mid-execute. If a
// user archives during that window, the runner's finalize fn
// (`update_agent_lifecycle_state`) re-reads `state` and can
// unconditionally overwrite it on the failed-promotion path (5+
// consecutive failures → 'degraded'), undoing the archive. The
// server-side archive handler refuses while the lease is live to
// close this race without touching any runtime code.

describe("archiveAgentFor — lease-held race guard", () => {
  const NOW = new Date("2026-05-18T12:00:00Z");
  const IN_FUTURE = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
  const IN_PAST = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to archive while a runner currently holds the lease (claim_expires_at > now)", async () => {
    rows.push({
      id: AGENT_1,
      user_id: USER_A,
      template_id: "research_digest",
      display_name: "mid-run agent",
      state: "active",
      cadence_hours: 24,
      last_completed_at: null,
      created_at: "2026-05-18T10:00:00Z",
      claim_expires_at: IN_FUTURE,
    });

    const result = await archiveAgentFor(USER_A, { agentId: AGENT_1 });
    expect(result.affected).toBe(false);
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("active");
  });

  it("allows archive when the lease has expired (claim_expires_at < now) — stuck-run case", async () => {
    rows.push({
      id: AGENT_1,
      user_id: USER_A,
      template_id: "research_digest",
      display_name: "stuck-lease agent",
      state: "active",
      cadence_hours: 24,
      last_completed_at: null,
      created_at: "2026-05-18T10:00:00Z",
      claim_expires_at: IN_PAST,
    });

    const result = await archiveAgentFor(USER_A, { agentId: AGENT_1 });
    expect(result.affected).toBe(true);
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("archived");
  });

  it("allows archive when no lease is held (claim_expires_at IS NULL) — the common case", async () => {
    rows.push({
      id: AGENT_1,
      user_id: USER_A,
      template_id: "research_digest",
      display_name: "idle agent",
      state: "active",
      cadence_hours: 24,
      last_completed_at: "2026-05-17T03:30:00Z",
      created_at: "2026-05-18T10:00:00Z",
      claim_expires_at: null,
    });

    const result = await archiveAgentFor(USER_A, { agentId: AGENT_1 });
    expect(result.affected).toBe(true);
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("archived");
  });

  it("pause has NO lease guard (intentional) — UX intent is 'stop future runs, let current finish'", async () => {
    rows.push({
      id: AGENT_1,
      user_id: USER_A,
      template_id: "research_digest",
      display_name: "mid-run agent",
      state: "active",
      cadence_hours: 24,
      last_completed_at: null,
      created_at: "2026-05-18T10:00:00Z",
      claim_expires_at: IN_FUTURE,
    });

    const result = await pauseAgentFor(USER_A, { agentId: AGENT_1 });
    expect(result.affected).toBe(true);
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("paused");
  });
});

// ─── Cross-handler: pause → resume round-trip ─────────────────────────────

describe("round-trip: pause → resume yields the original state", () => {
  beforeEach(seedDefaultRows);

  it("active → paused → active", async () => {
    await pauseAgentFor(USER_A, { agentId: AGENT_1 });
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("paused");
    await resumeAgentFor(USER_A, { agentId: AGENT_1 });
    expect(rows.find((r) => r.id === AGENT_1)?.state).toBe("active");
  });
});
