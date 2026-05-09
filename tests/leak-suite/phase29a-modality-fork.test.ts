/**
 * Phase 2.9a slice-a — chain-runner modality fork.
 *
 * Pins two invariants:
 *   1. Every shipping chain is `modality: 'text-out'` — slice a must NOT
 *      flip any badge to 'image-out'. Catches an accidental edit to
 *      `BADGE_CHAINS` that would brick text turns.
 *   2. When `chainFor()` is mocked to return an `'image-out'` chain, the
 *      runner throws `ImageOutNotAvailableError` BEFORE doing any
 *      side-effect (cap check, provider call, telemetry). This is the
 *      stub that slice b will replace with real adapters.
 *
 * No real DB, no real providers — pure unit test of the fork.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock router BEFORE importing chat.ts so the runner sees the override.
vi.mock("@/server/inference/router", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/inference/router")>(
      "@/server/inference/router",
    );
  return {
    ...actual,
    // Will be re-assigned per-test via chainForMock.mockReturnValue(...).
    chainFor: vi.fn(actual.chainFor),
  };
});

// Mock supabaseAdmin so a failed cap-check or telemetry write can't blow up
// the test if the fork is broken (we WANT the test to fail loud on a fork
// regression, not on a Supabase env-missing error).
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              gte: () => Promise.resolve({ count: 0, error: null }),
            }),
          }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
    }),
  },
}));

import {
  runChain,
  ImageOutNotAvailableError,
} from "@/server/inference/chat";
import {
  BADGE_CHAINS,
  chainFor,
  modalityFor,
  type Badge,
  type BadgeChain,
} from "@/server/inference/router";

describe("Phase 2.9a — chain modality", () => {
  beforeEach(() => {
    vi.mocked(chainFor).mockImplementation((b: Badge) => BADGE_CHAINS[b]);
  });

  it("every shipping chain is 'text-out' (slice-a invariant)", () => {
    for (const badge of ["flash", "pro", "genius", "private"] as const) {
      const cfg = BADGE_CHAINS[badge];
      expect(modalityFor(cfg)).toBe("text-out");
    }
  });

  it("modalityFor() defaults to 'text-out' when omitted", () => {
    const cfg: BadgeChain = {
      badge: "flash",
      label: "x",
      chain: ["groq"],
      paidOnly: false,
      failClosed: false,
      // modality intentionally omitted
    };
    expect(modalityFor(cfg)).toBe("text-out");
  });

  it("runChain throws IMAGE_OUT_NOT_AVAILABLE for image-out chains", async () => {
    vi.mocked(chainFor).mockReturnValueOnce({
      badge: "flash",
      label: "image stub",
      chain: ["groq"],
      paidOnly: false,
      failClosed: false,
      modality: "image-out",
    });
    await expect(
      runChain({
        userId: "00000000-0000-0000-0000-000000000000",
        threadId: null,
        badge: "flash",
        messages: [{ role: "user", content: "draw a cat" }],
        paidTier: false,
      }),
    ).rejects.toBeInstanceOf(ImageOutNotAvailableError);
  });

  it("image-out fork throws BEFORE the cap-check side effect", async () => {
    // If the fork were placed AFTER assertCap, a misrouted call would
    // write a `cap_exceeded` telemetry row even though no chain ever ran.
    // Spy on the supabase insert path: it must NOT be called when the
    // fork rejects.
    const insertSpy = vi.fn(() => Promise.resolve({ error: null }));
    const sb = (await import("@/integrations/supabase/client.server"))
      .supabaseAdmin as unknown as {
      from: (n: string) => {
        select: () => unknown;
        insert: (...a: unknown[]) => unknown;
      };
    };
    const origFrom = sb.from;
    sb.from = ((n: string) => {
      const real = origFrom(n);
      return { ...(real as object), insert: insertSpy } as ReturnType<
        typeof origFrom
      >;
    }) as typeof sb.from;

    vi.mocked(chainFor).mockReturnValueOnce({
      badge: "flash",
      label: "image stub",
      chain: ["groq"],
      paidOnly: false,
      failClosed: false,
      modality: "image-out",
    });
    await expect(
      runChain({
        userId: "00000000-0000-0000-0000-000000000000",
        threadId: null,
        badge: "flash",
        messages: [{ role: "user", content: "draw a cat" }],
        paidTier: false,
      }),
    ).rejects.toBeInstanceOf(ImageOutNotAvailableError);
    expect(insertSpy).not.toHaveBeenCalled();
    sb.from = origFrom;
  });
});
