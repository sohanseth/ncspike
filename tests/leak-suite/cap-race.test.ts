/**
 * Task #8 — race-proofness pin for the per-day chat usage cap.
 *
 * Before this task, `assertCap` did a read-then-write against
 * `inference_usage`: SELECT count, compare to cap, INSERT. Two concurrent
 * sends at the cap edge could both pass the SELECT and both INSERT,
 * over-spending by the number of racers.
 *
 * The fix moves the count-and-reserve into a single Postgres RPC
 * (`reserve_inference_slot`) that takes a per-(user, badge) advisory lock,
 * counts existing ok+pending rows for today inside the lock, and either
 * inserts a `pending` reservation or a `cap_exceeded` row in the same
 * transaction. Two concurrent calls therefore serialize on the lock and
 * exactly `cap` reservations succeed.
 *
 * This test pins that invariant by stubbing the RPC with an in-memory
 * implementation that simulates the lock-and-count semantics, then firing
 * many concurrent `assertCap` calls at the cap edge and asserting:
 *   - exactly `cap` succeeded (returned a usageId)
 *   - the rest threw `CapExceededError`
 *   - no caller saw an off-by-one (`used > cap` with accepted=true)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the supabase admin client BEFORE importing the module under test
// so the chat module captures the mocked rpc reference.
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
type LedgerRow = { id: string; status: "pending" | "ok" | "user_abort" | "error" | "rate_limited" };
const ledger: LedgerRow[] = [];
let nextId = 0;
let lockHeld = false;
const lockQueue: Array<() => void> = [];

function activeCount(): number {
  // Mirrors `reserve_inference_slot`: counts ok + pending toward the cap.
  return ledger.filter((r) => r.status === "ok" || r.status === "pending").length;
}
// Convenience for tests that pre-fill the ledger with finalized-ok rows.
function seedOk(n: number): void {
  for (let i = 0; i < n; i++) ledger.push({ id: `seed-${i}`, status: "ok" });
}
async function acquireLock(): Promise<void> {
  if (!lockHeld) {
    lockHeld = true;
    return;
  }
  await new Promise<void>((resolve) => lockQueue.push(resolve));
}
function releaseLock(): void {
  const next = lockQueue.shift();
  if (next) {
    next();
  } else {
    lockHeld = false;
  }
}

vi.mock("@/integrations/supabase/client.server", () => {
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "reserve_inference_slot") {
      await acquireLock();
      try {
        await new Promise((r) => setTimeout(r, 1));
        const used = activeCount();
        const cap = args.p_cap as number;
        if (used >= cap) {
          return {
            data: [{ usage_id: "00000000-0000-0000-0000-000000000000", used_count: used, accepted: false }],
            error: null,
          };
        }
        nextId += 1;
        const id = `usage-${nextId}`;
        ledger.push({ id, status: "pending" });
        return {
          data: [{ usage_id: id, used_count: activeCount(), accepted: true }],
          error: null,
        };
      } finally {
        releaseLock();
      }
    }
    if (name === "finalize_inference_usage") {
      const id = args.p_usage_id as string;
      const status = args.p_status as LedgerRow["status"];
      const row = ledger.find((r) => r.id === id);
      if (!row || row.status !== "pending") return { data: false, error: null };
      row.status = status;
      return { data: true, error: null };
    }
    if (name === "release_inference_slot") {
      const id = args.p_usage_id as string;
      const idx = ledger.findIndex((r) => r.id === id && r.status === "pending");
      if (idx === -1) return { data: false, error: null };
      ledger.splice(idx, 1);
      return { data: true, error: null };
    }
    throw new Error(`unexpected rpc: ${name}`);
  };
  return {
    supabaseAdmin: {
      rpc,
      from: () => {
        throw new Error("from() must not be reached when reserve_inference_slot succeeds");
      },
    },
  };
});

import {
  assertCap,
  CapExceededError,
  releaseReservedUsage,
  finalizeReservedUsage,
} from "@/server/inference/chat";

describe("assertCap race-proofness (task #8)", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    ledger.length = 0;
    nextId = 0;
    lockHeld = false;
    lockQueue.length = 0;
  });

  it("admits exactly `cap` of N concurrent racers at the cap edge", async () => {
    const cap = 20; // FREE_TIER_CAPS.flash
    const N = 50;

    const results = await Promise.allSettled(
      Array.from({ length: N }, () =>
        assertCap({
          userId: "user-1",
          threadId: null,
          badge: "flash",
          paidTier: false,
        }),
      ),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ usageId: string }> => r.status === "fulfilled",
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled.length).toBe(cap);
    expect(rejected.length).toBe(N - cap);

    // Every rejection is a typed CapExceededError carrying badge + cap.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(CapExceededError);
      expect((r.reason as CapExceededError).badge).toBe("flash");
      expect((r.reason as CapExceededError).cap).toBe(cap);
    }

    // Every winner got a unique reservation id — no double-issue.
    const ids = new Set(fulfilled.map((r) => r.value.usageId));
    expect(ids.size).toBe(cap);

    // The ledger now holds exactly `cap` pending rows (not over, not under).
    expect(activeCount()).toBe(cap);

    // The RPC was called exactly once per racer (no client-side retry).
    const reserveCalls = rpcCalls.filter((c) => c.name === "reserve_inference_slot");
    expect(reserveCalls.length).toBe(N);
  });

  it("admits exactly `cap` when starting partially full (boundary case)", async () => {
    // Pre-fill to cap-1 so the very next reservation is the last allowed
    // slot. Racing 10 callers must give exactly 1 winner.
    const cap = 20;
    seedOk(cap - 1);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        assertCap({
          userId: "user-2",
          threadId: null,
          badge: "flash",
          paidTier: false,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(9);
    expect(activeCount()).toBe(cap);
  });

  it("release-on-failure restores the slot for the next caller", async () => {
    // Pin the lifecycle invariant added after the architect's review:
    // every post-reservation early-exit path (broker scrub-block, vision
    // download failure, attachment ownership rejection, runChain throw,
    // …) MUST release the reservation so the slot is available for the
    // next request, instead of being held until the 5-min sweep.
    const cap = 20;
    seedOk(cap - 1); // one slot left

    // Caller A reserves the last slot.
    const a = await assertCap({
      userId: "user-3",
      threadId: null,
      badge: "flash",
      paidTier: false,
    });
    expect(activeCount()).toBe(cap);

    // Caller B at the cap edge — should be rejected.
    await expect(
      assertCap({ userId: "user-3", threadId: null, badge: "flash", paidTier: false }),
    ).rejects.toBeInstanceOf(CapExceededError);

    // A's downstream call fails (e.g., broker scrub blocks). The
    // production code calls releaseReservedUsage; replay that here.
    const released = await releaseReservedUsage(a.usageId, "user-3");
    expect(released).toBe(true);
    expect(activeCount()).toBe(cap - 1);

    // Caller C now succeeds — the slot is genuinely free again.
    const c = await assertCap({
      userId: "user-3",
      threadId: null,
      badge: "flash",
      paidTier: false,
    });
    expect(c.usageId).not.toBe(a.usageId);
    expect(activeCount()).toBe(cap);
  });

  it("release after finalize is a no-op (idempotent lifecycle)", async () => {
    // The wrapper try/catch in sendChatMessage / prepareOnDeviceTurn
    // releases on EVERY post-reservation throw, including throws after
    // runChain has already finalized the row to status='ok'. Pin that
    // a release on a non-pending row is a no-op and does NOT reopen the
    // slot to be re-spent.
    const cap = 20;
    seedOk(cap - 1);

    const a = await assertCap({
      userId: "user-4",
      threadId: null,
      badge: "flash",
      paidTier: false,
    });
    const finalized = await finalizeReservedUsage({
      usageId: a.usageId,
      userId: "user-4",
      status: "ok",
      providerUsed: "groq",
      modelUsed: "llama-3.1-8b-instant",
      fallbackDepth: 0,
      latencyMs: 100,
    });
    expect(finalized).toBe(true);
    expect(activeCount()).toBe(cap);

    // Now the wrapper catch fires (e.g., assistant-row insert failed
    // AFTER runChain returned). Release must be a no-op: the row is
    // already 'ok' and counted toward the cap.
    const released = await releaseReservedUsage(a.usageId, "user-4");
    expect(released).toBe(false);
    expect(activeCount()).toBe(cap);

    // Caller B is still blocked — releasing a finalized row did NOT
    // restore the slot, so the user is correctly debited.
    await expect(
      assertCap({ userId: "user-4", threadId: null, badge: "flash", paidTier: false }),
    ).rejects.toBeInstanceOf(CapExceededError);
  });
});
