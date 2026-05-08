/**
 * Provider price table for cost telemetry. See docs/05-spec-phase-2.6-chat-providers.md §C7.
 *
 * Prices in micro-USD per 1,000,000 tokens (USD × 10⁶).
 * Reviewed quarterly — out-of-date pricing causes CPAUD drift, not crashes.
 *
 * `cost_micro_usd` accumulates as bigint in inference_usage; float drift on
 * sum() over many rows would be real otherwise.
 */
import type { ProviderId } from "./tiers";

export type Price = {
  /** micro-USD per 1M input tokens */
  input: number;
  /** micro-USD per 1M output tokens */
  output: number;
};

export const PRICING: Record<ProviderId, Price> = {
  groq: { input: 590_000, output: 790_000 },          // Llama 3.3 70B
  google: { input: 300_000, output: 2_500_000 },      // Gemini 2.5 Flash
  cloudflare: { input: 110_000, output: 110_000 },    // Workers AI estimate
  openai: { input: 150_000, output: 600_000 },        // GPT-4o-mini
  anthropic: { input: 1_000_000, output: 5_000_000 }, // Claude Haiku 4.5
  lovable: { input: 300_000, output: 2_500_000 },     // mirrors Gemini 2.5 Flash
};

/** Compute cost in micro-USD from token counts. Either count may be undefined. */
export function costMicroUsd(
  provider: ProviderId,
  inputTokens?: number,
  outputTokens?: number,
): bigint {
  const p = PRICING[provider];
  const inMicro = BigInt(Math.round(((inputTokens ?? 0) * p.input) / 1_000_000));
  const outMicro = BigInt(Math.round(((outputTokens ?? 0) * p.output) / 1_000_000));
  return inMicro + outMicro;
}
