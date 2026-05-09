/**
 * Client-side runner for the PRIVATE badge — runs generation entirely on
 * the user's device. See docs/11-spec-on-device-tier.md.
 *
 * Mirrors the public surface of `streamChatMessage` (in `chat-stream.ts`)
 * so the UI dispatcher can substitute it without touching the consumer
 * loop in `MainApp.tsx`. Emits the same `ChatStreamEvent` shape.
 *
 * Flow per turn:
 *   1. `prepareOnDeviceTurn` (server-fn): cap-check + persist user row +
 *      assemble personalization fragment at tier -1 (full personalization
 *      since data never leaves device). Returns {threadId, userMessageId,
 *      systemPrompt, history, contextUsed, traitSheetVersion}.
 *   2. Detect on-device capability; pick adapter (Apple / Android / WebLLM).
 *   3. Stream tokens locally; emit `delta` events to the UI.
 *   4. `finalizeOnDeviceTurn` (server-fn): persist assistant row + write a
 *      zero-cost telemetry row (cost_micro_usd: 0, provider_used: chosen).
 *
 * Failure modes are explicit (no silent fallback to a hosted provider —
 * PRIVATE is fail-closed):
 *   - No on-device capability → `error` event with `unsupportedReason`.
 *   - Native plugin throws → `error` event; user row stays in DB so the
 *     thread doesn't develop holes; assistant row is NOT written.
 *   - User cancels → `error` event with type `internal` and message
 *     "Cancelled by user".
 */
import { detectOnDeviceCapability } from "./on-device-capability";
import { streamNativeOnDevice } from "./native-on-device-llm";
import { streamWebLLM } from "./on-device-webllm";
import { prepareOnDeviceTurn, finalizeOnDeviceTurn } from "./chat.functions";
import type { ChatStreamEvent, StreamChatInput } from "./chat-stream";
import type { OnDeviceProviderId } from "./provider-tiers";

export async function* streamOnDeviceChat(
  input: StreamChatInput,
): AsyncGenerator<ChatStreamEvent, void, void> {
  // ─── 0. Fail-closed for image attachments ───────────────────────────────
  // PRIVATE / on-device adapters are text-only (WebLLM, Apple Foundation
  // Models, Gemini Nano). A turn with image attachments cannot be honestly
  // served at this tier — silently dropping the attachments would let the
  // model reply with garbage to a half-question (e.g. "Add fringe to this
  // photo" → text-only model sees only "Add fringe to this photo" and
  // hallucinates a textual answer). Per docs/11 §9 / docs/12 §11 we refuse
  // upfront with a clear message instead of degrading silently.
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    yield {
      kind: "error",
      type: "validation",
      message:
        "PRIVATE can't see images on this device. Switch to FLASH, PRO, or " +
        "Genius to send a turn with an attachment, or remove the attachment " +
        "to keep this turn on-device.",
    };
    return;
  }

  // ─── 1. Capability detection ────────────────────────────────────────────
  const cap = await detectOnDeviceCapability();
  if (!cap.available || !cap.providerId) {
    yield {
      kind: "error",
      type: "validation",
      message:
        cap.unsupportedReason ??
        "On-device AI isn't available on this device. Use a different badge.",
    };
    return;
  }

  // ─── 2. Server-side prepare (cap-check + user-row persist + broker) ─────
  let prep: Awaited<ReturnType<typeof prepareOnDeviceTurn>>;
  try {
    prep = await prepareOnDeviceTurn({
      data: { threadId: input.threadId, content: input.content },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't prepare on-device turn";
    // Cap-exceeded surfaces with the same shape as hosted chains so the
    // toast in MainApp.tsx fires identically.
    // Broker scrub-block surfaces as a typed validation error (mirrors the
    // hosted SSE branch — fail-closed, same UI copy class).
    if (msg.startsWith("SCRUB_BLOCKED:")) {
      yield {
        kind: "error",
        type: "validation",
        message:
          "Personalization context blocked by safety scrub. Try rephrasing or open Privacy → Forget a trait.",
      };
      return;
    }
    if (msg.startsWith("CAP_EXCEEDED:")) {
      const parts = msg.slice("CAP_EXCEEDED:".length).split("|");
      const used = Number(parts[0]);
      const cap = Number(parts[1]);
      yield {
        kind: "error",
        type: "cap_exceeded",
        badge: "private",
        message: msg,
        used: Number.isFinite(used) ? used : undefined,
        cap: Number.isFinite(cap) ? cap : undefined,
      };
      return;
    }
    yield { kind: "error", type: "internal", message: msg };
    return;
  }

  yield { kind: "init", threadId: prep.threadId, userMessageId: prep.userMessageId };
  yield { kind: "meta", provider: cap.providerId, fallbackDepth: 0 };

  // ─── 3. Run on-device generation ────────────────────────────────────────
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: prep.systemPrompt },
    ...prep.history,
    { role: "user", content: input.content },
  ];

  let assistantText = "";
  let modelUsed = cap.providerId;
  let errored = false;

  const stream = pickStream(cap.providerId, {
    messages,
    signal: input.signal,
    temperature: 0.4,
    maxTokens: 1024,
  });

  try {
    for await (const ev of stream) {
      if (ev.kind === "load_progress") {
        // WebLLM-only: forward as a structured load_progress event so the
        // UI can show a download indicator. MUST NOT be yielded as a delta
        // (which would pollute the assistant message text — see the bug
        // where chats were prefixed with [loading model: 0%] [loading model:
        // 2%] ... before the real reply).
        const pct = Math.round((ev.progress ?? 0) * 100);
        yield { kind: "load_progress", pct };
      } else if (ev.kind === "delta") {
        assistantText += ev.text;
        yield { kind: "delta", text: ev.text };
      } else if (ev.kind === "done") {
        modelUsed = ev.model as OnDeviceProviderId;
      } else if (ev.kind === "error") {
        errored = true;
        yield { kind: "error", type: "internal", message: ev.error };
        break;
      }
    }
  } catch (e) {
    errored = true;
    yield {
      kind: "error",
      type: "internal",
      message: e instanceof Error ? e.message : "On-device generation failed",
    };
  }

  if (errored || assistantText.length === 0) {
    // Don't persist an empty assistant row.
    return;
  }

  // ─── 4. Server-side finalize (assistant row + zero-cost telemetry) ──────
  try {
    const fin = await finalizeOnDeviceTurn({
      data: {
        threadId: prep.threadId,
        userMessageId: prep.userMessageId,
        assistantText,
        provider: cap.providerId,
        model: String(modelUsed),
        contextUsed: prep.contextUsed,
        traitSheetVersion: prep.traitSheetVersion,
      },
    });
    yield {
      kind: "done",
      messageId: fin.assistantMessageId,
      provider: cap.providerId,
      model: String(modelUsed),
      fallbackDepth: 0,
      inputTokens: null,
      outputTokens: null,
      contextUsed: prep.contextUsed,
      traitSheetVersion: prep.traitSheetVersion,
    };
  } catch (e) {
    yield {
      kind: "error",
      type: "internal",
      message: e instanceof Error ? e.message : "Failed to save on-device reply",
    };
  }
}

function pickStream(
  id: OnDeviceProviderId,
  args: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    signal?: AbortSignal;
    temperature?: number;
    maxTokens?: number;
  },
) {
  if (id === "onDeviceWebLLM") return streamWebLLM(args);
  return streamNativeOnDevice(args);
}
