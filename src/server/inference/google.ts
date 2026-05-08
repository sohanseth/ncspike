/**
 * Google AI (Gemini) provider via the generativelanguage.googleapis.com API.
 * Default model: gemini-2.5-flash. Free tier: 15 RPM, 1M tok/day shared.
 * Model id verified live via ListModels 2026-05-08.
 *
 * Required env: GOOGLE_AI_API_KEY
 * Optional env: GOOGLE_AI_MODEL (override default)
 *
 * The Gemini API uses a different message shape than OpenAI-compatible APIs:
 * `contents: [{ role, parts: [{ text }] }]` and "system" maps to a separate
 * `systemInstruction` field, not a contents item.
 */
import {
  InferenceError,
  type InferenceMessage,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

const DEFAULT_MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 15_000;

type GeminiContent = { role: "user" | "model"; parts: Array<{ text: string }> };

function toGeminiShape(messages: InferenceMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
} {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemTexts.push(m.content);
    } else {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
  }
  return {
    contents,
    ...(systemTexts.length > 0
      ? { systemInstruction: { parts: [{ text: systemTexts.join("\n\n") }] } }
      : {}),
  };
}

export const googleProvider: InferenceProvider = {
  id: "google",
  privacyTier: 2,

  async generate(req: InferenceRequest): Promise<InferenceResult> {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    const model = process.env.GOOGLE_AI_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
      throw new InferenceError("Missing GOOGLE_AI_API_KEY", "google", {
        errorClass: "missing_credentials",
      });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const body = {
      ...toGeminiShape(req.messages),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 512,
        temperature: req.temperature ?? 0.4,
      },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const isAbort = (e as { name?: string })?.name === "AbortError";
      throw new InferenceError(
        isAbort ? "Google AI request timed out" : "Google AI fetch failed",
        "google",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new InferenceError("Google AI HTTP 429", "google", {
        retriable: true,
        errorClass: "provider_429",
      });
    }
    if (res.status >= 500) {
      throw new InferenceError(`Google AI HTTP ${res.status}`, "google", {
        retriable: true,
        errorClass: "provider_5xx",
      });
    }
    if (!res.ok) {
      throw new InferenceError(`Google AI HTTP ${res.status}`, "google", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = json.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new InferenceError("Google AI returned empty response", "google", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    return {
      text,
      provider: "google",
      model,
      inputTokens: json.usageMetadata?.promptTokenCount,
      outputTokens: json.usageMetadata?.candidatesTokenCount,
    };
  },
};
