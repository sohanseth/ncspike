/**
 * Task #32 — server-fn pin for `finalizeOnDeviceImageGenBlockedTurn`.
 *
 * docs/12 §15.4 says a flagged image must produce, in the chat thread,
 *   (a) a placeholder assistant `chat_messages` row with the exact copy
 *       "Image was generated but blocked by the on-device safety
 *       classifier. The image was not saved.", and
 *   (b) NO companion `chat_message_attachments` row (the bytes were
 *       discarded in memory by the dispatcher per §15.4 — they never
 *       touch the bucket, even the user's own), and
 *   (c) a `inference_usage` row carrying `metadata.image_blocked = true`
 *       so dashboards / retention sweeps can distinguish a blocked turn
 *       from a generic error without parsing `error_class`.
 *
 * The cap-side accounting is unchanged from the prior release-on-deny
 * path: the reservation is finalized to `status='error'`, and `error`
 * rows are excluded from the cap-counting query in
 * `reserve_inference_slot` — so the user is correctly NOT debited.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

// In-memory capture of every supabaseAdmin operation so we can assert
// "exactly one chat_messages insert, zero chat_message_attachments inserts,
// and an inference_usage row stamped with metadata.image_blocked=true".
type Capture = {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  match?: Record<string, unknown>;
};
const captured: Capture[] = [];
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let userMessageExists = true;
let assistantPlaceholderExists = false;

function tableBuilder(table: string) {
  const match: Record<string, unknown> = {};
  const builder = {
    select() {
      captured.push({ table, op: "select", match: { ...match } });
      return builder;
    },
    insert(payload: unknown) {
      captured.push({ table, op: "insert", payload, match: { ...match } });
      // chat_messages insert returns the generated row id.
      if (table === "chat_messages") {
        assistantPlaceholderExists = true;
        return {
          select: () => ({
            single: async () => ({ data: { id: "placeholder-1" }, error: null }),
          }),
        };
      }
      return Promise.resolve({ error: null, data: null });
    },
    update(payload: unknown) {
      captured.push({ table, op: "update", payload, match: { ...match } });
      const chain = {
        eq() {
          return chain;
        },
      };
      return chain as unknown as { eq: () => Promise<{ error: null }> };
    },
    eq(col: string, val: unknown) {
      match[col] = val;
      return builder;
    },
    match(m: Record<string, unknown>) {
      Object.assign(match, m);
      return builder;
    },
    async maybeSingle() {
      if (table === "chat_messages") {
        // Either the user-message lookup or the existing-assistant lookup.
        if (match.role === "assistant") {
          return assistantPlaceholderExists
            ? { data: { id: "placeholder-1" }, error: null }
            : { data: null, error: null };
        }
        return userMessageExists
          ? {
              data: {
                id: "msg-1",
                thread_id: "thread-1",
                user_id: "test-user-1",
              },
              error: null,
            }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    },
  };
  return builder;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => tableBuilder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      // finalize_inference_usage returns boolean (true = a pending row
      // was flipped). Mirror the production contract.
      return { data: true, error: null };
    },
  },
}));

// requireSupabaseAuth / attachSupabaseAuth aren't reached because the
// stubbed createServerFn skips middleware, but mock them anyway so
// importing chat.functions doesn't try to read real Supabase env.
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));
vi.mock("@/integrations/supabase/auth-client-middleware", () => ({
  attachSupabaseAuth: {},
}));

describe("Task #32 — finalizeOnDeviceImageGenBlockedTurn server-fn", () => {
  beforeEach(() => {
    captured.length = 0;
    rpcCalls.length = 0;
    userMessageExists = true;
    assistantPlaceholderExists = false;
  });

  it("writes exactly one placeholder chat_messages row, no attachment row, metadata.image_blocked=true", async () => {
    const {
      finalizeOnDeviceImageGenBlockedTurn,
      IMAGE_BLOCKED_PLACEHOLDER_TEXT,
    } = await import("@/lib/chat.functions");

    const res = await finalizeOnDeviceImageGenBlockedTurn({
      data: {
        threadId: "thread-1",
        userMessageId: "msg-1",
        reservedUsageId: "usage-1",
        adapter: "webgpu-sd-turbo",
        reason: "nsfw",
        contextUsed: null,
        traitSheetVersion: null,
      },
    });
    expect(res.assistantMessageId).toBe("placeholder-1");

    // (a) Exactly one chat_messages insert, with the §15.4 placeholder copy.
    const chatInserts = captured.filter(
      (c) => c.table === "chat_messages" && c.op === "insert",
    );
    expect(chatInserts).toHaveLength(1);
    const row = chatInserts[0].payload as Record<string, unknown>;
    expect(row.role).toBe("assistant");
    expect(row.content).toBe(IMAGE_BLOCKED_PLACEHOLDER_TEXT);
    expect(row.badge).toBe("private");
    expect(row.in_reply_to_id).toBe("msg-1");
    expect(row.thread_id).toBe("thread-1");
    expect(row.user_id).toBe("test-user-1");

    // (b) NO chat_message_attachments insert — flagged bytes never become
    // a row pointing at any storage object.
    const attInserts = captured.filter(
      (c) => c.table === "chat_message_attachments" && c.op === "insert",
    );
    expect(attInserts).toHaveLength(0);

    // (c) inference_usage update stamps metadata.image_blocked=true.
    const usageUpdates = captured.filter(
      (c) => c.table === "inference_usage" && c.op === "update",
    );
    expect(usageUpdates).toHaveLength(1);
    const meta = (usageUpdates[0].payload as { metadata: unknown }).metadata;
    // Task #51: the dispatcher now also stamps the structured verdict
    // category so the CPAUD admin surface can group blocked turns by
    // reason in addition to adapter.
    expect(meta).toEqual({
      image_blocked: true,
      image_blocked_reason: "nsfw",
    });

    // The reserved usage row was finalized to status='error' with
    // error_class='image_blocked'. `error` rows are excluded from the
    // cap-counting query, so the user is correctly NOT debited.
    const finalizeRpc = rpcCalls.find(
      (c) => c.name === "finalize_inference_usage",
    );
    expect(finalizeRpc).toBeDefined();
    expect(finalizeRpc?.args.p_status).toBe("error");
    expect(finalizeRpc?.args.p_error_class).toBe("image_blocked");
    expect(finalizeRpc?.args.p_usage_id).toBe("usage-1");
    expect(finalizeRpc?.args.p_message_id).toBe("placeholder-1");

    // No `release_inference_slot` call — finalize replaces release here.
    expect(rpcCalls.find((c) => c.name === "release_inference_slot")).toBeUndefined();
  });

  it("rejects when the user-message doesn't belong to the caller (IDOR guard)", async () => {
    userMessageExists = false;
    const { finalizeOnDeviceImageGenBlockedTurn } = await import(
      "@/lib/chat.functions"
    );
    await expect(
      finalizeOnDeviceImageGenBlockedTurn({
        data: {
          threadId: "thread-1",
          userMessageId: "msg-99",
          reservedUsageId: "usage-1",
          adapter: "webgpu-sd-turbo",
          reason: "nsfw",
          contextUsed: null,
          traitSheetVersion: null,
        },
      }),
    ).rejects.toThrow(/user message not found/i);

    // No chat_messages or inference_usage writes happened on the
    // reject path.
    expect(captured.some((c) => c.op === "insert")).toBe(false);
    expect(captured.some((c) => c.table === "inference_usage")).toBe(false);
  });

  it("rejects unknown adapter ids at the input validator", async () => {
    const { finalizeOnDeviceImageGenBlockedTurn } = await import(
      "@/lib/chat.functions"
    );
    // The stubbed createServerFn runs the validator synchronously when
    // building the handler args, so the throw surfaces as a sync error
    // rather than a rejected promise.
    expect(() =>
      finalizeOnDeviceImageGenBlockedTurn({
        data: {
          threadId: "thread-1",
          userMessageId: "msg-1",
          reservedUsageId: "usage-1",
          adapter: "hosted-dalle",
          reason: "nsfw",
          contextUsed: null,
          traitSheetVersion: null,
        },
      }),
    ).toThrow(/unknown adapter/i);
  });
});
