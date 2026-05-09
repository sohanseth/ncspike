/**
 * Phase 2.7-bis hardening — broker + private-only routing fail-closed.
 *
 * Architect B2 (2026-05-09) flagged two severe fail-OPEN paths that
 * contradict replit.md "no silent fallbacks; fail-closed at strictest tier":
 *
 *   1. `resolveBadgeForUser()` returned the requested HOSTED badge on a
 *      user_settings DB error — a Strict-mode user could be silently
 *      routed to OpenAI/Anthropic during a Supabase hiccup.
 *   2. `loadTraitBlocks()` and `loadProviderCategoryBlocks()` returned
 *      empty sets on DB error — user-explicit trait/category exclusions
 *      could be silently bypassed and injected into hosted prompts.
 *
 * Both now fail CLOSED (private badge / scrubBlocked=true). This suite pins
 * the new behaviour so a future "make this resilient" refactor can't
 * silently re-introduce the leak.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const logScrubEventSpy = vi.fn(async () => {});
vi.mock("@/server/pii-scrub", async () => {
  const actual = await vi.importActual<typeof import("@/server/pii-scrub")>(
    "@/server/pii-scrub",
  );
  return { ...actual, logScrubEvent: logScrubEventSpy };
});

// Mutable state so each test can dictate what the supabase mock returns
// without re-importing modules (which Vitest aggressively caches).
type ErrEnvelope = { data: null; error: { message: string } };
type OkEnvelope<T> = { data: T; error: null };
const state: {
  userSettings: ErrEnvelope | OkEnvelope<{ private_only_mode: boolean } | null>;
  userTraits: OkEnvelope<{ version: number; sheet: unknown } | null>;
  traitBlocks: ErrEnvelope | OkEnvelope<unknown[]>;
  providerBlocks: ErrEnvelope | OkEnvelope<unknown[]>;
} = {
  userSettings: { data: { private_only_mode: false }, error: null },
  userTraits: { data: null, error: null },
  traitBlocks: { data: [], error: null },
  providerBlocks: { data: [], error: null },
};

vi.mock("@/integrations/supabase/client.server", () => {
  function buildResult(table: string): unknown {
    if (table === "user_settings") return state.userSettings;
    if (table === "user_traits") return state.userTraits;
    if (table === "user_trait_blocks") return state.traitBlocks;
    if (table === "user_provider_category_blocks") return state.providerBlocks;
    if (table === "user_known_names") return { data: [], error: null };
    return { data: [], error: null };
  }
  function makeQuery(table: string) {
    const chain: any = {
      maybeSingle: async () => buildResult(table),
      then: (res: any) => Promise.resolve(buildResult(table)).then(res),
      insert: async () => ({ data: null, error: null }),
    };
    for (const m of ["select", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "order", "limit", "filter"]) {
      chain[m] = () => chain;
    }
    return chain;
  }
  return { supabaseAdmin: { from: (table: string) => makeQuery(table) } };
});

const ONES_384 = Array.from({ length: 384 }, () => 1);
vi.mock("@/server/inference/cloudflare", () => ({
  embedTexts: async (texts: string[]) => texts.map(() => ONES_384),
}));

beforeEach(() => {
  logScrubEventSpy.mockClear();
  state.userSettings = { data: { private_only_mode: false }, error: null };
  state.userTraits = { data: null, error: null };
  state.traitBlocks = { data: [], error: null };
  state.providerBlocks = { data: [], error: null };
});

describe("resolveBadgeForUser — fail-closed on DB failure", () => {
  it("requested=private always returns private (no DB lookup needed)", async () => {
    state.userSettings = { data: null, error: { message: "should not be called" } };
    const { resolveBadgeForUser } = await import("@/server/personalization-routing");
    const r = await resolveBadgeForUser("u1", "private");
    expect(r.badge).toBe("private");
    expect(r.coercedFromPrivateOnly).toBe(false);
    expect(r.coercedFromDbFailure).toBe(false);
  });

  it("private_only_mode=true → coerce HOSTED to private (existing behaviour preserved)", async () => {
    state.userSettings = { data: { private_only_mode: true }, error: null };
    const { resolveBadgeForUser } = await import("@/server/personalization-routing");
    const r = await resolveBadgeForUser("u1", "pro");
    expect(r.badge).toBe("private");
    expect(r.coercedFromPrivateOnly).toBe(true);
    expect(r.coercedFromDbFailure).toBe(false);
  });

  it("private_only_mode=false → honour requested HOSTED badge", async () => {
    state.userSettings = { data: { private_only_mode: false }, error: null };
    const { resolveBadgeForUser } = await import("@/server/personalization-routing");
    const r = await resolveBadgeForUser("u1", "pro");
    expect(r.badge).toBe("pro");
    expect(r.coercedFromPrivateOnly).toBe(false);
    expect(r.coercedFromDbFailure).toBe(false);
  });

  it("DB error envelope on user_settings → coerce to private (fail-closed)", async () => {
    state.userSettings = { data: null, error: { message: "PGRST: timeout" } };
    const { resolveBadgeForUser } = await import("@/server/personalization-routing");
    const r = await resolveBadgeForUser("u1", "pro");
    expect(r.badge).toBe("private");
    expect(r.coercedFromPrivateOnly).toBe(false);
    expect(r.coercedFromDbFailure).toBe(true);
  });
});

describe("Broker — fail-closed when blocklists can't be loaded", () => {
  // Minimal valid trait sheet so the broker reaches the blocklist load step.
  const SHEET = {
    schema_version: 1 as const,
    derived_at: "2026-05-09T00:00:00.000Z",
    source_memory_ids: [],
    categories: { preferences: { tone: "concise" as const, shopping: ["x".repeat(80)] } },
    category_embeddings: { preferences: ONES_384 },
  };

  it("provider-category blocklist load error → scrubBlocked=true, empty fragment, audit row emitted", async () => {
    state.userTraits = { data: { version: 1, sheet: SHEET }, error: null };
    state.providerBlocks = { data: null, error: { message: "PGRST: timeout" } };
    state.traitBlocks = { data: [], error: null };
    const { assembleSystemPrompt } = await import("@/server/context-broker");
    const result = await assembleSystemPrompt({
      userId: "00000000-0000-0000-0000-000000000002",
      query: "what should I cook tonight?",
      badge: "pro",
      strictestTierInChain: 3,
    });
    expect(result.scrubBlocked).toBe(true);
    expect(result.fragment).toBe("");
    expect(result.contextUsed.categories).toHaveLength(0);
    expect(logScrubEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ patternClass: "blocklist_unavailable" }),
    );
  });

  it("per-trait blocklist load error → scrubBlocked=true, empty fragment, audit row emitted", async () => {
    state.userTraits = { data: { version: 1, sheet: SHEET }, error: null };
    state.providerBlocks = { data: [], error: null };
    state.traitBlocks = { data: null, error: { message: "PGRST: timeout" } };
    const { assembleSystemPrompt } = await import("@/server/context-broker");
    const result = await assembleSystemPrompt({
      userId: "00000000-0000-0000-0000-000000000003",
      query: "what should I cook tonight?",
      badge: "pro",
      strictestTierInChain: 3,
    });
    expect(result.scrubBlocked).toBe(true);
    expect(result.fragment).toBe("");
    expect(result.contextUsed.categories).toHaveLength(0);
    expect(logScrubEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ patternClass: "blocklist_unavailable" }),
    );
  });

  it("BlockListUnavailableError is exported (typed surface for callers)", async () => {
    const mod = await import("@/server/context-broker");
    expect(typeof mod.BlockListUnavailableError).toBe("function");
    const e = new mod.BlockListUnavailableError("trait", "x");
    expect(e.source).toBe("trait");
    expect(e.name).toBe("BlockListUnavailableError");
  });
});
