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
import { capFor, chainFor, type Badge } from "./router";
import { costMicroUsd } from "./pricing";
import type { ProviderId } from "./tiers";

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
  // Telemetry must never break the request path — log and swallow.
  if (error) console.error("[inference_usage] insert failed:", error.message);
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
};

export async function runChain(args: RunChainArgs): Promise<ChainResult> {
  const { badge } = args;
  const cfg = chainFor(badge);

  // Free users see the upsell, not an error chain attempt.
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

  // Cap check (status='ok' only, per §C3 — failed attempts don't burn quota).
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
