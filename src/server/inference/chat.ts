/**
 * Chain runner for the badge-routed chat path. See docs/05-spec-phase-2.6-chat-providers.md §11.
 *
 * The runner is the single canonical execution flow for every chat request:
 *
 *   1. Check daily cap for (user, badge) — throw cap_exceeded if over.
 *   2. Walk the badge's provider chain in order:
 *        a. start timer
 *        b. call provider.generate
 *        c. on success → insert inference_usage(status='ok'), return
 *        d. on error  → insert inference_usage(status=…, error_class=…)
 *           PRIVATE (failClosed=true) re-throws here.
 *           Other badges advance to next provider.
 *   3. If chain exhausts, throw ChainExhausted.
 *
 * D8 will replace the static system prompt with a tier-aware system prompt
 * assembled by the broker. Day 2 ships a minimal static prompt.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getProvider, InferenceError, type InferenceMessage } from "./index";
import type { InferenceChunk } from "./types";
import { capFor, chainFor, modalityFor, type Badge } from "./router";
import { isOnDeviceProvider } from "@/lib/provider-tiers";
import { costMicroUsd } from "./pricing";
import type { ProviderId } from "@/lib/provider-tiers";

/**
 * Defense-in-depth: if the resolved chain contains any on-device provider,
 * the server-side chain runner refuses to execute. The PRIVATE badge runs
 * entirely on the client (see `src/lib/on-device-chat.ts` and docs/11);
 * reaching this code path means the dispatcher missed a case. Throw with
 * a clear, telemetry-safe message so the bug surfaces immediately rather
 * than as an opaque chain-exhausted later.
 */
function assertNoOnDeviceProviders(badge: Badge, chain: ProviderId[]): void {
  const od = chain.find(isOnDeviceProvider);
  if (od !== undefined) {
    throw new Error(
      `Badge '${badge}' resolves to an on-device chain (${od}). The server ` +
        `cannot run on-device generation; the client must call the on-device ` +
        `path directly via prepareOnDeviceTurn / finalizeOnDeviceTurn. See docs/11.`,
    );
  }
}

/**
 * Thrown by `runChain` / `runChainStream` when a chain's resolved modality
 * is `'image-out'`. Phase 2.9a (slice a) wires the fork but leaves the
 * branch as a stub — slice b adds real image-out adapters. Until then the
 * runner refuses image-out chains explicitly so a misrouted call surfaces
 * loudly rather than as an opaque chain-exhausted later.
 *
 * Note: image-generation requests today are handled OUT-OF-BAND in
 * `src/routes/api.chat.stream.ts` via `runImageGenTurn` (Lovable AI Gateway,
 * text-out chains only). This error covers a different future code path:
 * a chain whose `modality` is declared image-out reaching the chain runner.
 */
export class ImageOutNotAvailableError extends Error {
  public readonly badge: Badge;
  constructor(badge: Badge) {
    super(
      `IMAGE_OUT_NOT_AVAILABLE: chain for badge "${badge}" has modality 'image-out'; ` +
        `no image-out adapter is wired in slice a. See docs/12 §15.`,
    );
    this.name = "ImageOutNotAvailableError";
    this.badge = badge;
  }
}

export class CapExceededError extends Error {
  public readonly badge: Badge;
  public readonly used: number;
  public readonly cap: number;
  constructor(badge: Badge, used: number, cap: number) {
    super(`Daily cap reached for badge "${badge}" (${used}/${cap}). Try again tomorrow or switch badges.`);
    this.name = "CapExceededError";
    this.badge = badge;
    this.used = used;
    this.cap = cap;
  }
}

export class ChainExhaustedError extends Error {
  public readonly badge: Badge;
  public readonly chain: ProviderId[];
  public readonly lastErrorClass: string;
  constructor(badge: Badge, chain: ProviderId[], lastErrorClass: string) {
    super(`All providers in the "${badge}" chain failed. Last error class: ${lastErrorClass}.`);
    this.name = "ChainExhaustedError";
    this.badge = badge;
    this.chain = chain;
    this.lastErrorClass = lastErrorClass;
  }
}

/**
 * Thrown by `runChainStream` when the caller's AbortSignal fires. Distinct
 * from generic provider errors so the route can finalize as `user_abort`
 * (partial assistant persist + telemetry) rather than `error`/`exhausted`,
 * and so we never iterate fallback providers after a user disconnect.
 */
export class UserAbortError extends Error {
  constructor() {
    super("User aborted stream");
    this.name = "UserAbortError";
  }
}

export type ChainResult = {
  text: string;
  provider: ProviderId;
  model: string;
  fallbackDepth: number;
  inputTokens?: number;
  outputTokens?: number;
};

const DEFAULT_SYSTEM_PROMPT =
  "You are NeuralConnexions, a calm, concise life-aware assistant. " +
  "Answer plainly. Prefer specifics over generalities. Never invent facts about the user; " +
  "if you don't know something, say so. No filler, no preamble.";

/**
 * Pre-flight cap + paidOnly check. Throws CapExceededError before any
 * side-effect — callers MUST run this BEFORE persisting the user
 * `chat_messages` row, or a blocked send leaves an orphan user bubble in
 * the thread on next page load (spec §C6 ordering).
 *
 * Race-proof (task #8): the read-then-write path was replaced by a single
 * `reserve_inference_slot` RPC that takes a per-(user,badge) advisory lock,
 * counts existing ok+pending rows for today, and either inserts a `pending`
 * reservation row or a `cap_exceeded` row in the same transaction. Two
 * concurrent requests at the cap edge therefore serialize on the lock and
 * exactly `cap` reservations succeed.
 *
 * Returns the reserved `usageId` so the caller can pass it to runChain;
 * the chain runner finalizes the row to `ok` on success or releases the
 * reservation on chain exhaustion. Without a reservation handoff, chain
 * runners would write an additional `ok` row on success and the reserved
 * `pending` row would linger until the 5-minute sweep.
 */
export async function assertCap(args: {
  userId: string;
  threadId: string | null;
  badge: Badge;
  paidTier: boolean;
}): Promise<{ usageId: string }> {
  const { badge } = args;
  const cfg = chainFor(badge);

  if (cfg.paidOnly && !args.paidTier) {
    await writeUsage({
      userId: args.userId,
      threadId: args.threadId,
      badge,
      chain: cfg.chain,
      providerUsed: cfg.chain[0],
      modelUsed: null,
      fallbackDepth: 0,
      latencyMs: 0,
      status: "cap_exceeded",
      errorClass: "cap_exceeded",
    });
    throw new CapExceededError(badge, 0, 0);
  }

  const cap = capFor(badge, args.paidTier);
  const { data, error } = await (supabaseAdmin as unknown as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: Array<{ usage_id: string; used_count: number; accepted: boolean }> | null; error: { message: string } | null }>;
  }).rpc("reserve_inference_slot", {
    p_user_id: args.userId,
    p_thread_id: args.threadId,
    p_badge: badge,
    p_provider_chain: cfg.chain,
    p_cap: cap,
  });
  if (error) throw new Error(`reserve_inference_slot failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error("reserve_inference_slot returned no row");
  if (!row.accepted) {
    throw new CapExceededError(badge, row.used_count, cap);
  }
  return { usageId: row.usage_id };
}

/**
 * Update the reserved (pending) usage row to its terminal status. Returns
 * true when the update hit a row — false means the reservation was
 * already finalized or released (concurrent retry / sweep). Callers
 * should treat false as a no-op rather than an error.
 */
export async function finalizeReservedUsage(args: {
  usageId: string;
  userId: string;
  status: "ok" | "rate_limited" | "error" | "user_abort";
  providerUsed: ProviderId;
  modelUsed: string | null;
  fallbackDepth: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  errorClass?: string;
  messageId?: string;
}): Promise<boolean> {
  const cost =
    args.status === "ok"
      ? Number(costMicroUsd(args.providerUsed, args.inputTokens, args.outputTokens))
      : 0;
  const { data, error } = await (supabaseAdmin as unknown as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: boolean | null; error: { message: string } | null }>;
  }).rpc("finalize_inference_usage", {
    p_usage_id: args.usageId,
    p_user_id: args.userId,
    p_status: args.status,
    p_provider_used: args.providerUsed,
    p_model_used: args.modelUsed,
    p_fallback_depth: args.fallbackDepth,
    p_input_tokens: args.inputTokens ?? null,
    p_output_tokens: args.outputTokens ?? null,
    p_cost_micro_usd: cost,
    p_latency_ms: args.latencyMs,
    p_error_class: args.errorClass ?? null,
    p_message_id: args.messageId ?? null,
  });
  if (error) {
    // Mirrors the rationale in `writeUsage` below — caps are derived from
    // ok+pending rows, so a finalize failure leaves the slot consumed
    // (fail-closed against the user) until the 5-min sweep. Shout loudly.
    console.error(
      `[finalize_inference_usage] CAP-CRITICAL update failure (status=${args.status}):`,
      error.message,
    );
    return false;
  }
  return Boolean(data);
}

/**
 * Delete a reserved (pending) usage row. Used when the chain exhausts
 * before any provider produced a response — the user shouldn't be debited
 * for a request that didn't yield a reply. Returns true if a row was
 * deleted; false when nothing was pending (already finalized / swept).
 */
export async function releaseReservedUsage(
  usageId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await (supabaseAdmin as unknown as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: boolean | null; error: { message: string } | null }>;
  }).rpc("release_inference_slot", {
    p_usage_id: usageId,
    p_user_id: userId,
  });
  if (error) {
    console.error(`[release_inference_slot] failed:`, error.message);
    return false;
  }
  return Boolean(data);
}

type WriteUsageArgs = {
  userId: string;
  threadId: string | null;
  badge: Badge;
  chain: ProviderId[];
  providerUsed: ProviderId;
  modelUsed: string | null;
  fallbackDepth: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  status: "ok" | "rate_limited" | "error" | "user_abort" | "cap_exceeded";
  errorClass?: string;
};

async function writeUsage(args: WriteUsageArgs): Promise<void> {
  const cost =
    args.status === "ok"
      ? Number(costMicroUsd(args.providerUsed, args.inputTokens, args.outputTokens))
      : 0;
  const { error } = await supabaseAdmin.from("inference_usage").insert({
    user_id: args.userId,
    thread_id: args.threadId,
    badge: args.badge,
    provider_chain: args.chain,
    provider_used: args.providerUsed,
    model_used: args.modelUsed,
    fallback_depth: args.fallbackDepth,
    input_tokens: args.inputTokens ?? null,
    output_tokens: args.outputTokens ?? null,
    cost_micro_usd: cost,
    latency_ms: args.latencyMs,
    status: args.status,
    error_class: args.errorClass ?? null,
  });
  // Telemetry write failure handling.
  //
  // Caps are currently enforced from inference_usage(status='ok'). That
  // means a swallowed insert error here makes the cap fail OPEN — the next
  // request undercounts and the user can exceed their quota. Until the
  // atomic-ledger migration lands (see follow-up task: "Phase 2.6 cap
  // atomicity hardening"), the best we can do is shout loudly so the
  // operator notices in the Cloudflare/Vercel log feed.
  //
  // We deliberately do NOT throw on `status='ok'` here: throwing would
  // surface as an error to a user who already received a successful
  // response, which is worse UX than over-counting. Throwing on
  // status='cap_exceeded' would be even worse — it would let the blocked
  // user retry forever. The proper fix is the atomic ledger.
  if (error) {
    console.error(
      `[inference_usage] CAP-CRITICAL insert failure (status=${args.status}):`,
      error.message,
    );
  }
}

export type RunChainArgs = {
  userId: string;
  threadId: string | null;
  badge: Badge;
  /** Prior conversation messages, oldest first. The current user message
   *  must be the last entry. */
  messages: InferenceMessage[];
  paidTier: boolean;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Set true when the caller has already invoked `assertCap()` BEFORE
   * persisting the user `chat_messages` row. Skips the inner re-check
   * so a TOCTOU race (concurrent send) cannot throw `CapExceededError`
   * after the user row is on disk, which would orphan it. Default
   * false keeps any future caller safe (re-checks; may overspend if
   * the inner reservation is not threaded through, but never orphans).
   */
  assumeCapChecked?: boolean;
  /**
   * The `usageId` returned by the caller's pre-flight `assertCap()`. When
   * provided, the chain runner finalizes this reserved (pending) row to
   * its terminal status instead of inserting a fresh `ok` row, and
   * releases it on chain exhaustion. REQUIRED whenever assumeCapChecked
   * is true so the cap accounting closes the loop; without it a
   * successful run would leave the pending reservation to be swept by
   * the 5-minute janitor and double-count against the next request.
   */
  reservedUsageId?: string;
};

export async function runChain(args: RunChainArgs): Promise<ChainResult> {
  const { badge } = args;
  const cfg = chainFor(badge);
  // Phase 2.9a slice-a fork: image-out chains are not yet runnable. No
  // shipping chain declares `'image-out'` today, so this is dormant in
  // production but lets slice b wire real adapters without changing the
  // text path. Throw BEFORE any side effect (cap-check, provider call).
  if (modalityFor(cfg) === "image-out") {
    throw new ImageOutNotAvailableError(badge);
  }
  assertNoOnDeviceProviders(badge, cfg.chain);

  let reservedUsageId = args.reservedUsageId;
  if (!args.assumeCapChecked) {
    const r = await assertCap({
      userId: args.userId,
      threadId: args.threadId,
      badge,
      paidTier: args.paidTier,
    });
    reservedUsageId = r.usageId;
  } else if (!reservedUsageId) {
    // Defense-in-depth (task #8): a caller that pre-checked the cap MUST
    // also thread the reservedUsageId, or the chain runner would write a
    // fresh `ok` row on success and the pre-flight `pending` reservation
    // would linger until the 5-min sweep — double-counting one slot
    // against the daily cap. Shout loudly so the bug surfaces in the
    // operator log feed instead of silently overspending the user.
    console.error(
      "[runChain] CAP-CRITICAL: assumeCapChecked=true without reservedUsageId — " +
        "caller must pass the usageId returned by assertCap() to close the cap-accounting loop.",
    );
  }

  const fullMessages: InferenceMessage[] = [
    { role: "system", content: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ...args.messages,
  ];

  // Wrap the chain in try/catch so any failure path (per-provider non-retriable,
  // fail-closed re-throw, chain exhaustion) releases the reserved cap slot.
  // Success returns from inside the loop and skips the catch.
  let lastErrorClass = "unknown";
  try {
    for (let i = 0; i < cfg.chain.length; i++) {
      const providerId = cfg.chain[i];
      const t0 = Date.now();
      try {
        const provider = await getProvider(providerId);
        const result = await provider.generate({
          messages: fullMessages,
          maxTokens: args.maxTokens,
          temperature: args.temperature,
        });
        const latencyMs = Date.now() - t0;
        if (reservedUsageId) {
          await finalizeReservedUsage({
            usageId: reservedUsageId,
            userId: args.userId,
            status: "ok",
            providerUsed: providerId,
            modelUsed: result.model,
            fallbackDepth: i,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs,
          });
        } else {
          await writeUsage({
            userId: args.userId,
            threadId: args.threadId,
            badge,
            chain: cfg.chain,
            providerUsed: providerId,
            modelUsed: result.model,
            fallbackDepth: i,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs,
            status: "ok",
          });
        }
        return {
          text: result.text,
          provider: providerId,
          model: result.model,
          fallbackDepth: i,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
      } catch (e) {
        const latencyMs = Date.now() - t0;
        const errClass = e instanceof InferenceError ? e.errorClass : "unknown";
        lastErrorClass = errClass;
        const status =
          errClass === "provider_429" ? "rate_limited" : "error";
        // Per-provider error rows are separate telemetry inserts (status
        // != ok/pending so they don't count against the cap). The reserved
        // pending row stays open until the loop succeeds (finalize) or the
        // outer catch releases it.
        await writeUsage({
          userId: args.userId,
          threadId: args.threadId,
          badge,
          chain: cfg.chain,
          providerUsed: providerId,
          modelUsed: null,
          fallbackDepth: i,
          latencyMs,
          status,
          errorClass: errClass,
        });

        // Fail-closed badges (PRIVATE) MUST NOT silently fall through to a
        // less-private provider. Re-throw immediately.
        if (cfg.failClosed) throw e;
        // Per §C4: only fall through on retriable errors (429/5xx/timeout/
        // network). Non-retriable errors (bad request shape, missing creds,
        // bad response shape) indicate adapter or config bugs that further
        // providers won't fix, and silently retrying wastes spend.
        const retriable = e instanceof InferenceError ? e.retriable : false;
        if (!retriable) throw e;
        // Otherwise advance to next provider.
      }
    }

    throw new ChainExhaustedError(badge, cfg.chain, lastErrorClass);
  } catch (e) {
    // Release the reserved cap slot — the user produced no successful
    // response so they should not be debited. Best-effort: a release
    // failure leaves the slot pending until the 5-min sweep, which is
    // strictly fail-closed (slightly under-counted future cap, never over).
    if (reservedUsageId) {
      await releaseReservedUsage(reservedUsageId, args.userId).catch(() => {});
    }
    throw e;
  }
}

/**
 * Streaming variant of `runChain`. Yields a synthetic event protocol the
 * SSE route maps onto wire events:
 *
 *   { kind: "meta",  provider, model, fallbackDepth }       — once, when a provider commits
 *   { kind: "delta", text }                                  — 0..N times
 *   { kind: "done",  text, provider, model, fallbackDepth, inputTokens, outputTokens }
 *
 * Fallback semantics:
 *   - If a provider errors BEFORE emitting any delta and the error is retriable
 *     (and badge is not failClosed), advance to the next provider silently.
 *   - If a provider errors AFTER emitting deltas, we cannot restart without
 *     confusing the UI — re-throw as ChainExhaustedError. The caller (route)
 *     will emit a final `error` event; user sees a partial reply with an error.
 *   - PRIVATE always re-throws on first error (failClosed).
 */
export type ChainStreamEvent =
  | { kind: "meta"; provider: ProviderId; model: string; fallbackDepth: number }
  | { kind: "delta"; text: string }
  | {
      kind: "done";
      text: string;
      provider: ProviderId;
      model: string;
      fallbackDepth: number;
      inputTokens?: number;
      outputTokens?: number;
    };

export async function* runChainStream(
  args: RunChainArgs,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<ChainStreamEvent, void, void> {
  const { badge } = args;
  const cfg = chainFor(badge);
  if (modalityFor(cfg) === "image-out") {
    throw new ImageOutNotAvailableError(badge);
  }
  assertNoOnDeviceProviders(badge, cfg.chain);

  let reservedUsageId = args.reservedUsageId;
  if (!args.assumeCapChecked) {
    const r = await assertCap({
      userId: args.userId,
      threadId: args.threadId,
      badge,
      paidTier: args.paidTier,
    });
    reservedUsageId = r.usageId;
  } else if (!reservedUsageId) {
    // Defense-in-depth (task #8): a caller that pre-checked the cap MUST
    // also thread the reservedUsageId, or the chain runner would write a
    // fresh `ok` row on success and the pre-flight `pending` reservation
    // would linger until the 5-min sweep — double-counting one slot
    // against the daily cap. Shout loudly so the bug surfaces in the
    // operator log feed instead of silently overspending the user.
    console.error(
      "[runChain] CAP-CRITICAL: assumeCapChecked=true without reservedUsageId — " +
        "caller must pass the usageId returned by assertCap() to close the cap-accounting loop.",
    );
  }

  const fullMessages: InferenceMessage[] = [
    { role: "system", content: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ...args.messages,
  ];

  let lastErrorClass = "unknown";
  // Outer try ensures any failure path (chain exhaustion, mid-stream
  // ChainExhaustedError, fail-closed re-throw, non-retriable throw)
  // releases the reserved cap slot. UserAbortError is rethrown WITHOUT
  // releasing — the route catches it and finalizes the reservation to
  // user_abort via the in-stream finalize call (see api.chat.stream.ts
  // finalizeAbort), so the row stays for the audit trail.
  try {
  for (let i = 0; i < cfg.chain.length; i++) {
    const providerId = cfg.chain[i];
    const t0 = Date.now();
    let emittedAnyDelta = false;
    let buffer = "";
    let modelUsed: string | null = null;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      const provider = await getProvider(providerId);
      const stream = provider.generateStream
        ? provider.generateStream(
            {
              messages: fullMessages,
              maxTokens: args.maxTokens,
              temperature: args.temperature,
            },
            { signal: opts.signal },
          )
        : (async function* (): AsyncGenerator<InferenceChunk, void, void> {
            // Adapter has no streaming variant — fall back to non-streaming
            // and emit the whole reply as one delta.
            const r = await provider.generate({
              messages: fullMessages,
              maxTokens: args.maxTokens,
              temperature: args.temperature,
            });
            yield { type: "delta", text: r.text };
            yield {
              type: "done",
              model: r.model,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
            };
          })();

      for await (const chunk of stream) {
        if (chunk.type === "delta") {
          if (!emittedAnyDelta) {
            // Hand the caller the routing breadcrumb the moment a provider
            // commits — used by the UI to render the status pill live.
            yield { kind: "meta", provider: providerId, model: "", fallbackDepth: i };
          }
          emittedAnyDelta = true;
          buffer += chunk.text;
          yield { kind: "delta", text: chunk.text };
        } else {
          modelUsed = chunk.model;
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
        }
      }

      if (!emittedAnyDelta) {
        // Stream completed cleanly but never produced text. Treat as bad shape.
        throw new InferenceError(`${providerId} stream produced no text`, providerId, {
          retriable: false,
          errorClass: "bad_response_shape",
        });
      }

      const latencyMs = Date.now() - t0;
      if (reservedUsageId) {
        await finalizeReservedUsage({
          usageId: reservedUsageId,
          userId: args.userId,
          status: "ok",
          providerUsed: providerId,
          modelUsed,
          fallbackDepth: i,
          inputTokens,
          outputTokens,
          latencyMs,
        });
      } else {
        await writeUsage({
          userId: args.userId,
          threadId: args.threadId,
          badge,
          chain: cfg.chain,
          providerUsed: providerId,
          modelUsed,
          fallbackDepth: i,
          inputTokens,
          outputTokens,
          latencyMs,
          status: "ok",
        });
      }

      yield {
        kind: "done",
        text: buffer,
        provider: providerId,
        model: modelUsed ?? "",
        fallbackDepth: i,
        inputTokens,
        outputTokens,
      };
      return;
    } catch (e) {
      // User-abort takes precedence over any provider error: the upstream
      // fetch was aborted because the consumer disconnected, so a 'provider
      // failed' usage row would be misleading and we MUST NOT iterate
      // fallback providers (would re-spend tokens for a user who's gone).
      if (opts.signal?.aborted) {
        throw new UserAbortError();
      }
      const latencyMs = Date.now() - t0;
      const errClass = e instanceof InferenceError ? e.errorClass : "unknown";
      lastErrorClass = errClass;
      const status = errClass === "provider_429" ? "rate_limited" : "error";
      await writeUsage({
        userId: args.userId,
        threadId: args.threadId,
        badge,
        chain: cfg.chain,
        providerUsed: providerId,
        modelUsed,
        fallbackDepth: i,
        inputTokens,
        outputTokens,
        latencyMs,
        status,
        errorClass: errClass,
      });

      if (cfg.failClosed) throw e;
      // Cannot fall back mid-stream — would require restarting the rendered
      // text and confuse the UI.
      if (emittedAnyDelta) {
        throw new ChainExhaustedError(badge, cfg.chain, errClass);
      }
      const retriable = e instanceof InferenceError ? e.retriable : false;
      if (!retriable) throw e;
      // Otherwise advance to next provider in chain.
    }
  }

  throw new ChainExhaustedError(badge, cfg.chain, lastErrorClass);
  } catch (e) {
    // Release the reservation on any failure path EXCEPT user-abort, which
    // is finalized to status='user_abort' by the route's finalizeAbort()
    // (it has the partial assistant text and message_id we need to keep
    // for the audit trail).
    if (reservedUsageId && !(e instanceof UserAbortError)) {
      await releaseReservedUsage(reservedUsageId, args.userId).catch(() => {});
    }
    throw e;
  }
}
