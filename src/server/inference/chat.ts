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
import { capFor, chainFor, type Badge } from "./router";
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
 * Count today's successful inference_usage rows for (user, badge).
 * "Today" is wall-clock UTC date. Cap reset is implicit via this query.
 */
async function countTodayUsage(userId: string, badge: Badge): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabaseAdmin
    .from("inference_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("badge", badge)
    .eq("status", "ok")
    .gte("started_at", startOfDay.toISOString());
  if (error) throw error;
  return count ?? 0;
}

/**
 * Pre-flight cap + paidOnly check. Throws CapExceededError (and writes the
 * `cap_exceeded` usage row) before any side-effect — callers MUST run this
 * BEFORE persisting the user `chat_messages` row, or a blocked send leaves
 * an orphan user bubble in the thread on next page load (spec §C6 ordering).
 */
export async function assertCap(args: {
  userId: string;
  threadId: string | null;
  badge: Badge;
  paidTier: boolean;
}): Promise<void> {
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
  const used = await countTodayUsage(args.userId, badge);
  if (used >= cap) {
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
    });
    throw new CapExceededError(badge, used, cap);
  }
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
   * false keeps any future caller safe (re-checks; may orphan but
   * never overspends).
   */
  assumeCapChecked?: boolean;
};

export async function runChain(args: RunChainArgs): Promise<ChainResult> {
  const { badge } = args;
  const cfg = chainFor(badge);
  assertNoOnDeviceProviders(badge, cfg.chain);

  if (!args.assumeCapChecked) {
    await assertCap({
      userId: args.userId,
      threadId: args.threadId,
      badge,
      paidTier: args.paidTier,
    });
  }

  const fullMessages: InferenceMessage[] = [
    { role: "system", content: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ...args.messages,
  ];

  let lastErrorClass = "unknown";
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
  assertNoOnDeviceProviders(badge, cfg.chain);

  if (!args.assumeCapChecked) {
    await assertCap({
      userId: args.userId,
      threadId: args.threadId,
      badge,
      paidTier: args.paidTier,
    });
  }

  const fullMessages: InferenceMessage[] = [
    { role: "system", content: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ...args.messages,
  ];

  let lastErrorClass = "unknown";
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
}
