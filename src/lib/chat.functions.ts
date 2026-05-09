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
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runChain, CapExceededError, ChainExhaustedError, assertCap } from "@/server/inference/chat";
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
    await assertCap({
      userId,
      threadId,
      badge: effectiveBadge,
      paidTier: paidTierForCap,
    });

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
      console.warn(`[chat.sendChatMessage] broker threw, fail-closing:`, e);
      throw new Error("SCRUB_BLOCKED:context");
    }

    // Fail-closed when the broker scrub blocks the assembled fragment. The
    // prior behavior silently swapped to the default system prompt and let
    // inference proceed, masking what is supposed to be a privacy guard
    // event. Surface as a typed error the client can render.
    if (broker.scrubBlocked) {
      throw new Error("SCRUB_BLOCKED:context");
    }

    // 5. Run the chain. CapExceededError and ChainExhaustedError surface to
    //    the caller as typed errors — UI shows a friendly upsell or retry.
    //    Re-uses paidTierForCap from step 3 to avoid a second auth lookup.
    const result = await runChain({
      userId,
      threadId,
      badge: effectiveBadge,
      messages: [...historyMessages, { role: "user", content: data.content }],
      paidTier: paidTierForCap,
      systemPrompt: broker.fragment || undefined,
      // Pre-flight assertCap() already ran above (step 3), BEFORE the user
      // row was persisted. Skipping the inner re-check closes the TOCTOU
      // window where a concurrent send could otherwise throw cap_exceeded
      // here and orphan the just-inserted user row.
      assumeCapChecked: true,
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
    //    into a typed `cap_exceeded` event.
    const paidTier = await getPaidTier(userId);
    try {
      await assertCap({ userId, threadId, badge, paidTier });
    } catch (e) {
      if (e instanceof CapExceededError) {
        throw new Error(`CAP_EXCEEDED:${e.used}|${e.cap}`);
      }
      throw e;
    }

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
      console.warn("[prepareOnDeviceTurn] broker threw, fail-closing:", e);
      throw new Error("SCRUB_BLOCKED:context");
    }

    // Fail-closed on scrub-block, same as the hosted path. The on-device
    // runner runs entirely on the user's hardware so there is no leak risk
    // here, but consistency with the hosted path matters and the user
    // should still see that something tripped the guard.
    if (broker.scrubBlocked) {
      throw new Error("SCRUB_BLOCKED:context");
    }

    return {
      threadId,
      userMessageId: userRow.id,
      systemPrompt:
        broker.fragment ||
        "You are a helpful assistant running on the user's own device. Keep replies concise and practical.",
      history: historyMessages,
      contextUsed:
        broker.contextUsed.categories.length > 0 ? broker.contextUsed : null,
      traitSheetVersion: broker.traitSheetVersion,
    };
  });

export type FinalizeOnDeviceTurnInput = {
  threadId: string;
  userMessageId: string;
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

    // Zero-cost telemetry row, linked to the assistant message via
    // `message_id` (migration 20260515). Unique partial index on
    // `inference_usage(message_id)` makes this idempotent: a duplicate
    // insert on retry hits 23505 and we swallow it (one usage row per
    // assistant message is the invariant).
    const { error: usageErr } = await supabaseAdmin.from("inference_usage").insert({
      user_id: userId,
      thread_id: data.threadId,
      badge,
      provider_chain: [data.provider],
      provider_used: data.provider,
      model_used: data.model,
      fallback_depth: 0,
      input_tokens: null,
      output_tokens: null,
      cost_micro_usd: 0,
      latency_ms: 0,
      status: "ok",
      error_class: null,
      message_id: aRow.id,
    } as never);
    if (usageErr) {
      const code = (usageErr as { code?: string }).code;
      if (code !== "23505") {
        // 23505 = duplicate (idempotent retry); anything else is a real bug.
        console.error("[finalizeOnDeviceTurn] inference_usage insert failed:", usageErr.message);
      }
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
