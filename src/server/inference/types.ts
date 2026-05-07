/**
 * Provider-agnostic types for the inference abstraction.
 * Add a new provider by implementing `InferenceProvider` and registering
 * it in `index.ts`.
 */

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
};

export class InferenceError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

export type InferenceProvider = {
  id: string;
  generate(req: InferenceRequest): Promise<InferenceResult>;
};
