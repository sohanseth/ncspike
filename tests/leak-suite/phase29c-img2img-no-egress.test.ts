/**
 * Phase 2.9c — PRIVATE + image + ATTACHMENT (img2img) MUST NOT egress.
 *
 * Sister test to `phase29b-image-out-no-egress.test.ts`. Slice c wires the
 * img2img path (`detectImageEditCapability` → SDXL+IP2P / SD1.5+ControlNet
 * adapter → bytes back to chat-attachments). This test pins the strongest
 * promise of the on-device PRIVATE tier:
 *
 *   "PRIVATE + image + attachment never invokes a hosted provider."
 *
 * If anyone refactors the dispatcher and accidentally falls back to the
 * Lovable image gateway / chain runner / a raw fetch when the WebGPU
 * adapter fails, the leak suite catches it.
 *
 * Strategy:
 *   - Spy on global `fetch` to catch any HTTP call.
 *   - Spy on `runImageGenTurn` (the hosted image-gen entry) and
 *     `runChain` / `runChainStream` (text fallback paths).
 *   - Stub the WebGPU edit capability + adapter so the runner walks the
 *     end-to-end path without touching real GPU / model weights.
 *   - Stub Supabase storage so the source-image download (and the
 *     output upload) resolve in-memory.
 *   - Drive a turn with an attachment + an edit-intent prompt.
 *   - Assert: zero hosted-provider calls AND zero non-Supabase fetches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || "test-publishable-key";

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

const runImageGenTurnSpy = vi.fn(async () => {
  throw new Error("runImageGenTurn MUST NOT be called on PRIVATE+img2img");
});
vi.mock("@/server/inference/imagegen", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/inference/imagegen")>(
      "@/server/inference/imagegen",
    );
  return { ...actual, runImageGenTurn: runImageGenTurnSpy };
});

const runChainSpy = vi.fn(async () => {
  throw new Error("runChain MUST NOT be called on PRIVATE+img2img");
});
async function* runChainStreamGen(): AsyncGenerator<never, void, void> {
  throw new Error("runChainStream MUST NOT be called on PRIVATE+img2img");
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

// Track which storage calls happened so we can verify the source-image
// download went through Supabase (= the user's own bucket via JWT) and
// not via raw fetch to a third party.
const storageDownloadSpy = vi.fn(async () => ({
  data: new Blob([new Uint8Array(2048).fill(0xab)], { type: "image/png" }),
  error: null,
}));
const storageUploadSpy = vi.fn(async () => ({ error: null, data: { path: "x" } }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: { id: "test-user-1" } } }),
    },
    storage: {
      from: () => ({
        download: storageDownloadSpy,
        upload: storageUploadSpy,
      }),
    },
  },
}));

// Stub the WebGPU runner to return synthetic bytes deterministically,
// AND assert it actually saw the source images (otherwise the dispatcher
// would have skipped the edit branch and silently degraded to text-to-
// image — a fail-open per replit.md).
const sawSourceImagesSpy = vi.fn();
vi.mock("@/lib/on-device-imagegen", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/on-device-imagegen")>(
      "@/lib/on-device-imagegen",
    );
  return {
    ...actual,
    streamOnDeviceImageGen: async function* (input: {
      sourceImages?: Array<{ bytes: Uint8Array; mime: string }>;
    }) {
      sawSourceImagesSpy(input.sourceImages?.length ?? 0);
      yield {
        kind: "done" as const,
        bytes: new Uint8Array(2048).fill(0xff),
        mime: "image/png",
        width: 512,
        height: 512,
        adapter: "webgpu-sdxl-ip2p" as const,
        seed: 42,
      };
    },
  };
});

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
    detectImageEditCapability: vi.fn(async () => ({
      available: true as const,
      adapter: "webgpu-sdxl-ip2p" as const,
    })),
  };
});

let fetchSpy: ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch | undefined;

beforeEach(() => {
  runImageGenTurnSpy.mockClear();
  runChainSpy.mockClear();
  runChainStreamSpy.mockClear();
  storageDownloadSpy.mockClear();
  storageUploadSpy.mockClear();
  sawSourceImagesSpy.mockClear();
  originalFetch = globalThis.fetch;
  fetchSpy = vi.fn(async () => {
    throw new Error("fetch MUST NOT be called on PRIVATE+img2img dispatcher");
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("Phase 2.9c — PRIVATE+img2img dispatcher: zero hosted-provider egress", () => {
  it("end-to-end PRIVATE + attachment + edit-intent never calls a hosted provider", async () => {
    const { streamOnDevicePrivateImage } = await import(
      "@/lib/on-device-private-image"
    );
    const events: Array<{ kind: string }> = [];
    for await (const ev of streamOnDevicePrivateImage({
      threadId: null,
      content: "change the background to a beach",
      badge: "private",
      attachments: ["test-user-1/photo-1.png"],
    })) {
      events.push(ev as { kind: string });
    }

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("done");

    // The runner DID see source images (we actually walked the img2img
    // branch — this guards against a regression that silently strips the
    // attachment and degrades to text-to-image).
    expect(sawSourceImagesSpy).toHaveBeenCalledWith(1);

    // The source bytes came from Supabase storage (= user's own bucket
    // via JWT), not from a third-party fetch.
    expect(storageDownloadSpy).toHaveBeenCalledTimes(1);

    // Hard egress assertions.
    expect(runImageGenTurnSpy).not.toHaveBeenCalled();
    expect(runChainSpy).not.toHaveBeenCalled();
    expect(runChainStreamSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on adapter failure, dispatcher errors WITHOUT touching a hosted provider", async () => {
    const odim = await import("@/lib/on-device-imagegen");
    const orig = odim.streamOnDeviceImageGen;
    (odim as unknown as { streamOnDeviceImageGen: typeof orig }).streamOnDeviceImageGen =
      async function* () {
        yield {
          kind: "error",
          type: "internal",
          message: "GPU OOM during img2img",
        };
      } as unknown as typeof orig;

    try {
      const { streamOnDevicePrivateImage } = await import(
        "@/lib/on-device-private-image"
      );
      const events: Array<{ kind: string }> = [];
      for await (const ev of streamOnDevicePrivateImage({
        threadId: null,
        content: "change the background to a beach",
        badge: "private",
        attachments: ["test-user-1/photo-1.png"],
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

  it("rejects an attachment path not owned by the signed-in user (no fetch, no provider call)", async () => {
    const { streamOnDevicePrivateImage } = await import(
      "@/lib/on-device-private-image"
    );
    const events: Array<{ kind: string }> = [];
    for await (const ev of streamOnDevicePrivateImage({
      threadId: null,
      content: "change the background to a beach",
      badge: "private",
      attachments: ["someone-else/photo-1.png"],
    })) {
      events.push(ev as { kind: string });
    }
    expect(events.some((e) => e.kind === "error")).toBe(true);
    // The dispatcher refused before any download or adapter run.
    expect(storageDownloadSpy).not.toHaveBeenCalled();
    expect(sawSourceImagesSpy).not.toHaveBeenCalled();
    expect(runImageGenTurnSpy).not.toHaveBeenCalled();
    expect(runChainSpy).not.toHaveBeenCalled();
    expect(runChainStreamSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
