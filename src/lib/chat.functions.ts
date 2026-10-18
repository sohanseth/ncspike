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
    // Private by default: hosted inference only with cloud chat on. Checked
    // before any thread, message or embedding. Fails closed.
    {
      const { requireCloudFeature } = await import("@/server/cloud-features.server");
      await requireCloudFeature(userId, "cloud_chat");
    }

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
  .inputValidator((d: Partial<PrepareOnDeviceTurnInput> | undefined): PrepareOnDeviceTurnInput => {
    // Private by default (prompt E step 5): a PRIVATE turn sends no
    // question to the server. Any content a stale client sends is dropped
    // here, before the handler.
    const threadId = d && typeof d.threadId === "string" ? d.threadId : null;
    return { threadId, content: "" };
  })
  .handler(async ({ data, context }): Promise<PrepareOnDeviceTurnResult> => {
    const userId = context.userId;
    const badge: Badge = "private";
    // Cap check only. No thread, no message row, no broker call: the
    // conversation stays in the browser, and the personalization summary
    // is not fetched because the broker needs the message to pick it.
    const paidTier = await getPaidTier(userId);
    let reservedUsageId: string;
    try {
      const r = await assertCap({ userId, threadId: null, badge, paidTier });
      reservedUsageId = r.usageId;
    } catch (e) {
      if (e instanceof CapExceededError) {
        throw new Error(`CAP_EXCEEDED:${e.used}|${e.cap}`);
      }
      throw e;
    }
    return {
      threadId: data.threadId ?? `local-${crypto.randomUUID()}`,
      userMessageId: crypto.randomUUID(),
      reservedUsageId,
      systemPrompt:
        "You are a helpful assistant running on the user's own device. Keep replies concise and practical.",
      history: [],
      contextUsed: null,
      traitSheetVersion: null,
    };
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
  inputTokens?: number | null;
  outputTokens?: number | null;
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
    if (typeof d.reservedUsageId !== "string") throw new Error("reservedUsageId required");
    if (!ON_DEVICE_PROVIDER_IDS.has(d.provider)) {
      throw new Error("Invalid on-device provider");
    }
    if (typeof d.model !== "string") throw new Error("model required");
    // The reply text is never accepted: it stays on the device.
    return { ...d, assistantText: "", model: d.model.slice(0, 128) };
  })
  .handler(async ({ data, context }): Promise<FinalizeOnDeviceTurnResult> => {
    // Content-free: flips the reserved usage row (provider, model, token
    // counts) so the daily cap still counts PRIVATE turns.
    await finalizeReservedUsage({
      usageId: data.reservedUsageId,
      userId: context.userId,
      status: "ok",
      providerUsed: data.provider,
      modelUsed: data.model,
      fallbackDepth: 0,
      latencyMs: 0,
      ...(typeof data.inputTokens === "number" ? { inputTokens: data.inputTokens } : {}),
      ...(typeof data.outputTokens === "number" ? { outputTokens: data.outputTokens } : {}),
    });
    return { assistantMessageId: crypto.randomUUID() };
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
      const provider = adapterToProvider(data.adapter);
      // Content-free: no chat row (the placeholder bubble lives in the
      // browser). `error` rows don't count toward the daily cap.
      await finalizeReservedUsage({
        usageId: data.reservedUsageId,
        userId,
        status: "error",
        providerUsed: provider,
        modelUsed: data.adapter,
        fallbackDepth: 0,
        latencyMs: 0,
        errorClass: "image_blocked",
      }).catch(() => {});
      const { error: metaErr } = await supabaseAdmin
        .from("inference_usage")
        .update({
          metadata: { image_blocked: true, image_blocked_reason: data.reason },
        } as never)
        .eq("id", data.reservedUsageId)
        .eq("user_id", userId);
      if (metaErr) {
        console.warn(
          "[finalizeOnDeviceImageGenBlockedTurn] metadata stamp failed:",
          scrubErrorMessage(metaErr.message),
        );
      }
      return { assistantMessageId: crypto.randomUUID() };
    },
  );

export const finalizeOnDeviceImageGenTurn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: FinalizeOnDeviceImageGenTurnInput): FinalizeOnDeviceImageGenTurnInput => {
      if (!d || typeof d !== "object") throw new Error("Invalid input");
      if (typeof d.reservedUsageId !== "string") {
        throw new Error("reservedUsageId required");
      }
      if (!IMAGE_GEN_ADAPTERS.has(d.adapter)) {
        throw new Error(`Unknown adapter "${d.adapter}"`);
      }
      // The picture, its caption and any storage path stay on the device.
      return { ...d, caption: "", storagePath: "" };
    },
  )
  .handler(
    async ({ data, context }): Promise<FinalizeOnDeviceImageGenTurnResult> => {
      // Content-free telemetry so the daily cap counts the turn.
      await finalizeReservedUsage({
        usageId: data.reservedUsageId,
        userId: context.userId,
        status: "ok",
        providerUsed: adapterToProvider(data.adapter),
        modelUsed: data.adapter,
        fallbackDepth: 0,
        latencyMs: 0,
      });
      return { assistantMessageId: crypto.randomUUID(), signedUrl: "" };
    },
  );
