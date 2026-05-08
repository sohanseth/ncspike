/**
 * Provider-agnostic types for the inference abstraction.
 * Add a new provider by implementing `InferenceProvider` and registering
 * it in `index.ts`.
 *
 * Day 1 of D7 ships only `generate()` (non-streaming). `generateStream()`
 * is added on Day 3 alongside the SSE wiring.
 */
import type { PrivacyTier, ProviderId } from "@/lib/provider-tiers";

export type InferenceMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type InferenceRequest = {
  messages: InferenceMessage[];
  /** Soft cap on output tokens. Providers may interpret loosely. */
  maxTokens?: number;
  /** 0 = deterministic, 1 = creative. Default 0.4. */
  temperature?: number;
};

export type InferenceResult = {
  text: string;
  /** Provider id used, for observability. */
  provider: string;
  /** Model id used, for observability. */
  model: string;
  /** Provider-reported token counts. May be undefined for providers that don't report. */
  inputTokens?: number;
  outputTokens?: number;
};

export class InferenceError extends Error {
  /** True if the dispatcher should try the next provider in the chain. */
  public readonly retriable: boolean;
  /** Closed enum class for telemetry; never log the underlying message. */
  public readonly errorClass:
    | "provider_429"
    | "provider_5xx"
    | "timeout"
    | "network"
    | "bad_response_shape"
    | "missing_credentials"
    | "unknown";

  constructor(
    message: string,
    public readonly provider: string,
    opts: {
      retriable?: boolean;
      errorClass?: InferenceError["errorClass"];
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "InferenceError";
    this.retriable = opts.retriable ?? false;
    this.errorClass = opts.errorClass ?? "unknown";
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/**
 * A single streaming output token batch.
 *
 * `delta` events arrive 0..N times during a stream and carry incremental text.
 * `done` arrives exactly once at the end with final usage + model id.
 *
 * Adapters MUST normalize their wire format (OpenAI SSE / Anthropic event SSE
 * / Cloudflare NDJSON / Gemini SSE) into this shape so the chain runner is
 * provider-agnostic.
 */
export type InferenceChunk =
  | { type: "delta"; text: string }
  | {
      type: "done";
      model: string;
      inputTokens?: number;
      outputTokens?: number;
    };

export type InferenceProvider = {
  id: ProviderId;
  /** Privacy tier per docs/06 §B4. Higher = stricter. */
  privacyTier: PrivacyTier;
  generate(req: InferenceRequest): Promise<InferenceResult>;
  /**
   * Optional streaming variant. Adapters that do not implement it cause the
   * chain runner to fall back to `generate()` and emit a single `delta` with
   * the full text (no "fake streaming" — the user just sees the reply land
   * all at once for that provider). Day 3 of D7 ships streaming for all six.
   *
   * `opts.signal` lets the caller propagate user-abort all the way to the
   * upstream HTTP fetch, so we don't keep paying for tokens after the user
   * navigates away.
   */
  generateStream?(
    req: InferenceRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<InferenceChunk, void, void>;
};
