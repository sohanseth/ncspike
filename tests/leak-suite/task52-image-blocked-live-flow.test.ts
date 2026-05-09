// Task #52 — pin the LIVE-flow rendering of the on-device "image blocked"
// turn. The styled amber bubble must appear immediately when the
// classifier denies, not only after a thread reload.
//
// We have no JSDOM/RTL setup in this Vitest project (env: "node"), so we
// pin the wiring two ways:
//
//   1. Static assertions on MainApp.tsx — the streaming consumer must
//      branch on `evt.type === "image_blocked"` BEFORE the generic
//      `errorMsg = evt.message` rollback path, must fill the optimistic
//      assistant bubble with `IMAGE_BLOCKED_PLACEHOLDER_TEXT`, and must
//      NOT roll back the user message (the rollback only triggers when
//      `gotAnyDelta` is false).
//
//   2. Behavioural assertion on the on-device dispatcher — when the
//      NSFW gate denies, the runner must yield `{ kind: "error",
//      type: "image_blocked" }` (not `"validation"`), so the consumer
//      branch above is reachable.
//
// Together these pin: live rendering matches post-reload rendering.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  __setNsfwClassifierForTests,
  __resetNsfwClassifierCache,
} from "@/lib/imagegen-safety";

const here = dirname(fileURLToPath(import.meta.url));
const mainApp = readFileSync(
  resolve(here, "../../src/components/workspace/MainApp.tsx"),
  "utf8",
);

describe("Task #52 — MainApp handles image_blocked inline (no rollback)", () => {
  it("the streaming consumer branches on evt.type === \"image_blocked\"", () => {
    expect(mainApp).toMatch(/evt\.type === "image_blocked"/);
  });

  it("the image_blocked branch fills the optimistic assistant bubble with the placeholder text", () => {
    // The branch must (a) set gotAnyDelta=true so the finally{} rollback
    // doesn't fire, and (b) write IMAGE_BLOCKED_PLACEHOLDER_TEXT into the
    // last assistant message so the existing isImageBlocked styling kicks
    // in — same visual as the post-reload bubble.
    expect(mainApp).toMatch(
      /evt\.type === "image_blocked"[\s\S]{0,600}gotAnyDelta = true[\s\S]{0,400}text: IMAGE_BLOCKED_PLACEHOLDER_TEXT/,
    );
  });

  it("the image_blocked branch breaks BEFORE setting errorMsg (no red banner)", () => {
    // The break must come before the `errorMsg = evt.message` line so
    // the finally{} block doesn't surface a red error banner alongside
    // the styled amber bubble.
    expect(mainApp).toMatch(
      /evt\.type === "image_blocked"[\s\S]{0,800}break;[\s\S]{0,200}errorMsg = evt\.message/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Behavioural pin: the dispatcher emits image_blocked (not validation) on
// an NSFW deny, so the MainApp branch above is actually reached.
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
const finalizeBlockedSpy = vi.fn(async () => ({
  assistantMessageId: "amsg-blocked-1",
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
  finalizeOnDeviceImageGenBlockedTurn: finalizeBlockedSpy,
  releaseOnDeviceReservation: releaseSpy,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: { id: "test-user-1" } } }),
    },
    storage: {
      from: () => ({ upload: vi.fn(async () => ({ error: null, data: { path: "x" } })) }),
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

afterEach(() => {
  __setNsfwClassifierForTests(null);
  __resetNsfwClassifierCache();
});

describe("Task #52 — dispatcher emits image_blocked on NSFW deny", () => {
  beforeEach(() => {
    finalizeBlockedSpy.mockClear();
    __setNsfwClassifierForTests(async () => ({
      nsfw: true,
      topLabel: "nsfw",
      score: 0.95,
    }));
  });

  it("yields a single error event with type=image_blocked (not validation)", async () => {
    const { streamOnDevicePrivateImage } = await import(
      "@/lib/on-device-private-image"
    );
    const events: Array<{ kind: string; type?: string }> = [];
    for await (const ev of streamOnDevicePrivateImage({
      threadId: null,
      content: "draw something edgy",
      badge: "private",
    })) {
      events.push(ev as { kind: string; type?: string });
    }

    const errs = events.filter((e) => e.kind === "error");
    expect(errs.length).toBe(1);
    expect(errs[0]?.type).toBe("image_blocked");
    // No `validation` event of any kind on the deny path — so MainApp's
    // generic error path doesn't grab the turn first.
    expect(events.some((e) => e.kind === "error" && e.type === "validation")).toBe(false);
    // Server-side placeholder was persisted, so the live + post-reload
    // views are the same row.
    expect(finalizeBlockedSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Task #52 — chat-stream wire union accepts image_blocked", () => {
  it("the ChatStreamEvent error union includes image_blocked", () => {
    const stream = readFileSync(
      resolve(here, "../../src/lib/chat-stream.ts"),
      "utf8",
    );
    expect(stream).toMatch(/\|\s*"image_blocked"/);
    // The SSE parser's runtime allow-list must also include it so a
    // future server-emitted `image_blocked` SSE block isn't downgraded
    // to `internal`.
    expect(stream).toMatch(
      /validTypes = \[[^\]]*"image_blocked"[^\]]*\]/,
    );
  });
});
