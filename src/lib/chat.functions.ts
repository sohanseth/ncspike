/**
 * Chat server functions (D7 Day 2).
 *
 * The UI calls these via TanStack Start server functions. Auth is enforced via
 * the shared Supabase middleware; userId is read from JWT claims.
 *
 * Surface:
 *   listChatThreads()                → recent threads for the current user
 *   loadChatMessages({threadId})     → messages for a thread (oldest first)
 *   sendChatMessage({...})           → send a message and get an assistant reply
 *   createChatThread({title?})       → start a new thread
 *
 * The chain runner (`src/server/inference/chat.ts`) handles routing,
 * cap enforcement, fallbacks, and telemetry. This file is the thin glue.
 */
import { createServerFn } from "@tanstack/react-start";
import { scrubErrorMessage } from "@/lib/error-scrub";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runChain, CapExceededError, ChainExhaustedError, assertCap, finalizeReservedUsage, releaseReservedUsage } from "@/server/inference/chat";
import { chainFor, type Badge } from "@/server/inference/router";
import { resolveBadgeForUser } from "@/server/personalization-routing";
import { strictestTierInChain } from "@/lib/provider-tiers";
import type { InferenceMessage } from "@/server/inference";
import {
  assembleSystemPrompt,
  logContextDecision,
  type AssembleResult,
  type ContextUsed,
} from "@/server/context-broker";

const HISTORY_WINDOW = 20; // §G5 message-count cap; token cap arrives with D8.
const VALID_BADGES: readonly Badge[] = ["flash", "pro", "genius", "private"] as const;

function isBadge(x: unknown): x is Badge {
  return typeof x === "string" && (VALID_BADGES as readonly string[]).includes(x);
}

// ──────────────────────────────────────────────────────────────────────────────
// Threads
// ──────────────────────────────────────────────────────────────────────────────

export type ChatThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export const listChatThreads = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<ChatThreadSummary[]> => {
    const { data, error } = await supabaseAdmin
      .from("chat_threads")
      .select("id, title, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
    }));
  });

export const createChatThread = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { title?: string }) => d)
  .handler(async ({ data, context }): Promise<ChatThreadSummary> => {
    const title = (data.title ?? "New chat").slice(0, 120);
    const { data: row, error } = await supabaseAdmin
      .from("chat_threads")
      .insert({ user_id: context.userId, title })
      .select("id, title, updated_at")
      .single();
    if (error) throw error;
    return { id: row.id, title: row.title, updatedAt: row.updated_at };
  });

// ──────────────────────────────────────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────────────────────────────────────

export type ChatAttachmentPayload = {
  url: string;
  mime: string;
  storagePath: string;
};

export type ChatMessagePayload = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
  badge: Badge | null;
  provider: string | null;
  model: string | null;
  fallbackDepth: number | null;
  attachments: ChatAttachmentPayload[];
};

export const loadChatMessages = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { threadId: string }) => d)
  .handler(async ({ data, context }): Promise<ChatMessagePayload[]> => {
    const { data: rows, error } = await supabaseAdmin
      .from("chat_messages")
      .select("id, thread_id, role, content, created_at, badge, provider, model, fallback_depth")
      .eq("user_id", context.userId)
      .eq("thread_id", data.threadId)
      .order("created_at", { ascending: true })
      .limit(HISTORY_WINDOW);
    if (error) throw error;
    const messages = rows ?? [];

    // Fetch + sign all attachment URLs in one shot.
    const messageIds = messages.map((m) => m.id);
    const attachmentsByMessage = new Map<string, ChatAttachmentPayload[]>();
    if (messageIds.length > 0) {
      const { data: atts } = await supabaseAdmin
        .from("chat_message_attachments")
        .select("message_id, storage_path, mime")
        .in("message_id", messageIds);
      for (const a of atts ?? []) {
        const sign = await supabaseAdmin.storage
          .from("chat-attachments")
          .createSignedUrl(a.storage_path, 60 * 60 * 24);
        const url = sign.data?.signedUrl ?? "";
        if (!url) continue;
        const list = attachmentsByMessage.get(a.message_id) ?? [];
        list.push({ url, mime: a.mime, storagePath: a.storage_path });
        attachmentsByMessage.set(a.message_id, list);
      }
    }

    return messages.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      badge: isBadge(r.badge) ? r.badge : null,
      provider: r.provider,
      model: r.model,
      fallbackDepth: r.fallback_depth,
      attachments: attachmentsByMessage.get(r.id) ?? [],
    }));
  });

export type SendChatMessageInput = {
  threadId: string | null;
  content: string;
  badge: Badge;
};

export type SendChatMessageResult = {
  threadId: string;
  userMessage: ChatMessagePayload;
  assistantMessage: ChatMessagePayload;
};

export type SendChatMessageError = {
  kind: "cap_exceeded" | "chain_exhausted" | "validation" | "internal";
  message: string;
  /** Present for cap_exceeded. */
  badge?: Badge;
  used?: number;
  cap?: number;
  /** Present for chain_exhausted. */
  lastErrorClass?: string;
};

/** Look up paid-tier flag. Until subscription wiring lands, always false. */
async function getPaidTier(_userId: string): Promise<boolean> {
  return false;
}

export const sendChatMessage = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: SendChatMessageInput): SendChatMessageInput => {
    if (!d || typeof d !== "object") throw new Error("Invalid input");
    if (typeof d.content !== "string" || d.content.trim().length === 0) {
      throw new Error("Message content is required");
    }
    if (d.content.length > 8000) throw new Error("Message too long (max 8000 chars)");
    if (!isBadge(d.badge)) throw new Error("Invalid badge");
    if (d.threadId !== null && typeof d.threadId !== "string") {
      throw new Error("Invalid threadId");
    }
    return { threadId: d.threadId, content: d.content.trim(), badge: d.badge };
  })
  .handler(async ({ data, context }): Promise<SendChatMessageResult> => {
    const userId = context.userId;

    // 1. Resolve thread (create if missing). When the client supplies a
    //    threadId we MUST verify ownership — service-role bypasses RLS, so
    //    skipping this check would allow cross-tenant writes (IDOR).
    let threadId = data.threadId;
    if (threadId) {
      const { data: existing, error: oErr } = await supabaseAdmin
        .from("chat_threads")
        .select("id")
        .eq("id", threadId)
        .eq("user_id", userId)
        .maybeSingle();
      if (oErr) throw oErr;
      if (!existing) throw new Error("Thread not found");
    } else {
      const title = data.content.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
      const { data: t, error: tErr } = await supabaseAdmin
        .from("chat_threads")
        .insert({ user_id: userId, title })
        .select("id")
        .single();
      if (tErr) throw tErr;
      threadId = t.id;
    }

    // 2. Load history (oldest first), then trim to last HISTORY_WINDOW-1 so the
    //    new user message fits inside the window.
    const { data: history, error: hErr } = await supabaseAdmin
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_WINDOW - 1);
    if (hErr) throw hErr;

    const historyMessages: InferenceMessage[] = (history ?? [])
      .reverse()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // 3a. PRIVATE-only mode (B10/B11 — Strict preset). Resolve effective
    //     badge BEFORE any badge-tagged persistence so the audit trail
    //     reflects what actually ran, not what the UI clicked.
    const { badge: effectiveBadge } = await resolveBadgeForUser(userId, data.badge);

    // 3. Pre-flight cap + paidOnly check (spec §C6 ordering). Must happen
    //    BEFORE persisting the user row — otherwise a cap-blocked send leaves
    //    an orphan user bubble in the thread on next page load. assertCap
    //    writes the `cap_exceeded` usage row and throws CapExceededError,
    //    which the caller catches and surfaces as a Sonner toast.
    const paidTierForCap = await getPaidTier(userId);
    const { usageId: reservedUsageId } = await assertCap({
      userId,
      threadId,
      badge: effectiveBadge,
      paidTier: paidTierForCap,
    });

    // From here on, any thrown error must release the reserved cap slot —
    // otherwise the user is debited for a turn that never produced a
    // reply. The release RPC is idempotent (returns false on rows that
    // are no longer 'pending'), so calling it after a successful
    // finalize inside runChain is a safe no-op. (task #8)
    try {

    // 4. Persist the user message immediately so it survives chain failures.
    const { data: userRow, error: uErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        user_id: userId,
        thread_id: threadId,
        role: "user",
        content: data.content,
        badge: effectiveBadge,
      })
      .select("id, thread_id, role, content, created_at, badge, provider, model, fallback_depth")
      .single();
    if (uErr) throw uErr;

    // 4. Resolve chain + assemble personalization fragment (D8 step 5). Broker
    //    is best-effort — any failure falls back to the chain runner's
    //    DEFAULT_SYSTEM_PROMPT so chat never breaks on a broker bug.
    const cfg = chainFor(effectiveBadge);
    const tier = strictestTierInChain(cfg.chain);
    let broker: AssembleResult = {
      fragment: "",
      contextUsed: { categories: [], trait_paths: [] },
      scrubBlocked: false,
      traitSheetVersion: null,
    };
    try {
      broker = await assembleSystemPrompt({
        userId,
        query: data.content,
        badge: effectiveBadge,
        strictestTierInChain: tier,
      });
    } catch (e) {
      // Fail-CLOSED on any broker exception (architect 2026-05-09 finding
      // #2). The earlier behaviour swallowed the throw and proceeded with
      // the default prompt, which silently bypassed the privacy guard for
      // any throw-path failure (Supabase client throw, embed throw,
      // unexpected runtime). Surface the same typed error the scrub-block
      // path emits — the UI already handles SCRUB_BLOCKED:context.
      console.warn("[chat.sendChatMessage] broker threw, fail-closing:", e instanceof Error ? e.name : "Error");
      throw new Error("SCRUB_BLOCKED:context");
    }

    // Fail-closed when the broker scrub blocks the assembled fragment. The
    // prior behavior silently swapped to the default system prompt and let
    // inference proceed, masking what is supposed to be a privacy guard
    // event. Surface as a typed error the client can render — the outer
    // try/catch below releases the reserved cap slot.
    if (broker.scrubBlocked) {
      throw new Error("SCRUB_BLOCKED:context");
    }

    // 5. Run the chain. CapExceededError and ChainExhaustedError surface to
    //    the caller as typed errors — UI shows a friendly upsell or retry.
    //    Re-uses paidTierForCap from step 3 to avoid a second auth lookup.
    //    The reservedUsageId from step 3 is threaded through so the chain
    //    runner finalizes the existing pending row (race-proof cap
    //    accounting) rather than inserting a new ok row.
    const result = await runChain({
      userId,
      threadId,
      badge: effectiveBadge,
      messages: [...historyMessages, { role: "user", content: data.content }],
      paidTier: paidTierForCap,
      systemPrompt: broker.fragment || undefined,
      assumeCapChecked: true,
      reservedUsageId,
    });

    // 6. Persist the assistant reply with routing breadcrumb + context audit.
    const { data: aRow, error: aErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        user_id: userId,
        thread_id: threadId,
        role: "assistant",
        content: result.text,
        badge: effectiveBadge,
        provider: result.provider,
        model: result.model,
        fallback_depth: result.fallbackDepth,
        context_used: broker.contextUsed.categories.length > 0 ? broker.contextUsed : null,
        trait_sheet_version: broker.traitSheetVersion,
      } as never)
      .select("id, thread_id, role, content, created_at, badge, provider, model, fallback_depth")
      .single();
    if (aErr) throw aErr;

    // 6a. Step 8a — chat_context_log row, AFTER assistant message persistence
    //     so the message_id FK target exists. Best-effort, non-blocking.
    await logContextDecision({
      userId,
      messageId: aRow.id,
      badge: effectiveBadge,
      strictestTier: tier,
      contextUsed: broker.contextUsed,
      fragmentLength: broker.fragment.length,
      scrubBlocked: broker.scrubBlocked,
      traitSheetVersion: broker.traitSheetVersion,
    });

    // 6. Touch the thread's updated_at so it floats to the top of the list.
    await supabaseAdmin
      .from("chat_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", threadId)
      .eq("user_id", userId);

    const toPayload = (r: typeof userRow): ChatMessagePayload => ({
      id: r.id,
      threadId: r.thread_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      badge: isBadge(r.badge) ? r.badge : null,
      provider: r.provider,
      model: r.model,
      fallbackDepth: r.fallback_depth,
      attachments: [],
    });

    return {
      threadId,
      userMessage: toPayload(userRow),
      assistantMessage: toPayload(aRow),
    };

    } catch (e) {
      // Release the reserved cap slot on any post-reservation failure
      // (user-row persist error, broker scrub-block, runChain throw,
      // assistant persist error). Idempotent: a no-op if runChain already
      // finalized the row to status='ok'. (task #8)
      await releaseReservedUsage(reservedUsageId, userId).catch(() => {});
      throw e;
    }
  });

// Note: typed errors (CapExceededError, ChainExhaustedError) are not re-exported
// here — re-exporting them as top-level values would force the client bundle to
// pull in @/server/inference/chat (a server-only module) and trip the
// import-protection plugin. Server code should import them directly from
// "@/server/inference/chat".

// ──────────────────────────────────────────────────────────────────────────────
// On-device path (Phase 2.8 — see docs/11-spec-on-device-tier.md).
//
// The PRIVATE badge runs entirely on the user's device. The chain runner
// CANNOT execute on-device adapters (defense-in-depth in chat.ts asserts
// this), so the client uses the two server-fns below instead of the SSE
// /api/chat/stream route used by hosted tiers:
//
//   prepareOnDeviceTurn  — cap-check + user-row persist + tier-(-1) broker.
//                          Returns the system prompt, history, and ids the
//                          client needs to run generation locally.
//   finalizeOnDeviceTurn — assistant-row persist + zero-cost telemetry +
//                          chat_context_log audit. Verifies ownership of
//                          the thread + user-message before writing.
//
// Errors that the on-device-chat dispatcher is expected to handle:
//   "CAP_EXCEEDED:<used>|<cap>"  — daily cap reached for the user.
//   "Thread not found"           — IDOR / stale state on the client.
//   "User message not found"     — client called finalize without prepare.
// ──────────────────────────────────────────────────────────────────────────────

export type PrepareOnDeviceTurnInput = {
  threadId: string | null;
  content: string;
};

export type PrepareOnDeviceTurnResult = {
  threadId: string;
  userMessageId: string;
  /** Reserved (pending) `inference_usage.id` from the atomic cap RPC.
   *  Must be passed to `finalizeOnDeviceTurn` so the slot is finalized
   *  to status='ok' (or released if the on-device run fails). Without
   *  this handoff the row would stay pending until the 5-min sweep and
   *  double-count against the user's daily cap. See task #8. */
  reservedUsageId: string;
  systemPrompt: string;
  history: { role: "user" | "assistant"; content: string }[];
  contextUsed: { categories: string[]; trait_paths: string[] } | null;
  traitSheetVersion: number | null;
};

export const prepareOnDeviceTurn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: PrepareOnDeviceTurnInput): PrepareOnDeviceTurnInput => {
    if (!d || typeof d !== "object") throw new Error("Invalid input");
    if (typeof d.content !== "string" || d.content.trim().length === 0) {
      throw new Error("Message content is required");
    }
    if (d.content.length > 8000) throw new Error("Message too long (max 8000 chars)");
    if (d.threadId !== null && typeof d.threadId !== "string") {
      throw new Error("Invalid threadId");
    }
    return { threadId: d.threadId, content: d.content.trim() };
  })
  .handler(async ({ data, context }): Promise<PrepareOnDeviceTurnResult> => {
    const userId = context.userId;
    const badge: Badge = "private";

    // 1. Resolve thread + ownership check (mirrors sendChatMessage).
    let threadId = data.threadId;
    if (threadId) {
      const { data: existing, error: oErr } = await supabaseAdmin
        .from("chat_threads")
        .select("id")
        .eq("id", threadId)
        .eq("user_id", userId)
        .maybeSingle();
      if (oErr) throw oErr;
      if (!existing) throw new Error("Thread not found");
    } else {
      const title = data.content.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
      const { data: t, error: tErr } = await supabaseAdmin
        .from("chat_threads")
        .insert({ user_id: userId, title })
        .select("id")
        .single();
      if (tErr) throw tErr;
      threadId = t.id;
    }

    // 2. Cap check BEFORE persisting the user row. Convert CapExceededError
    //    into a structured error string the on-device dispatcher parses
    //    into a typed `cap_exceeded` event. The atomic reservation is
    //    threaded out via reservedUsageId so finalizeOnDeviceTurn can
    //    flip the same row to status='ok' (race-proof — task #8).
    const paidTier = await getPaidTier(userId);
    let reservedUsageId: string;
    try {
      const r = await assertCap({ userId, threadId, badge, paidTier });
      reservedUsageId = r.usageId;
    } catch (e) {
      if (e instanceof CapExceededError) {
        throw new Error(`CAP_EXCEEDED:${e.used}|${e.cap}`);
      }
      throw e;
    }

    // From here on, any thrown error must release the reserved cap slot
    // — the user shouldn't be debited for a turn that never produces an
    // assistant reply. (task #8)
    try {

    // 3. Persist the user message.
    const { data: userRow, error: uErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        user_id: userId,
        thread_id: threadId,
        role: "user",
        content: data.content,
        badge,
      })
      .select("id")
      .single();
    if (uErr) throw uErr;

    // 4. Load history for context.
    const { data: history, error: hErr } = await supabaseAdmin
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .eq("thread_id", threadId)
      .neq("id", userRow.id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_WINDOW - 1);
    if (hErr) throw hErr;

    const historyMessages = (history ?? [])
      .reverse()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // 5. Broker at tier -1 (full personalization since data never leaves
    //    the device). Best-effort; default to empty system prompt on failure.
    let broker: AssembleResult = {
      fragment: "",
      contextUsed: { categories: [], trait_paths: [] },
      scrubBlocked: false,
      traitSheetVersion: null,
    };
    try {
      broker = await assembleSystemPrompt({
        userId,
        query: data.content,
        badge,
        strictestTierInChain: -1,
      });
    } catch (e) {
      // Fail-CLOSED on any broker exception. Even though tier=-1 means data
      // never leaves the device, consistency with the hosted path matters:
      // a broker throw here masks privacy-guard state, so refuse rather
      // than silently default-prompt.
      console.warn("[prepareOnDeviceTurn] broker threw, fail-closing:", e instanceof Error ? e.name : "Error");
      throw new Error("SCRUB_BLOCKED:context");
    }

    // Fail-closed on scrub-block, same as the hosted path. The outer
    // try/catch below releases the reserved cap slot since no on-device
    // generation will run.
    if (broker.scrubBlocked) {
      throw new Error("SCRUB_BLOCKED:context");
    }

    return {
      threadId,
      userMessageId: userRow.id,
      reservedUsageId,
      systemPrompt:
        broker.fragment ||
        "You are a helpful assistant running on the user's own device. Keep replies concise and practical.",
      history: historyMessages,
      contextUsed:
        broker.contextUsed.categories.length > 0 ? broker.contextUsed : null,
      traitSheetVersion: broker.traitSheetVersion,
    };

    } catch (e) {
      // Release the reserved cap slot on any post-reservation failure
      // (user-row persist, history load, broker scrub-block). The
      // on-device runner only sees the reservedUsageId on the success
      // path, so a throw here means it never gets a chance to release
      // it itself. (task #8)
      await releaseReservedUsage(reservedUsageId, userId).catch(() => {});
      throw e;
    }
  });

/**
 * Release a reserved (pending) `inference_usage` row when the on-device
 * runner produces no reply (capability errored, user cancelled, empty
 * stream). Mirrors the chain runner's release-on-failure path so the
 * user is not debited for a turn that never completed. See task #8.
 */
export const releaseOnDeviceReservation = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { reservedUsageId: string }) => {
    if (!d || typeof d !== "object" || typeof d.reservedUsageId !== "string") {
      throw new Error("reservedUsageId required");
    }
    return d;
  })
  .handler(async ({ data, context }): Promise<{ released: boolean }> => {
    const released = await releaseReservedUsage(data.reservedUsageId, context.userId);
    return { released };
  });

export type FinalizeOnDeviceTurnInput = {
  threadId: string;
  userMessageId: string;
  /** Reserved (pending) `inference_usage.id` returned from prepareOnDeviceTurn.
   *  Required so finalize flips the SAME row to status='ok' (race-proof
   *  cap accounting — task #8). */
  reservedUsageId: string;
  assistantText: string;
  provider: "onDeviceApple" | "onDeviceAndroid" | "onDeviceWebLLM";
  model: string;
  contextUsed: { categories: string[]; trait_paths: string[] } | null;
  traitSheetVersion: number | null;
};

export type FinalizeOnDeviceTurnResult = {
  assistantMessageId: string;
};

const ON_DEVICE_PROVIDER_IDS = new Set([
  "onDeviceApple",
  "onDeviceAndroid",
  "onDeviceWebLLM",
]);

export const finalizeOnDeviceTurn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: FinalizeOnDeviceTurnInput): FinalizeOnDeviceTurnInput => {
    if (!d || typeof d !== "object") throw new Error("Invalid input");
    if (typeof d.threadId !== "string") throw new Error("threadId required");
    if (typeof d.userMessageId !== "string") throw new Error("userMessageId required");
    if (typeof d.reservedUsageId !== "string") throw new Error("reservedUsageId required");
    if (typeof d.assistantText !== "string" || d.assistantText.length === 0) {
      throw new Error("assistantText required");
    }
    if (d.assistantText.length > 100_000) {
      throw new Error("assistantText too long (max 100000 chars)");
    }
    if (!ON_DEVICE_PROVIDER_IDS.has(d.provider)) {
      throw new Error("Invalid on-device provider");
    }
    if (typeof d.model !== "string") throw new Error("model required");
    return d;
  })
  .handler(async ({ data, context }): Promise<FinalizeOnDeviceTurnResult> => {
    const userId = context.userId;
    const badge: Badge = "private";

    // Verify thread ownership AND that the user message belongs to it. This
    // closes IDOR (a malicious client could otherwise stuff replies into
    // another user's thread).
    const { data: userMsg, error: umErr } = await supabaseAdmin
      .from("chat_messages")
      .select("id, thread_id, user_id")
      .eq("id", data.userMessageId)
      .eq("user_id", userId)
      .eq("thread_id", data.threadId)
      .maybeSingle();
    if (umErr) throw umErr;
    if (!userMsg) throw new Error("User message not found");

    // Idempotency check (migration 20260515 — adds `in_reply_to_id`). If a
    // prior finalize call already wrote an assistant row for this user
    // message, return it instead of writing a duplicate. The unique partial
    // index on `chat_messages(in_reply_to_id)` is the authoritative guard
    // against races; this lookup is the fast path.
    const { data: existingAssistant } = await supabaseAdmin
      .from("chat_messages")
      .select("id")
      .match({ user_id: userId, thread_id: data.threadId, role: "assistant" } as never)
      .eq("in_reply_to_id" as never, data.userMessageId as never)
      .maybeSingle();
    if (existingAssistant) {
      // Best-effort finalize even on the idempotency fast-path. Crash-window
      // case: a prior call inserted the assistant row but crashed before
      // calling finalizeReservedUsage, leaving the reservation 'pending'.
      // The retry comes through here. Without this nudge, the pending row
      // would linger until the 5-min sweep, after which the successful
      // turn would be undercounted against the daily cap. The RPC is
      // idempotent (returns false if already finalized/swept), so this is
      // safe in the common case where the prior call DID finalize.
      await finalizeReservedUsage({
        usageId: data.reservedUsageId,
        userId,
        status: "ok",
        providerUsed: data.provider,
        modelUsed: data.model,
        fallbackDepth: 0,
        latencyMs: 0,
        messageId: existingAssistant.id,
      }).catch(() => {
        // Telemetry-only — never fail the user-visible idempotent return
        // on a finalize hiccup. The 5-min sweep is the backstop.
      });
      return { assistantMessageId: existingAssistant.id };
    }

    // Persist assistant row, linked to the user message via in_reply_to_id.
    // On unique-index violation (concurrent finalize), the catch path
    // re-fetches and returns the winning row — preserving idempotency
    // under races.
    const { data: aRow, error: aErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        user_id: userId,
        thread_id: data.threadId,
        role: "assistant",
        content: data.assistantText,
        badge,
        provider: data.provider,
        model: data.model,
        fallback_depth: 0,
        context_used:
          data.contextUsed && data.contextUsed.categories.length > 0
            ? data.contextUsed
            : null,
        trait_sheet_version: data.traitSheetVersion,
        in_reply_to_id: data.userMessageId,
      } as never)
      .select("id")
      .single();
    if (aErr) {
      // Postgres unique_violation on the partial index = concurrent
      // finalize won. Re-fetch and return the winner.
      const code = (aErr as { code?: string }).code;
      if (code === "23505") {
        const { data: winner } = await supabaseAdmin
          .from("chat_messages")
          .select("id")
          .eq("in_reply_to_id" as never, data.userMessageId as never)
          .maybeSingle();
        if (winner) return { assistantMessageId: winner.id };
      }
      throw aErr;
    }

    // Finalize the reserved (pending) usage row created by
    // prepareOnDeviceTurn. Race-proof: the same row that booked a slot
    // against the daily cap is now flipped to status='ok' with the
    // assistant message id attached. Idempotent: a duplicate finalize
    // call returns false (no pending row) and the existing-assistant
    // fast path above already returned the winning message id, so we
    // never write a second telemetry row.
    const finalized = await finalizeReservedUsage({
      usageId: data.reservedUsageId,
      userId,
      status: "ok",
      providerUsed: data.provider,
      modelUsed: data.model,
      fallbackDepth: 0,
      latencyMs: 0,
      messageId: aRow.id,
    });
    if (!finalized) {
      // Reservation was already finalized or swept. The assistant row was
      // still written (we got past the existing-assistant guard), so the
      // request is well-formed; just note it for telemetry.
      console.warn(
        `[finalizeOnDeviceTurn] reservation ${data.reservedUsageId} no longer pending (already finalized or swept)`,
      );
    }

    // Broker audit row. The `contextUsed` shape was hand-crafted on the
    // client; cast back to `ContextUsed` (categories are runtime-validated
    // against TraitCategory by the broker schema, but the server-fn
    // boundary erases the enum to string[]).
    await logContextDecision({
      userId,
      messageId: aRow.id,
      badge,
      strictestTier: -1,
      contextUsed: (data.contextUsed ?? { categories: [], trait_paths: [] }) as ContextUsed,
      fragmentLength: 0,
      scrubBlocked: false,
      traitSheetVersion: data.traitSheetVersion,
    });

    await supabaseAdmin
      .from("chat_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", data.threadId)
      .eq("user_id", userId);

    return { assistantMessageId: aRow.id };
  });

// ──────────────────────────────────────────────────────────────────────────────
// On-device IMAGE generation finalize (Phase 2.9b — see docs/12 §15.3).
//
// Mirrors finalizeOnDeviceTurn but additionally:
//   - inserts a `chat_message_attachments` row with `attachment_kind='image_out'`
//     (set by phase-29a migration 20260518000000) pointing at the
//     storage path the client uploaded to under {userId}/imagegen/.
//   - returns a fresh signed URL the client uses to render the bubble
//     without a separate round-trip.
//
// The bytes themselves are uploaded by the client via supabase.storage
// (user-token / RLS), NOT through this fn — keeping the on-device path
// faithful to its name (no image bytes ever transit the server). This fn
// only handles persistence + telemetry.
//
// IDOR defense: the storage path MUST start with `${userId}/` (every
// chat-attachments object lives under that prefix per the bucket policy).
// A crafted client passing another user's path is rejected before the
// attachment row would ever be written.
// ──────────────────────────────────────────────────────────────────────────────

const IMAGE_GEN_ADAPTERS = new Set([
  "webgpu-sd-turbo",
  "webgpu-sdxl",
  "webgpu-sd15",
  "webgpu-janus-1b",
  "apple-ip",
  "mediapipe",
  // Slice c — img2img edit adapters.
  "webgpu-sdxl-ip2p",
  "webgpu-sd15-controlnet",
]);

const ALLOWED_IMAGE_OUT_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** Map adapter id → telemetry provider id. The provider id lands in
 *  `inference_usage.provider_used` so dashboards can split the cost-zero
 *  on-device image rows from hosted image-gen rows. */
function adapterToProvider(
  adapter: string,
): "onDeviceWebGpuImage" | "onDeviceAppleImage" | "onDeviceAndroidImage" {
  if (adapter === "apple-ip") return "onDeviceAppleImage";
  if (adapter === "mediapipe") return "onDeviceAndroidImage";
  return "onDeviceWebGpuImage";
}

export type FinalizeOnDeviceImageGenTurnInput = {
  threadId: string;
  userMessageId: string;
  reservedUsageId: string;
  /** Caption text persisted as the assistant message body (chat_messages.content
   *  is NOT NULL). The image bytes themselves render via the attachment row;
   *  the caption is what shows above the thumbnail. */
  caption: string;
  /** Path inside the chat-attachments bucket, ALREADY uploaded by the
   *  client. Must start with `${userId}/` — defense-in-depth against IDOR. */
  storagePath: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  /** Adapter id the on-device runner used. Mapped to a provider id for
   *  telemetry; kept as the model name so dashboards can split per adapter. */
  adapter: string;
  contextUsed: { categories: string[]; trait_paths: string[] } | null;
  traitSheetVersion: number | null;
};

export type FinalizeOnDeviceImageGenTurnResult = {
  assistantMessageId: string;
  /** 24-hour signed URL for the just-persisted attachment so the UI can
   *  render the thumbnail immediately without re-fetching the thread. */
  signedUrl: string;
};

// ──────────────────────────────────────────────────────────────────────────────
// On-device IMAGE generation BLOCKED finalize (Phase 2.9b — task #32,
// docs/12 §15.4).
//
// Companion to `finalizeOnDeviceImageGenTurn` for the deny-verdict path:
// the on-device safety classifier flagged the bytes (or a structural
// guard refused them), so the dispatcher discards the bytes in memory,
// NEVER uploads them to chat-attachments, and calls THIS fn instead of
// `releaseOnDeviceReservation`. The release path returned the cap slot
// silently; this path leaves a visible audit trail:
//
//   1. A placeholder assistant `chat_messages` row with the §15.4 copy
//      so the user sees, on scroll-back, "the image was blocked and not
//      saved" instead of an unexplained gap after their prompt.
//   2. The reserved (pending) `inference_usage` row is finalized to
//      status='error', error_class='image_blocked' — `error` rows do
//      NOT count toward the daily cap (see reserve_inference_slot:
//      `where status in ('ok','pending')`), so the user is correctly
//      not debited, same as the old release path.
//   3. `metadata.image_blocked = true` is written to the same
//      `inference_usage` row (column added in migration
//      20260517000200_phase29b_inference_usage_metadata.sql) so
//      dashboards and the retention sweep can distinguish blocked turns
//      from generic errors without parsing `error_class`.
//
// IDOR defenses mirror finalizeOnDeviceImageGenTurn: thread + user-message
// ownership is verified by hand because service-role bypasses RLS.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Task #51 — closed-set of structured reason categories the on-device
 * dispatcher can attach to a blocked image turn. Mirrors
 * `ImageSafetyReason` in `imagegen-safety.ts`; duplicated here so the
 * server-fn input validator stays self-contained (no client-only
 * imports leaking into the server bundle). Adding a new category is a
 * deliberate change in BOTH files.
 */
export const IMAGE_BLOCKED_REASONS = [
  "nsfw",
  "classifier_unavailable",
  "invalid_image",
  "other",
] as const;
export type ImageBlockedReason = (typeof IMAGE_BLOCKED_REASONS)[number];

export type FinalizeOnDeviceImageGenBlockedTurnInput = {
  threadId: string;
  userMessageId: string;
  reservedUsageId: string;
  /** Adapter id the on-device runner used (or attempted to use). Recorded
   *  on the telemetry row as `model_used` so dashboards can split which
   *  adapter is producing the most blocked verdicts. Validated against
   *  the same allow-list as the success path. */
  adapter: string;
  /** Task #51: the structured classifier verdict category that caused
   *  the block (`nsfw`, `classifier_unavailable`, `invalid_image`,
   *  `other`). Persisted to `inference_usage.metadata.image_blocked_reason`
   *  so the CPAUD admin surface can group refusals by what triggered
   *  them, not just by adapter. */
  reason: ImageBlockedReason;
  contextUsed: { categories: string[]; trait_paths: string[] } | null;
  traitSheetVersion: number | null;
};

export type FinalizeOnDeviceImageGenBlockedTurnResult = {
  assistantMessageId: string;
};

// Re-exported from a small client-safe module so the chat UI can detect
// the placeholder without pulling this server-fn module into the browser
// bundle. The string literal lives in `./chat-message-kinds` now;
// keeping the named export here preserves the leak-suite import path.
import { IMAGE_BLOCKED_PLACEHOLDER_TEXT } from "./chat-message-kinds";
export { IMAGE_BLOCKED_PLACEHOLDER_TEXT };

export const finalizeOnDeviceImageGenBlockedTurn = createServerFn({
  method: "POST",
})
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (
      d: FinalizeOnDeviceImageGenBlockedTurnInput,
    ): FinalizeOnDeviceImageGenBlockedTurnInput => {
      if (!d || typeof d !== "object") throw new Error("Invalid input");
      if (typeof d.threadId !== "string") throw new Error("threadId required");
      if (typeof d.userMessageId !== "string") {
        throw new Error("userMessageId required");
      }
      if (typeof d.reservedUsageId !== "string") {
        throw new Error("reservedUsageId required");
      }
      if (!IMAGE_GEN_ADAPTERS.has(d.adapter)) {
        throw new Error(`Unknown adapter "${d.adapter}"`);
      }
      if (!IMAGE_BLOCKED_REASONS.includes(d.reason as ImageBlockedReason)) {
        throw new Error(`Unknown reason "${d.reason}"`);
      }
      return d;
    },
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<FinalizeOnDeviceImageGenBlockedTurnResult> => {
      const userId = context.userId;
      const badge: Badge = "private";
      const provider = adapterToProvider(data.adapter);

      // IDOR guard: thread + user-message ownership.
      const { data: userMsg, error: umErr } = await supabaseAdmin
        .from("chat_messages")
        .select("id, thread_id, user_id")
        .eq("id", data.userMessageId)
        .eq("user_id", userId)
        .eq("thread_id", data.threadId)
        .maybeSingle();
      if (umErr) throw umErr;
      if (!userMsg) throw new Error("User message not found");

      // Idempotency fast path: if a prior call already wrote the
      // placeholder for this user message (same in_reply_to_id unique
      // partial index used by the success path), return it.
      const { data: existingAssistant } = await supabaseAdmin
        .from("chat_messages")
        .select("id")
        .match({
          user_id: userId,
          thread_id: data.threadId,
          role: "assistant",
        } as never)
        .eq("in_reply_to_id" as never, data.userMessageId as never)
        .maybeSingle();
      if (existingAssistant) {
        // Best-effort finalize — same crash-window rationale as the
        // success path: a prior call may have written the placeholder
        // but crashed before finalizing the reservation. RPC is
        // idempotent (returns false on a non-pending row).
        await finalizeReservedUsage({
          usageId: data.reservedUsageId,
          userId,
          status: "error",
          providerUsed: provider,
          modelUsed: data.adapter,
          fallbackDepth: 0,
          latencyMs: 0,
          errorClass: "image_blocked",
          messageId: existingAssistant.id,
        }).catch(() => {});
        await supabaseAdmin
          .from("inference_usage")
          .update({
            metadata: {
              image_blocked: true,
              image_blocked_reason: data.reason,
            },
          } as never)
          .eq("id", data.reservedUsageId)
          .eq("user_id", userId);
        return { assistantMessageId: existingAssistant.id };
      }

      // Persist the placeholder assistant row. NO companion attachment
      // row — the bytes were discarded in memory by the dispatcher and
      // the §15.4 invariant is "flagged bytes never touch the bucket,
      // not even the user's own".
      const { data: aRow, error: aErr } = await supabaseAdmin
        .from("chat_messages")
        .insert({
          user_id: userId,
          thread_id: data.threadId,
          role: "assistant",
          content: IMAGE_BLOCKED_PLACEHOLDER_TEXT,
          badge,
          provider,
          model: data.adapter,
          fallback_depth: 0,
          context_used:
            data.contextUsed && data.contextUsed.categories.length > 0
              ? data.contextUsed
              : null,
          trait_sheet_version: data.traitSheetVersion,
          in_reply_to_id: data.userMessageId,
        } as never)
        .select("id")
        .single();
      if (aErr) {
        // Concurrent finalize won the unique partial index race —
        // re-fetch the winner and return it.
        const code = (aErr as { code?: string }).code;
        if (code === "23505") {
          const { data: winner } = await supabaseAdmin
            .from("chat_messages")
            .select("id")
            .eq("in_reply_to_id" as never, data.userMessageId as never)
            .maybeSingle();
          if (winner) return { assistantMessageId: winner.id };
        }
        throw aErr;
      }

      // Finalize the reserved usage row to status='error' with
      // error_class='image_blocked'. `error` rows are excluded from the
      // cap-counting query (reserve_inference_slot only counts ok+pending),
      // so the user is not debited for the blocked turn — same effective
      // accounting as the prior `releaseReservedUsage` path, but with a
      // visible telemetry trail.
      const finalized = await finalizeReservedUsage({
        usageId: data.reservedUsageId,
        userId,
        status: "error",
        providerUsed: provider,
        modelUsed: data.adapter,
        fallbackDepth: 0,
        latencyMs: 0,
        errorClass: "image_blocked",
        messageId: aRow.id,
      });
      if (!finalized) {
        console.warn(
          `[finalizeOnDeviceImageGenBlockedTurn] reservation ${data.reservedUsageId} no longer pending`,
        );
      }

      // Stamp `metadata.image_blocked = true`. Done as a separate
      // direct update (gated by user_id) rather than extending the RPC
      // signature — keeps the existing finalize_inference_usage contract
      // stable for hosted-tier callers. Service-role bypasses RLS so the
      // explicit user_id filter is the authorization check.
      const { error: metaErr } = await supabaseAdmin
        .from("inference_usage")
        .update({
          metadata: {
            image_blocked: true,
            // Task #51: structured verdict category — `nsfw`,
            // `classifier_unavailable`, `invalid_image`, or `other`.
            // Lets the CPAUD admin surface group blocked turns by
            // reason in addition to adapter so ops can tell whether
            // refusals are coming from the NSFW gate vs structural
            // checks vs a degraded classifier.
            image_blocked_reason: data.reason,
          },
        } as never)
        .eq("id", data.reservedUsageId)
        .eq("user_id", userId);
      if (metaErr) {
        // Telemetry is non-blocking — the placeholder is already in the
        // thread and the cap slot is correctly returned. Log and move on.
        console.warn(
          "[finalizeOnDeviceImageGenBlockedTurn] metadata stamp failed:",
          scrubErrorMessage(metaErr.message),
        );
      }

      // Broker audit row for parity with the success path.
      await logContextDecision({
        userId,
        messageId: aRow.id,
        badge,
        strictestTier: -1,
        contextUsed: (data.contextUsed ?? {
          categories: [],
          trait_paths: [],
        }) as ContextUsed,
        fragmentLength: 0,
        scrubBlocked: false,
        traitSheetVersion: data.traitSheetVersion,
      });

      await supabaseAdmin
        .from("chat_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", data.threadId)
        .eq("user_id", userId);

      return { assistantMessageId: aRow.id };
    },
  );

export const finalizeOnDeviceImageGenTurn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: FinalizeOnDeviceImageGenTurnInput): FinalizeOnDeviceImageGenTurnInput => {
      if (!d || typeof d !== "object") throw new Error("Invalid input");
      if (typeof d.threadId !== "string") throw new Error("threadId required");
      if (typeof d.userMessageId !== "string") {
        throw new Error("userMessageId required");
      }
      if (typeof d.reservedUsageId !== "string") {
        throw new Error("reservedUsageId required");
      }
      if (typeof d.caption !== "string" || d.caption.length === 0) {
        throw new Error("caption required");
      }
      if (d.caption.length > 1000) {
        throw new Error("caption too long (max 1000 chars)");
      }
      if (typeof d.storagePath !== "string" || d.storagePath.length === 0) {
        throw new Error("storagePath required");
      }
      if (d.storagePath.length > 512) throw new Error("storagePath too long");
      if (!ALLOWED_IMAGE_OUT_MIMES.has(d.mime)) {
        throw new Error(`Unsupported image mime "${d.mime}"`);
      }
      if (!Number.isFinite(d.bytes) || d.bytes <= 0 || d.bytes > 25 * 1024 * 1024) {
        throw new Error("Invalid byte size");
      }
      if (!Number.isFinite(d.width) || !Number.isFinite(d.height)) {
        throw new Error("width/height must be numbers");
      }
      if (!IMAGE_GEN_ADAPTERS.has(d.adapter)) {
        throw new Error(`Unknown adapter "${d.adapter}"`);
      }
      return d;
    },
  )
  .handler(
    async ({ data, context }): Promise<FinalizeOnDeviceImageGenTurnResult> => {
      const userId = context.userId;
      const badge: Badge = "private";
      const provider = adapterToProvider(data.adapter);

      // IDOR guard #1: the storage path must live under this user's prefix.
      // The chat-attachments bucket policy already enforces this at the
      // storage layer (see migrations); double-check here so a crafted
      // client can't link the row to someone else's existing object.
      if (!data.storagePath.startsWith(`${userId}/`)) {
        throw new Error("storagePath does not belong to this user");
      }

      // IDOR guard #2: thread + user-message ownership. Mirrors
      // finalizeOnDeviceTurn — service-role bypasses RLS so we MUST
      // verify by hand.
      const { data: userMsg, error: umErr } = await supabaseAdmin
        .from("chat_messages")
        .select("id, thread_id, user_id")
        .eq("id", data.userMessageId)
        .eq("user_id", userId)
        .eq("thread_id", data.threadId)
        .maybeSingle();
      if (umErr) throw umErr;
      if (!userMsg) throw new Error("User message not found");

      // Idempotency: if a prior finalize already wrote an assistant row
      // for this user message, return it (and its existing attachment row).
      const { data: existingAssistant } = await supabaseAdmin
        .from("chat_messages")
        .select("id")
        .match({
          user_id: userId,
          thread_id: data.threadId,
          role: "assistant",
        } as never)
        .eq("in_reply_to_id" as never, data.userMessageId as never)
        .maybeSingle();
      if (existingAssistant) {
        await finalizeReservedUsage({
          usageId: data.reservedUsageId,
          userId,
          status: "ok",
          providerUsed: provider,
          modelUsed: data.adapter,
          fallbackDepth: 0,
          latencyMs: 0,
          messageId: existingAssistant.id,
        }).catch(() => {});
        const sign = await supabaseAdmin.storage
          .from("chat-attachments")
          .createSignedUrl(data.storagePath, 60 * 60 * 24);
        return {
          assistantMessageId: existingAssistant.id,
          signedUrl: sign.data?.signedUrl ?? "",
        };
      }

      // Persist assistant row.
      const { data: aRow, error: aErr } = await supabaseAdmin
        .from("chat_messages")
        .insert({
          user_id: userId,
          thread_id: data.threadId,
          role: "assistant",
          content: data.caption,
          badge,
          provider,
          model: data.adapter,
          fallback_depth: 0,
          context_used:
            data.contextUsed && data.contextUsed.categories.length > 0
              ? data.contextUsed
              : null,
          trait_sheet_version: data.traitSheetVersion,
          in_reply_to_id: data.userMessageId,
        } as never)
        .select("id")
        .single();
      if (aErr) {
        const code = (aErr as { code?: string }).code;
        if (code === "23505") {
          const { data: winner } = await supabaseAdmin
            .from("chat_messages")
            .select("id")
            .eq("in_reply_to_id" as never, data.userMessageId as never)
            .maybeSingle();
          if (winner) {
            const sign = await supabaseAdmin.storage
              .from("chat-attachments")
              .createSignedUrl(data.storagePath, 60 * 60 * 24);
            return {
              assistantMessageId: winner.id,
              signedUrl: sign.data?.signedUrl ?? "",
            };
          }
        }
        throw aErr;
      }

      // Persist attachment row tagged image_out (phase 2.9a discriminator).
      // attachment_kind isn't yet in the regenerated types.ts so the cast
      // matches the pattern used elsewhere in this file.
      const { error: attErr } = await supabaseAdmin
        .from("chat_message_attachments")
        .insert({
          message_id: aRow.id,
          user_id: userId,
          storage_path: data.storagePath,
          mime: data.mime,
          bytes: data.bytes,
          width: data.width,
          height: data.height,
          attachment_kind: "image_out",
        } as never);
      if (attErr) {
        // Roll back the assistant row so the thread doesn't develop a
        // caption with no image. The reserved usage row gets released
        // by the throw — release_inference_slot is idempotent.
        await supabaseAdmin
          .from("chat_messages")
          .delete()
          .eq("id", aRow.id)
          .eq("user_id", userId);
        await releaseReservedUsage(data.reservedUsageId, userId).catch(() => {});
        throw attErr;
      }

      // Telemetry. Cost is zero — bytes never left the device.
      const finalized = await finalizeReservedUsage({
        usageId: data.reservedUsageId,
        userId,
        status: "ok",
        providerUsed: provider,
        modelUsed: data.adapter,
        fallbackDepth: 0,
        latencyMs: 0,
        messageId: aRow.id,
      });
      if (!finalized) {
        console.warn(
          `[finalizeOnDeviceImageGenTurn] reservation ${data.reservedUsageId} no longer pending`,
        );
      }

      // Broker audit row. Same shape as the text on-device path.
      await logContextDecision({
        userId,
        messageId: aRow.id,
        badge,
        strictestTier: -1,
        contextUsed: (data.contextUsed ?? {
          categories: [],
          trait_paths: [],
        }) as ContextUsed,
        fragmentLength: 0,
        scrubBlocked: false,
        traitSheetVersion: data.traitSheetVersion,
      });

      await supabaseAdmin
        .from("chat_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", data.threadId)
        .eq("user_id", userId);

      const sign = await supabaseAdmin.storage
        .from("chat-attachments")
        .createSignedUrl(data.storagePath, 60 * 60 * 24);

      return {
        assistantMessageId: aRow.id,
        signedUrl: sign.data?.signedUrl ?? "",
      };
    },
  );
