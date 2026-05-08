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
import { runChain, CapExceededError, ChainExhaustedError } from "@/server/inference/chat";
import { chainFor, type Badge } from "@/server/inference/router";
import { strictestTierInChain } from "@/server/inference/tiers";
import type { InferenceMessage } from "@/server/inference";
import {
  assembleSystemPrompt,
  logContextDecision,
  type AssembleResult,
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
    return (rows ?? []).map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      badge: isBadge(r.badge) ? r.badge : null,
      provider: r.provider,
      model: r.model,
      fallbackDepth: r.fallback_depth,
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

    // 3. Persist the user message immediately so it survives chain failures.
    const { data: userRow, error: uErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        user_id: userId,
        thread_id: threadId,
        role: "user",
        content: data.content,
        badge: data.badge,
      })
      .select("id, thread_id, role, content, created_at, badge, provider, model, fallback_depth")
      .single();
    if (uErr) throw uErr;

    // 4. Resolve chain + assemble personalization fragment (D8 step 5).
    //    Broker is best-effort — any failure falls back to the chain runner's
    //    DEFAULT_SYSTEM_PROMPT so chat never breaks on a broker bug.
    const cfg = chainFor(data.badge);
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
        badge: data.badge,
        strictestTierInChain: tier,
      });
    } catch (e) {
      console.warn(`[chat.sendChatMessage] broker failed, proceeding with default prompt:`, e);
    }

    // 5. Run the chain. CapExceededError and ChainExhaustedError surface to
    //    the caller as typed errors — UI shows a friendly upsell or retry.
    const paidTier = await getPaidTier(userId);
    const result = await runChain({
      userId,
      threadId,
      badge: data.badge,
      messages: [...historyMessages, { role: "user", content: data.content }],
      paidTier,
      systemPrompt: broker.fragment || undefined,
    });

    // 6. Persist the assistant reply with routing breadcrumb + context audit.
    const { data: aRow, error: aErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        user_id: userId,
        thread_id: threadId,
        role: "assistant",
        content: result.text,
        badge: data.badge,
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
      badge: data.badge,
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
    });

    return {
      threadId,
      userMessage: toPayload(userRow),
      assistantMessage: toPayload(aRow),
    };
  });

// Re-export typed errors so the UI can do `instanceof` checks if desired.
export { CapExceededError, ChainExhaustedError };
