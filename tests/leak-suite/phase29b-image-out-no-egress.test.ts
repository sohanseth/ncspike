/**
 * Phase 2.9b — PRIVATE + image-out MUST NOT egress to a hosted provider.
 *
 * Mirrors `fail-closed-no-provider-call.test.ts`: pins that the on-device
 * image dispatcher (`streamOnDevicePrivateImage`) never invokes the
 * Lovable image gateway, the chain runner, or any hosted provider adapter
 * — even when generation fails. PRIVATE is fail-closed (replit.md §"No
 * silent fallbacks", docs/12 §15.5) so a missing on-device path must
 * surface an error event, NEVER a hosted retry.
 *
 * Strategy:
 *   - Spy on global `fetch` to catch any HTTP call.
 *   - Spy on `runImageGenTurn` (the Lovable image-gen entry) and
 *     `runChain` / `runChainStream`.
 *   - Drive the dispatcher end-to-end with the WebGPU adapter stubbed so
 *     it returns synthetic bytes that pass the safety gate.
 *   - Assert: NO call to `runImageGenTurn`, `runChain*`, OR fetch with a
 *     non-Supabase URL. The Supabase upload (chat-attachments) IS
 *     allowed — that's the user's own bucket via their own JWT, not a
 *     third-party model provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  __setNsfwClassifierForTests,
  __resetNsfwClassifierCache,
} from "@/lib/imagegen-safety";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || "test-publishable-key";

// Bypass TanStack Start middleware so server-fns are directly callable.
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
  createMiddleware: () => ({
    server: () => ({}),
    client: () => ({ server: () => ({}) }),
  }),
}));

// Spy on the Lovable image-gen entry so a misroute is caught even if
// some future refactor bypasses runChain.
const runImageGenTurnSpy = vi.fn(async () => {
  throw new Error("runImageGenTurn MUST NOT be called on PRIVATE");
});
vi.mock("@/server/inference/imagegen", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/inference/imagegen")>(
      "@/server/inference/imagegen",
    );
  return { ...actual, runImageGenTurn: runImageGenTurnSpy };
});

const runChainSpy = vi.fn(async () => {
  throw new Error("runChain MUST NOT be called on PRIVATE+image");
});
async function* runChainStreamGen(): AsyncGenerator<never, void, void> {
  throw new Error("runChainStream MUST NOT be called on PRIVATE+image");
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

// Stub the prepare/finalize/release server-fns so the test focuses on
// egress, not the persistence layer (which has its own coverage).
vi.mock("@/lib/chat.functions", () => ({
  prepareOnDeviceTurn: vi.fn(async () => ({
    threadId: "thread-1",
    userMessageId: "msg-1",
    reservedUsageId: "usage-1",
    systemPrompt: "",
    history: [],
    contextUsed: null,
    traitSheetVersion: null,
  })),
  finalizeOnDeviceImageGenTurn: vi.fn(async () => ({
    assistantMessageId: "amsg-1",
    signedUrl: "",
  })),
  releaseOnDeviceReservation: vi.fn(async () => ({ released: true })),
}));

// Stub Supabase client so the upload call resolves without network.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: { id: "test-user-1" } } }),
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null, data: { path: "x" } }),
      }),
    },
  },
}));

// Stub the WebGPU adapter to return synthetic bytes deterministically.
// We need bytes that pass classifyGeneratedImage (mime in allow-list,
// size > 64 bytes, < 25 MB).
vi.mock("@/lib/on-device-imagegen", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/on-device-imagegen")>(
      "@/lib/on-device-imagegen",
    );
  return {
    ...actual,
    streamOnDeviceImageGen: async function* () {
      yield {
        kind: "done" as const,
        bytes: new Uint8Array(2048).fill(0xff),
        mime: "image/png",
        width: 512,
        height: 512,
        adapter: "webgpu-sd-turbo" as const,
        seed: 42,
      };
    },
  };
});

// Stub capability so the dispatcher accepts the WebGPU branch.
vi.mock("@/lib/image-gen-capability", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/image-gen-capability")>(
      "@/lib/image-gen-capability",
    );
  return {
    ...actual,
    detectImageGenCapability: vi.fn(async () => ({
      available: true as const,
      adapter: "webgpu-sd-turbo" as const,
    })),
  };
});

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  runImageGenTurnSpy.mockClear();
  runChainSpy.mockClear();
  runChainStreamSpy.mockClear();
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => {
    throw new Error("fetch MUST NOT be called on PRIVATE+image dispatcher");
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  // Inject a benign on-device NSFW classifier so the safety gate
  // returns `allow` deterministically — the production loader can't
  // run in Node (no WebGPU, no Capacitor bridge) and would otherwise
  // fail-closed, masking the egress assertions this test is pinning.
  __setNsfwClassifierForTests(async () => ({
    nsfw: false,
    topLabel: "normal",
    score: 0.99,
  }));
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  __setNsfwClassifierForTests(null);
  __resetNsfwClassifierCache();
});

describe("Phase 2.9b — PRIVATE+image dispatcher: zero hosted-provider egress", () => {
  it("end-to-end PRIVATE+image turn never calls a hosted provider or fetch()", async () => {
    const { streamOnDevicePrivateImage } = await import(
      "@/lib/on-device-private-image"
    );
    const events: Array<{ kind: string }> = [];
    for await (const ev of streamOnDevicePrivateImage({
      threadId: null,
      content: "draw a cat",
      badge: "private",
    })) {
      events.push(ev as { kind: string });
    }

    // The terminal event must be `done` (or `error` for an internal
    // failure) — but NEVER from a hosted provider call.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("done");

    // Hard egress assertions.
    expect(runImageGenTurnSpy).not.toHaveBeenCalled();
    expect(runChainSpy).not.toHaveBeenCalled();
    expect(runChainStreamSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on adapter failure, dispatcher errors WITHOUT touching a hosted provider", async () => {
    // Re-mock the adapter to fail mid-stream this once. The dispatcher
    // must surface an `error` event and release the reservation —
    // NOT silently retry on Lovable / Google / OpenAI.
    const odim = await import("@/lib/on-device-imagegen");
    const orig = odim.streamOnDeviceImageGen;
    (odim as unknown as { streamOnDeviceImageGen: typeof orig }).streamOnDeviceImageGen =
      async function* () {
        yield {
          kind: "error",
          type: "internal",
          message: "GPU OOM",
        };
      } as unknown as typeof orig;

    try {
      const { streamOnDevicePrivateImage } = await import(
        "@/lib/on-device-private-image"
      );
      const events: Array<{ kind: string }> = [];
      for await (const ev of streamOnDevicePrivateImage({
        threadId: null,
        content: "draw a cat",
        badge: "private",
      })) {
        events.push(ev as { kind: string });
      }
      expect(events.some((e) => e.kind === "error")).toBe(true);
      expect(events.some((e) => e.kind === "done")).toBe(false);
    } finally {
      (odim as unknown as { streamOnDeviceImageGen: typeof orig }).streamOnDeviceImageGen = orig;
    }

    expect(runImageGenTurnSpy).not.toHaveBeenCalled();
    expect(runChainSpy).not.toHaveBeenCalled();
    expect(runChainStreamSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
