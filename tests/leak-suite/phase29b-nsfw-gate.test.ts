/**
 * Phase 2.9b — output-side NSFW / safety gate fail-closed invariants.
 *
 * Pins the contract from `src/lib/imagegen-safety.ts`:
 *   - The classifier is fail-CLOSED. Any throw → deny by default; a
 *     misbehaving classifier must never grant permission.
 *   - Structurally invalid bytes (too small, too big, wrong mime) →
 *     deny with a plain-English reason.
 *   - When the gate denies, the PRIVATE+image dispatcher MUST:
 *       1. NOT upload the bytes (they never touch the storage bucket).
 *       2. Release the reserved cap slot (don't debit the user for a
 *          turn that produced no visible image).
 *       3. Surface a `validation` error event with the deny reason.
 *
 * The third invariant is what docs/12 §15.4 calls out — "PRIVATE never
 * sends an unfiltered image off-device, even to its own bucket, on a
 * flagged result."
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { classifyGeneratedImage } from "@/lib/imagegen-safety";

describe("Phase 2.9b — classifyGeneratedImage fail-closed contract", () => {
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

  it("allows structurally valid PNG bytes (slice-b stub baseline)", async () => {
    const v = await classifyGeneratedImage(
      new Uint8Array(2048).fill(0xff),
      "image/png",
    );
    expect(v.allow).toBe(true);
  });
});

// Dispatcher-level test: deny verdict short-circuits before upload.
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

// Adapter returns bytes the safety gate WILL deny (too small).
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
        bytes: new Uint8Array(8).fill(0xff), // < MIN_BYTES → deny
        mime: "image/png",
        width: 512,
        height: 512,
        adapter: "webgpu-sd-turbo" as const,
        seed: 42,
      };
    },
  };
});

describe("Phase 2.9b — dispatcher honours NSFW deny verdict", () => {
  beforeEach(() => {
    releaseSpy.mockClear();
    finalizeSpy.mockClear();
    uploadSpy.mockClear();
  });

  it("deny verdict → no upload, reservation released, validation error event", async () => {
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

    // Bytes never touched the bucket.
    expect(uploadSpy).not.toHaveBeenCalled();
    // The cap reservation was released so the user isn't debited.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    // Finalize must NOT have run — there is no image to persist.
    expect(finalizeSpy).not.toHaveBeenCalled();
    // No `done` event slipped through.
    expect(events.some((e) => e.kind === "done")).toBe(false);
  });
});
