/**
 * Lovable AI Gateway provider. Uses the project's built-in LOVABLE_API_KEY,
 * so no extra setup required. Default model: google/gemini-3-flash-preview.
 */
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

const DEFAULT_MODEL = "google/gemini-3-flash-preview";

export const lovableProvider: InferenceProvider = {
  id: "lovable",

  async generate(req: InferenceRequest): Promise<InferenceResult> {
    const apiKey = process.env.LOVABLE_API_KEY;
    const model = process.env.LOVABLE_AI_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
      throw new InferenceError("Missing LOVABLE_API_KEY", "lovable");
    }

    let res: Response;
    try {
      res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.4,
        }),
      });
    } catch (e) {
      throw new InferenceError("Lovable AI fetch failed", "lovable", e);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new InferenceError(
        `Lovable AI HTTP ${res.status}: ${body.slice(0, 500)}`,
        "lovable",
      );
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new InferenceError("Lovable AI returned empty response", "lovable");
    }

    return { text, provider: "lovable", model };
  },
};
