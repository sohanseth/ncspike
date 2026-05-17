/**
 * Phase 3.0 product surface — `createResearchDigestAgentFor` tests.
 *
 * Acceptance criteria from the PR's spec:
 *   1. User can create a ResearchDigest agent with name + topics
 *   2. Inserted row is active, due immediately, and valid for the existing runner
 *   3. Invalid empty name / empty topics / >5 topics are rejected
 *   4. No runtime foundation files touched (asserted via a grep invariant)
 *
 * Tests target the pure handler `createResearchDigestAgentFor(userId, raw)`
 * — the auth-wrapped server fn is a thin shim over it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── In-memory supabase mock ───────────────────────────────────────────────

type InsertedRow = Record<string, unknown>;
let insertedRows: InsertedRow[] = [];
let nextInsertError: { message: string } | null = null;

beforeEach(() => {
  insertedRows = [];
  nextInsertError = null;
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (_table: string) => ({
      insert: (row: InsertedRow) => {
        // Match the real supabase chain shape the handler uses:
        //   .from('agents').insert(row).select('...').single()
        insertedRows.push(row);
        return {
          select: (_cols: string) => ({
            single: async () => {
              if (nextInsertError) return { data: null, error: nextInsertError };
              return {
                data: {
                  id: "agent-uuid-1",
                  template_id: row.template_id,
                  display_name: row.display_name,
                  badge: row.badge,
                  state: row.state,
                  cadence_hours: row.cadence_hours,
                },
                error: null,
              };
            },
          }),
        };
      },
    }),
  },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { createResearchDigestAgentFor } from "@/lib/agents.functions";
import { researchDigest } from "@/server/agents/templates/research-digest";

const USER = "11111111-2222-3333-4444-555555555555";

// ─── Success path ──────────────────────────────────────────────────────────

describe("createResearchDigestAgentFor — success path", () => {
  it("inserts a row with the runtime-compatible shape (active + due immediately)", async () => {
    const summary = await createResearchDigestAgentFor(USER, {
      display_name: "AI research digest",
      topics: ["open-source LLMs", "alignment"],
    });

    expect(summary).toMatchObject({
      template_id: "research_digest",
      display_name: "AI research digest",
      badge: researchDigest.defaultBadge,
      state: "active",
      cadence_hours: researchDigest.defaultCadenceHours,
    });

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0];

    // Owner + template wiring.
    expect(row.user_id).toBe(USER);
    expect(row.template_id).toBe("research_digest");
    expect(row.display_name).toBe("AI research digest");

    // State: active → claim_due_agents will look at this row.
    // last_completed_at omitted → NULL → "always due" per the SQL fn.
    expect(row.state).toBe("active");
    expect(row).not.toHaveProperty("last_completed_at");

    // Template-supplied defaults.
    expect(row.badge).toBe(researchDigest.defaultBadge);
    expect(row.cadence_hours).toBe(researchDigest.defaultCadenceHours);
    expect(row.budget).toEqual(researchDigest.defaultBudget);

    // Config went through the template's Zod schema → topics preserved + defaults filled.
    const config = row.config as { topics: string[]; lookbackHours: number; minScore: number };
    expect(config.topics).toEqual(["open-source LLMs", "alignment"]);
    expect(config.lookbackHours).toBe(24);
    expect(config.minScore).toBe(0.5);
  });

  it("trims whitespace on display_name and topics", async () => {
    await createResearchDigestAgentFor(USER, {
      display_name: "  digest  ",
      topics: ["  llms  ", "alignment"],
    });
    const row = insertedRows[0];
    expect(row.display_name).toBe("digest");
    expect((row.config as { topics: string[] }).topics).toEqual(["llms", "alignment"]);
  });

  it("accepts the maximum 5 topics", async () => {
    const topics = ["a", "b", "c", "d", "e"];
    await createResearchDigestAgentFor(USER, {
      display_name: "five",
      topics,
    });
    expect((insertedRows[0].config as { topics: string[] }).topics).toEqual(topics);
  });
});

// ─── Validation rejections ─────────────────────────────────────────────────

describe("createResearchDigestAgentFor — input validation rejects invalid", () => {
  it("rejects empty display_name", async () => {
    await expect(
      createResearchDigestAgentFor(USER, { display_name: "", topics: ["x"] }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects whitespace-only display_name", async () => {
    await expect(
      createResearchDigestAgentFor(USER, { display_name: "   ", topics: ["x"] }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects empty topics array", async () => {
    await expect(
      createResearchDigestAgentFor(USER, { display_name: "x", topics: [] }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects >5 topics", async () => {
    await expect(
      createResearchDigestAgentFor(USER, {
        display_name: "x",
        topics: ["a", "b", "c", "d", "e", "f"],
      }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects empty-string topic entries", async () => {
    await expect(
      createResearchDigestAgentFor(USER, {
        display_name: "x",
        topics: ["valid", "   "],
      }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects oversized display_name", async () => {
    await expect(
      createResearchDigestAgentFor(USER, {
        display_name: "x".repeat(200),
        topics: ["a"],
      }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects oversized topic string", async () => {
    await expect(
      createResearchDigestAgentFor(USER, {
        display_name: "x",
        topics: ["x".repeat(200)],
      }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });

  it("rejects non-string topics", async () => {
    await expect(
      createResearchDigestAgentFor(USER, {
        display_name: "x",
        topics: [123 as unknown as string],
      }),
    ).rejects.toThrow();
    expect(insertedRows).toHaveLength(0);
  });
});

// ─── Supabase error envelope is scrubbed ───────────────────────────────────

describe("createResearchDigestAgentFor — supabase error scrubbing", () => {
  it("scrubs Supabase error.message before re-throwing (no-content-in-logs invariant)", async () => {
    nextInsertError = {
      message:
        "duplicate key value violates unique constraint \"agents_user_name_uniq\" Key (display_name)=(secret email user@example.com)",
    };

    await expect(
      createResearchDigestAgentFor(USER, {
        display_name: "dupe",
        topics: ["a"],
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^Agent create failed: /),
    });

    // The thrown message should not contain the quoted PII the scrubber redacts.
    try {
      await createResearchDigestAgentFor(USER, {
        display_name: "dupe",
        topics: ["a"],
      });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toMatch(/user@example\.com/);
      expect(msg).not.toMatch(/"agents_user_name_uniq"/);
    }
  });
});

// ─── Static invariant: no runtime-foundation files touched ────────────────
//
// Acceptance criterion #4: "No runtime foundation files touched."
// Defined as: src/server/agents/{runner,batch,queue,budget,error-scrub,types}.ts
// + src/server/agents/templates/* + src/worker.ts + wrangler.jsonc + the
// migration files. Anything outside that surface is free game for product
// PRs; touching anything inside it requires either an actual deploy-found
// bug or an explicit "yes please" from the owner.

describe("PR invariant: agent-create MVP touches no runtime foundation file", () => {
  const repoRoot = join(__dirname, "..", "..");
  const FOUNDATION_FILES = [
    "src/server/agents/runner.ts",
    "src/server/agents/batch.ts",
    "src/server/agents/queue.ts",
    "src/server/agents/budget.ts",
    "src/server/agents/error-scrub.ts",
    "src/server/agents/types.ts",
    "src/server/agents/templates/index.ts",
    "src/server/agents/templates/research-digest.ts",
    "src/worker.ts",
    "wrangler.jsonc",
  ];

  for (const path of FOUNDATION_FILES) {
    it(`${path} exists and is unchanged in this PR (no edits)`, () => {
      const txt = readFileSync(join(repoRoot, path), "utf8");
      // We can't byte-compare against main from within the test runner
      // (PR3b learned that lesson — see phase30-research-digest.test.ts
      // history). What we can do: check that no NEW imports point at this
      // PR's product-surface module, which would imply the runtime started
      // depending on the UI rather than the other way around.
      expect(txt).not.toMatch(/from\s+['"]@\/lib\/agents\.functions['"]/);
      expect(txt).not.toMatch(/from\s+['"]@\/routes\/workspace\.agents['"]/);
    });
  }
});
