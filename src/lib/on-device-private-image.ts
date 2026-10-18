/**
 * Phase 2.9b/c — PRIVATE + image-out client-side dispatcher.
 *
 * When the chat-stream client detects badge='private' AND the user's
 * prompt looks like an image-generation request, it routes to this runner
 * instead of the text on-device path. The runner handles two cases:
 *
 *   - **Text-to-image** (slice b — no attachments): SD-Turbo via WebGPU.
 *   - **img2img edit** (slice c — has attachments): InstructPix2Pix
 *     (desktop ≥ 2 GB VRAM) or SD 1.5 + ControlNet (mid-tier ≥ 1 GB).
 *     Source-image bytes are downloaded from the user's own
 *     `chat-attachments` bucket via their Supabase JWT (RLS enforces
 *     ownership) and passed straight to the WebGPU adapter; they NEVER
 *     transit a hosted provider.
 *
 * The runner:
 *
 *   1. Caps + persist via prepareOnDeviceTurn (re-used from text path —
 *      the user-message persist and broker-audit are identical; only
 *      the inference modality differs).
 *   2. Capability detection — refuses with a plain-English reason if the
 *      device can't run on-device image gen (no WebGPU, insufficient
 *      VRAM, native-only paths still unwired). PRIVATE is fail-closed
 *      (replit.md "no silent fallbacks") — never silently fall back to a
 *      hosted image-gen provider.
 *   3. WebGPU SD-Turbo (or whichever adapter pickAdapter selects). Bytes
 *      stay in the user's GPU until the model returns.
 *   4. NSFW gate via `classifyGeneratedImage`. A deny verdict discards
 *      the bytes in memory before any upload — they NEVER touch the
 *      chat-attachments bucket.
 *   5. Client-side upload to chat-attachments under
 *      `${userId}/imagegen/${uuid}.${ext}` using the user's Supabase
 *      session JWT (RLS + bucket-path-policy enforce ownership).
 *   6. Server-side persist of the assistant message + attachment row
 *      (with `attachment_kind = 'image_out'`) + zero-cost telemetry via
 *      `finalizeOnDeviceImageGenTurn`. The server-fn takes the storage
 *      path, NOT the bytes — preserving the no-image-egress invariant.
 *
 * Wire-compatible with `streamOnDeviceChat`: emits the same
 * `ChatStreamEvent` shape the UI consumer in MainApp.tsx already handles,
 * so MainApp doesn't need to know whether a PRIVATE turn was text or
 * image. The `done` event carries the signed URL in `assistantImages`.
 */
import {
  detectImageEditCapability,
  detectImageGenCapability,
} from "./image-gen-capability";
import { streamOnDeviceImageGen } from "./on-device-imagegen";
import { classifyGeneratedImage } from "./imagegen-safety";
import {
  prepareOnDeviceTurn,
  finalizeOnDeviceImageGenTurn,
  finalizeOnDeviceImageGenBlockedTurn,
  releaseOnDeviceReservation,
} from "./chat.functions";
import type { ChatStreamEvent, StreamChatInput } from "./chat-stream";
import { supabase } from "@/integrations/supabase/client";

function extOf(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

export async function* streamOnDevicePrivateImage(
  input: StreamChatInput,
): AsyncGenerator<ChatStreamEvent, void, void> {
  // ─── 0. Capability probe BEFORE the cap reservation ─────────────────────
  // If the device can't run on-device image gen, refuse without debiting
  // the user's daily PRIVATE cap. This matches docs/12 §15: PRIVATE is
  // fail-closed — never fall back to a hosted image provider.
  // Slice c: a turn carrying attachments is an img2img EDIT, so we probe
  // the edit capability (which resolves to InstructPix2Pix / SD 1.5 +
  // ControlNet on capable WebGPU devices). A pure text-to-image turn
  // keeps using the slice-b text-to-image probe.
  const isEdit = (input.attachments?.length ?? 0) > 0 || (input.localImages?.length ?? 0) > 0;
  const cap = await (isEdit
    ? detectImageEditCapability()
    : detectImageGenCapability());
  if (!cap.available) {
    yield { kind: "error", type: "validation", message: cap.reason };
    return;
  }

  // ─── 1. Server-side prepare (cap-check + user-row persist + broker) ─────
  // Re-uses the text on-device prepare fn — semantics are identical
  // (PRIVATE badge, tier=-1 broker, atomic cap reservation).
  let prep: Awaited<ReturnType<typeof prepareOnDeviceTurn>>;
  try {
    prep = await prepareOnDeviceTurn({
      data: { threadId: input.threadId },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't prepare on-device image turn";
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
      const capN = Number(parts[1]);
      yield {
        kind: "error",
        type: "cap_exceeded",
        badge: "private",
        message: msg,
        used: Number.isFinite(used) ? used : undefined,
        cap: Number.isFinite(capN) ? capN : undefined,
      };
      return;
    }
    yield { kind: "error", type: "internal", message: msg };
    return;
  }

  yield {
    kind: "init",
    threadId: prep.threadId,
    userMessageId: prep.userMessageId,
  };
  yield { kind: "meta", provider: "onDeviceWebGpuImage", fallbackDepth: 0 };

  // ─── 1b. Slice c — download source-image bytes for an img2img edit ──────
  // The dispatcher pulls the bytes from the user's own chat-attachments
  // prefix using their Supabase JWT (RLS enforces ownership). The bytes
  // go from Supabase storage → memory → WebGPU adapter and never leave
  // the device. We refuse anything that doesn't live under the signed-in
  // user's prefix — defense-in-depth against a crafted client passing
  // someone else's storage path. On any download failure we release the
  // reservation and surface a precise error rather than degrading to
  // text-to-image (silent degradation would be a fail-open per
  // replit.md §"No silent fallbacks").
  const sourceImages: { bytes: Uint8Array; mime: string }[] = [
    ...(input.localImages ?? []),
  ];
  // Legacy: photos already in storage (uploaded before private-by-default).
  if (isEdit && (input.attachments?.length ?? 0) > 0) {
    const { data: authForSrc } = await supabase.auth.getUser();
    const srcUserId = authForSrc.user?.id;
    if (!srcUserId) {
      try {
        await releaseOnDeviceReservation({
          data: { reservedUsageId: prep.reservedUsageId },
        });
      } catch {
        /* noop */
      }
      yield { kind: "error", type: "internal", message: "Not signed in" };
      return;
    }
    for (const path of input.attachments ?? []) {
      if (!path.startsWith(`${srcUserId}/`)) {
        try {
          await releaseOnDeviceReservation({
            data: { reservedUsageId: prep.reservedUsageId },
          });
        } catch {
          /* noop */
        }
        yield {
          kind: "error",
          type: "validation",
          message: "Attachment path doesn't belong to this user.",
        };
        return;
      }
      const dl = await supabase.storage
        .from("chat-attachments")
        .download(path);
      if (dl.error || !dl.data) {
        try {
          await releaseOnDeviceReservation({
            data: { reservedUsageId: prep.reservedUsageId },
          });
        } catch {
          /* noop */
        }
        yield {
          kind: "error",
          type: "internal",
          message: `Couldn't read your photo: ${dl.error?.message ?? "unknown error"}`,
        };
        return;
      }
      const blob = dl.data;
      const srcMime = blob.type || "application/octet-stream";
      const srcBytes = new Uint8Array(await blob.arrayBuffer());
      sourceImages.push({ bytes: srcBytes, mime: srcMime });
    }
  }

  // ─── 2. Run on-device image generation ──────────────────────────────────
  let bytes: Uint8Array | null = null;
  let mime = "image/png";
  let width = 0;
  let height = 0;
  let adapterId: string = cap.adapter;
  let errored = false;

  try {
    for await (const ev of streamOnDeviceImageGen({
      prompt: input.content,
      signal: input.signal,
      ...(sourceImages.length > 0 ? { sourceImages } : {}),
    })) {
      if (ev.kind === "load_progress") {
        yield { kind: "load_progress", pct: Math.round(ev.pct * 100) };
      } else if (ev.kind === "done") {
        bytes = ev.bytes;
        mime = ev.mime;
        width = ev.width;
        height = ev.height;
        adapterId = ev.adapter;
      } else if (ev.kind === "error") {
        errored = true;
        // Map adapter event types to the ChatStreamEvent error union.
        // 'unsupported' / 'cancelled' / 'validation' all surface as the
        // closest existing class so MainApp's toast logic doesn't need
        // a new branch. 'internal' stays internal.
        const errType =
          ev.type === "unsupported" || ev.type === "validation"
            ? "validation"
            : "internal";
        yield { kind: "error", type: errType, message: ev.message };
        break;
      }
      // 'init' and 'step' are diagnostic — not surfaced to the UI yet.
    }
  } catch (e) {
    errored = true;
    yield {
      kind: "error",
      type: "internal",
      message: e instanceof Error ? e.message : "On-device image generation failed",
    };
  }

  if (errored || !bytes) {
    // Release the reservation so the cap slot is returned. Best-effort —
    // the 5-minute sweep is the backstop.
    try {
      await releaseOnDeviceReservation({
        data: { reservedUsageId: prep.reservedUsageId },
      });
    } catch {
      /* noop */
    }
    return;
  }

  // ─── 3. Output-side safety gate (NSFW + structural check) ───────────────
  // Fail-closed: a thrown classifier returns deny by contract. Bytes are
  // discarded in memory if denied — they NEVER touch the storage bucket
  // on PRIVATE per docs/12 §15.4.
  const verdict = await classifyGeneratedImage(bytes, mime);
  if (!verdict.allow) {
    // Task #32 / docs/12 §15.4: instead of silently releasing the cap
    // slot, write a placeholder assistant chat row so the user can see,
    // on scroll-back, that an image WAS generated but blocked. The
    // server-fn also flips the reserved telemetry row to status='error'
    // with `metadata.image_blocked = true` (cap-equivalent to release —
    // 'error' rows don't count toward the daily cap). Best-effort: if
    // the placeholder write fails, fall back to the old release path so
    // the user is still not debited.
    try {
      await finalizeOnDeviceImageGenBlockedTurn({
        data: {
          threadId: prep.threadId,
          userMessageId: prep.userMessageId,
          reservedUsageId: prep.reservedUsageId,
          adapter: adapterId,
          // Task #51: forward the structured verdict category so the
          // CPAUD admin surface can group blocked turns by reason
          // (nsfw vs classifier_unavailable vs invalid_image vs other),
          // not just by adapter. Persisted on
          // `inference_usage.metadata.image_blocked_reason`.
          reason: verdict.reasonCategory,
          contextUsed: prep.contextUsed,
          traitSheetVersion: prep.traitSheetVersion,
        },
      });
    } catch {
      try {
        await releaseOnDeviceReservation({
          data: { reservedUsageId: prep.reservedUsageId },
        });
      } catch {
        /* noop */
      }
    }
    // Task #52: surface the block as a dedicated `image_blocked` error
    // kind (not `validation`) so the UI consumer in MainApp can fill the
    // optimistic assistant bubble with the same placeholder string the
    // server-fn just persisted, instead of rolling back the turn. Without
    // this distinction the styled amber "blocked" bubble only showed up
    // after a thread reload.
    yield {
      kind: "error",
      type: "image_blocked",
      message: verdict.reason,
    };
    return;
  }

  // ─── 4. Keep the picture in the browser ─────────────────────────────────
  // Private by default: the generated bytes are never uploaded. The UI
  // renders them from an in-memory object URL.
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const localUrl =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(blob)
      : "";

  // ─── 5. Content-free finalize (counts the turn toward the daily cap) ────
  try {
    const fin = await finalizeOnDeviceImageGenTurn({
      data: {
        threadId: prep.threadId,
        userMessageId: prep.userMessageId,
        reservedUsageId: prep.reservedUsageId,
        caption: "",
        storagePath: "",
        mime,
        bytes: bytes.length,
        width,
        height,
        adapter: adapterId,
        contextUsed: null,
        traitSheetVersion: null,
      },
    });
    yield {
      kind: "done",
      messageId: fin.assistantMessageId,
      provider: "onDeviceWebGpuImage",
      model: adapterId,
      fallbackDepth: 0,
      inputTokens: null,
      outputTokens: null,
      contextUsed: null,
      traitSheetVersion: null,
      ...(localUrl ? { assistantImages: [localUrl] } : {}),
    };
  } catch (e) {
    yield {
      kind: "error",
      type: "internal",
      message: e instanceof Error ? e.message : "Failed to finish on-device image",
    };
  }
}
