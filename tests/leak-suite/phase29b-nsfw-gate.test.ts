/**
 * Phase 2.9b — output-side NSFW / safety gate fail-closed invariants.
 *
 * Pins the contract from `src/lib/imagegen-safety.ts` (locked spec
 * docs/12 §15.4):
 *   - The classifier is fail-CLOSED. Any throw → deny by default; a
 *     misbehaving classifier must never grant permission.
 *   - Structurally invalid bytes (too small, too big, wrong mime) →
 *     deny with a plain-English reason.
 *   - When the on-device NSFW model FLAGS the bytes → deny with the
 *     §15.4 toast text. The dispatcher MUST NOT upload a flagged image
 *     to the chat-attachments bucket, even though that bucket is the
 *     user's own (the §15.4 line: "PRIVATE never sends an unfiltered
 *     image off-device, even to its own bucket, on a flagged result").
 *   - When the classifier MODEL FAILS TO LOAD → deny. We can't certify
 *     the image as safe, so we refuse to persist it (also §15.4).
 *   - When the gate denies, the PRIVATE+image dispatcher MUST:
 *       1. NOT upload the bytes (they never touch the storage bucket).
 *       2. Release the reserved cap slot (don't debit the user for a
 *          turn that produced no visible image).
 *       3. Surface a `validation` error event with the deny reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  classifyGeneratedImage,
  __setNsfwClassifierForTests,
  __resetNsfwClassifierCache,
} from "@/lib/imagegen-safety";

const VALID_PNG = new Uint8Array(2048).fill(0xff);

afterEach(() => {
  __setNsfwClassifierForTests(null);
  __resetNsfwClassifierCache();
});

describe("Phase 2.9b — classifyGeneratedImage structural deny contract", () => {
  it("denies bytes below the minimum size threshold", async () => {
    const v = await classifyGeneratedImage(new Uint8Array(8), "image/png");
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toMatch(/too small/i);
  });

  it("denies bytes above the 25 MB safety cap", async () => {
    const v = await classifyGeneratedImage(
      new Uint8Array(26 * 1024 * 1024),
      "image/png",
    );
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toMatch(/exceeds/i);
  });

  it("denies disallowed mime types", async () => {
    const v = await classifyGeneratedImage(
      new Uint8Array(1024).fill(0xff),
      "image/svg+xml",
    );
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toMatch(/mime/i);
  });
});

describe("Phase 2.9b — classifyGeneratedImage model-based contract", () => {
  it("allows when the on-device classifier returns nsfw=false", async () => {
    __setNsfwClassifierForTests(async () => ({
      nsfw: false,
      topLabel: "normal",
      score: 0.99,
    }));
    const v = await classifyGeneratedImage(VALID_PNG, "image/png");
    expect(v.allow).toBe(true);
  });

  it("denies with the §15.4 toast when the classifier flags the image", async () => {
    __setNsfwClassifierForTests(async () => ({
      nsfw: true,
      topLabel: "nsfw",
      score: 0.92,
    }));
    const v = await classifyGeneratedImage(VALID_PNG, "image/png");
    expect(v.allow).toBe(false);
    if (!v.allow) {
      expect(v.reason).toMatch(/blocked by on-device safety filter/i);
      expect(v.reason).toMatch(/different prompt/i);
    }
  });

  it("denies (fail-closed) when the classifier itself throws mid-inference", async () => {
    __setNsfwClassifierForTests(async () => {
      throw new Error("WebGPU device lost");
    });
    const v = await classifyGeneratedImage(VALID_PNG, "image/png");
    expect(v.allow).toBe(false);
    if (!v.allow) {
      expect(v.reason).toMatch(/blocked by on-device safety filter/i);
    }
  });

  it("denies (fail-closed) when no classifier can be loaded (load-failure path)", async () => {
    // No override set → production loader runs → no Capacitor + no
    // browser runtime in the Node test runner → loadWebClassifier()
    // throws "needs a browser runtime" → gate fails closed.
    __setNsfwClassifierForTests(null);
    __resetNsfwClassifierCache();
    const v = await classifyGeneratedImage(VALID_PNG, "image/png");
    expect(v.allow).toBe(false);
    if (!v.allow) {
      expect(v.reason).toMatch(/blocked by on-device safety filter/i);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Dispatcher-level: deny verdict short-circuits before upload.
// ───────────────────────────────────────────────────────────────────────────

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

const releaseSpy = vi.fn(async () => ({ released: true }));
const finalizeSpy = vi.fn(async () => ({
  assistantMessageId: "amsg-1",
  signedUrl: "",
}));
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
  finalizeOnDeviceImageGenTurn: finalizeSpy,
  releaseOnDeviceReservation: releaseSpy,
}));

const uploadSpy = vi.fn(async () => ({ error: null, data: { path: "x" } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: { id: "test-user-1" } } }),
    },
    storage: {
      from: () => ({ upload: uploadSpy }),
    },
  },
}));

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

// First dispatcher test reuses the structural-deny path: adapter
// returns bytes < MIN_BYTES, so the gate refuses without ever calling
// the classifier. This pins that the dispatcher honours structural
// denies the same way it honours model denies.
const tooSmallAdapterMock = {
  streamOnDeviceImageGen: async function* () {
    yield {
      kind: "done" as const,
      bytes: new Uint8Array(8).fill(0xff),
      mime: "image/png",
      width: 512,
      height: 512,
      adapter: "webgpu-sd-turbo" as const,
      seed: 42,
    };
  },
};

vi.mock("@/lib/on-device-imagegen", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/on-device-imagegen")>(
      "@/lib/on-device-imagegen",
    );
  return {
    ...actual,
    streamOnDeviceImageGen: (...args: unknown[]) =>
      tooSmallAdapterMock.streamOnDeviceImageGen(...(args as [])),
  };
});

describe("Phase 2.9b — dispatcher honours NSFW deny verdict", () => {
  beforeEach(() => {
    releaseSpy.mockClear();
    finalizeSpy.mockClear();
    uploadSpy.mockClear();
    __setNsfwClassifierForTests(null);
    __resetNsfwClassifierCache();
    // Default adapter for this block: bytes too small (structural deny).
    tooSmallAdapterMock.streamOnDeviceImageGen = async function* () {
      yield {
        kind: "done" as const,
        bytes: new Uint8Array(8).fill(0xff),
        mime: "image/png",
        width: 512,
        height: 512,
        adapter: "webgpu-sd-turbo" as const,
        seed: 42,
      };
    };
  });

  it("structural deny (too-small bytes) → no upload, reservation released, validation error event", async () => {
    const { streamOnDevicePrivateImage } = await import(
      "@/lib/on-device-private-image"
    );
    const events: Array<{ kind: string; type?: string; message?: string }> = [];
    for await (const ev of streamOnDevicePrivateImage({
      threadId: null,
      content: "draw a cat",
      badge: "private",
    })) {
      events.push(ev as { kind: string; type?: string; message?: string });
    }

    const errEvt = events.find((e) => e.kind === "error");
    expect(errEvt).toBeDefined();
    expect(errEvt?.type).toBe("validation");
    expect(errEvt?.message).toMatch(/too small/i);

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "done")).toBe(false);
  });

  it("classifier flags the image → no upload, reservation released, §15.4 toast surfaced", async () => {
    // Adapter returns structurally-valid bytes (so the classifier IS
    // reached), and the injected classifier flags them as nsfw.
    tooSmallAdapterMock.streamOnDeviceImageGen = async function* () {
      yield {
        kind: "done" as const,
        bytes: new Uint8Array(2048).fill(0xff),
        mime: "image/png",
        width: 512,
        height: 512,
        adapter: "webgpu-sd-turbo" as const,
        seed: 42,
      };
    };
    __setNsfwClassifierForTests(async () => ({
      nsfw: true,
      topLabel: "nsfw",
      score: 0.95,
    }));

    const { streamOnDevicePrivateImage } = await import(
      "@/lib/on-device-private-image"
    );
    const events: Array<{ kind: string; type?: string; message?: string }> = [];
    for await (const ev of streamOnDevicePrivateImage({
      threadId: null,
      content: "draw something edgy",
      badge: "private",
    })) {
      events.push(ev as { kind: string; type?: string; message?: string });
    }

    const errEvt = events.find((e) => e.kind === "error");
    expect(errEvt).toBeDefined();
    expect(errEvt?.type).toBe("validation");
    expect(errEvt?.message).toMatch(/blocked by on-device safety filter/i);
    expect(errEvt?.message).toMatch(/different prompt/i);

    // §15.4: flagged bytes never touch the bucket, even the user's own.
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "done")).toBe(false);
  });
});
