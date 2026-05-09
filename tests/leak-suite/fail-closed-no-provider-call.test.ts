/**
 * Fail-closed end-to-end pin: a broker error MUST NOT silently fall through
 * to a hosted provider call.
 *
 * Architect 2026-05-09 (re-review of the broker fail-closed delta) flagged
 * that unit tests pin the broker side of the contract, but no integration
 * test asserts the *consumers* — `sendChatMessage`, `prepareOnDeviceTurn`
 * and the `/api/chat/stream` SSE route — actually short-circuit before
 * invoking the chain runner. Without this, a future refactor that
 * re-introduces the silent-default-prompt fallback would only be caught
 * on careful code review.
 *
 * Strategy:
 *   - Mock `assembleSystemPrompt` to throw a generic Error (deliberately
 *     NOT `BlockListUnavailableError`, to cover the broadest catch path).
 *   - Mock `runChain` and `runChainStream` (the chain runner — gateway
 *     to every hosted provider adapter) as spies that throw if called.
 *   - Drive each entry point with a normal-looking request and assert:
 *       * the user-facing surface is the SCRUB_BLOCKED:context typed error
 *         (server fns) or a `validation` SSE event (route);
 *       * the chain-runner spies were never invoked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The route's inline `authenticate()` reads these. Set BEFORE module import.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || "test-publishable-key";

// ─── TanStack Start: bypass middleware so server fns are directly callable ──
// `createServerFn().middleware([...]).handler(fn)` normally wires Supabase
// auth middleware. We replace it with a builder that ignores middleware and
// invokes the handler directly with a synthetic context.userId. The auth
// middleware modules still load (they call `createMiddleware` at module top
// level) but `createMiddleware().server(fn)` returns an inert object — `fn`
// is never executed.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validator = (x: unknown) => x;
    const b: Record<string, unknown> = {};
    (b as { middleware: () => unknown }).middleware = () => b;
    (b as { inputValidator: (fn: (x: unknown) => unknown) => unknown }).inputValidator = (fn) => {
      validator = fn;
      return b;
    };
    (b as { handler: (fn: (a: unknown) => unknown) => unknown }).handler =
      (fn) => (input: { data?: unknown } = {}) =>
        Promise.resolve(
          (fn as (a: { data: unknown; context: { userId: string } }) => unknown)({
            data: validator(input.data),
            context: { userId: "test-user-1" },
          }),
        );
    return b;
  },
  createMiddleware: () => ({ server: () => ({}), client: () => ({ server: () => ({}) }) }),
}));

// ─── TanStack Router: identity passthrough so Route.server.handlers.POST is
//     the literal handler we declared in api.chat.stream.ts.
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@tanstack/react-router",
  );
  return { ...actual, createFileRoute: () => (opts: unknown) => opts };
});

// ─── Supabase JWT verification used by the SSE route's authenticate(). ─────
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getClaims: async () => ({
        data: { claims: { sub: "test-user-1" } },
        error: null,
      }),
    },
  }),
}));

// ─── supabaseAdmin: minimal but flexible chainable stub. ───────────────────
// Returns rows shaped like the columns each call site selects, count=0 for
// the cap-check head query, and empty lists for everything else.
vi.mock("@/integrations/supabase/client.server", () => {
  const supabaseAdmin = {
    // Cap reservation went RPC-only after task #8 (atomic ledger). The
    // pre-flight `assertCap()` call in both entry points hits
    // `reserve_inference_slot`; finalize/release are not reached because
    // the broker fails BEFORE any provider runs (which is the whole
    // contract under test). Always return accepted=true so cap-check
    // passes and we exercise the broker fail-closed path.
    rpc: async (name: string) => {
      if (name === "reserve_inference_slot") {
        return {
          data: [{ usage_id: "usage-1", used_count: 0, accepted: true }],
          error: null,
        };
      }
      // finalize_inference_usage / release_inference_slot — not called in
      // the fail-closed path, but return a benign shape just in case a
      // future refactor invokes them.
      return { data: true, error: null };
    },
    from: (table: string) => {
      const ctx: { isCount: boolean; inserted: Record<string, unknown> | null } = {
        isCount: false,
        inserted: null,
      };
      const chain: Record<string, unknown> = {};
      const passthrough = () => chain;
      Object.assign(chain, {
        select: (_cols?: unknown, opts?: { head?: boolean; count?: string }) => {
          if (opts && opts.head) ctx.isCount = true;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          ctx.inserted = row;
          return chain;
        },
        update: passthrough,
        delete: passthrough,
        eq: passthrough,
        neq: passthrough,
        gt: passthrough,
        gte: passthrough,
        lt: passthrough,
        lte: passthrough,
        in: passthrough,
        is: passthrough,
        order: passthrough,
        limit: passthrough,
        filter: passthrough,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === "chat_threads") {
            return {
              data: {
                id: "thread-1",
                title: "t",
                updated_at: new Date().toISOString(),
              },
              error: null,
            };
          }
          if (table === "chat_messages") {
            const r = ctx.inserted ?? {};
            return {
              data: {
                id: "msg-1",
                thread_id: (r as { thread_id?: string }).thread_id ?? "thread-1",
                role: (r as { role?: string }).role ?? "user",
                content: (r as { content?: string }).content ?? "",
                created_at: new Date().toISOString(),
                badge: (r as { badge?: string }).badge ?? null,
                provider: null,
                model: null,
                fallback_depth: null,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then: (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) => {
          if (ctx.isCount) {
            return Promise.resolve({ count: 0, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      });
      return chain;
    },
  };
  return { supabaseAdmin };
});

// ─── Skip the PRIVATE-only routing DB lookup; honour the requested badge. ──
vi.mock("@/server/personalization-routing", () => ({
  resolveBadgeForUser: vi.fn(async (_uid: string, badge: unknown) => ({
    badge,
    coercedFromPrivateOnly: false,
    coercedFromDbFailure: false,
  })),
}));

// ─── Broker throws a generic Error (NOT BlockListUnavailableError), so we
//     exercise the broadest fail-closed catch path. ─────────────────────────
vi.mock("@/server/context-broker", () => ({
  assembleSystemPrompt: vi.fn(async () => {
    throw new Error("simulated broker failure");
  }),
  logContextDecision: vi.fn(async () => {}),
}));

// ─── Two layers of "never called" assertion ─────────────────────────────────
//
// (1) The chain-runner spies (`runChain` / `runChainStream`) — the single
//     gateway every hosted-provider chat call goes through. If either is
//     invoked, the broker fail-closed contract is broken at the entry point.
//
// (2) The adapter-level spy (`getProvider` and the `generate`/`generateStream`
//     functions on the returned provider) — proves no hosted adapter was
//     instantiated or executed. Tighter than (1): even if a future refactor
//     bypasses runChain* and calls a provider directly, this catches it.
const runChainSpy = vi.fn(async () => {
  throw new Error("runChain MUST NOT be called when broker fails");
});
async function* runChainStreamGen(): AsyncGenerator<never, void, void> {
  throw new Error("runChainStream MUST NOT be called when broker fails");
}
const runChainStreamSpy = vi.fn(() => runChainStreamGen());

vi.mock("@/server/inference/chat", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/inference/chat")>(
      "@/server/inference/chat",
    );
  return {
    ...actual,
    runChain: runChainSpy,
    runChainStream: runChainStreamSpy,
  };
});

const providerGenerateSpy = vi.fn(async () => {
  throw new Error("provider.generate MUST NOT be called when broker fails");
});
async function* providerStreamGen(): AsyncGenerator<never, void, void> {
  throw new Error("provider.generateStream MUST NOT be called when broker fails");
}
const providerGenerateStreamSpy = vi.fn(() => providerStreamGen());
const getProviderSpy = vi.fn(async () => {
  throw new Error("getProvider MUST NOT be called when broker fails");
});

vi.mock("@/server/inference", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/inference")>(
      "@/server/inference",
    );
  return {
    ...actual,
    getProvider: getProviderSpy,
  };
});

beforeEach(() => {
  runChainSpy.mockClear();
  runChainStreamSpy.mockClear();
  providerGenerateSpy.mockClear();
  providerGenerateStreamSpy.mockClear();
  getProviderSpy.mockClear();
});

describe("Fail-closed: broker errors never reach a hosted provider", () => {
  it("sendChatMessage: broker throw → SCRUB_BLOCKED:context, runChain never called", async () => {
    const { sendChatMessage } = await import("@/lib/chat.functions");
    await expect(
      (sendChatMessage as unknown as (i: unknown) => Promise<unknown>)({
        data: { threadId: null, content: "hi", badge: "pro" },
      }),
    ).rejects.toThrow("SCRUB_BLOCKED:context");
    expect(runChainSpy).not.toHaveBeenCalled();
    expect(getProviderSpy).not.toHaveBeenCalled();
    expect(providerGenerateSpy).not.toHaveBeenCalled();
  });

  it("prepareOnDeviceTurn: broker throw → SCRUB_BLOCKED:context, runChain never called", async () => {
    // The on-device path runs inference on the user's device, not via the
    // chain runner — but it ALSO must surface SCRUB_BLOCKED rather than
    // silently substitute the default prompt, so a future refactor can't
    // re-introduce the same fail-OPEN bug on this entry point.
    const { prepareOnDeviceTurn } = await import("@/lib/chat.functions");
    await expect(
      (prepareOnDeviceTurn as unknown as (i: unknown) => Promise<unknown>)({
        data: { threadId: null, content: "hi" },
      }),
    ).rejects.toThrow("SCRUB_BLOCKED:context");
    expect(runChainSpy).not.toHaveBeenCalled();
    expect(getProviderSpy).not.toHaveBeenCalled();
    expect(providerGenerateSpy).not.toHaveBeenCalled();
  });

  it("/api/chat/stream: broker throw → validation SSE event, runChainStream never called", async () => {
    const mod = await import("@/routes/api.chat.stream");
    const route = mod.Route as unknown as {
      server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } };
    };
    const request = new Request("http://localhost/api/chat/stream", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        threadId: null,
        content: "hi",
        badge: "pro",
        attachments: [],
      }),
    });
    const response = await route.server.handlers.POST({ request });
    expect(response.status).toBe(200);
    const text = await response.text();
    // The validation SSE frame is what the client maps onto the
    // user-facing "Personalization context blocked" toast.
    expect(text).toContain("event: error");
    expect(text).toContain('"kind":"validation"');
    expect(runChainStreamSpy).not.toHaveBeenCalled();
    expect(getProviderSpy).not.toHaveBeenCalled();
    expect(providerGenerateStreamSpy).not.toHaveBeenCalled();
  });
});
