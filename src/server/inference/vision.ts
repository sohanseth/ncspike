/**
 * Single-shot multimodal (text + image) turn for the chat panel.
 *
 * Vision lives OUTSIDE the regular `runChainStream` because the chain runner
 * assumes `InferenceMessage.content: string`. Adding multimodal there would
 * require refactoring every adapter + persistence row. Instead, when a turn
 * has attachments, the SSE route bypasses the chain and calls
 * `runVisionTurn` which:
 *
 *   - picks one vision-capable model per badge (PRIVATE = Cloudflare Llama
 *     3.2 11B Vision, fail-closed; others = Lovable AI Gateway)
 *   - returns the full reply as one chunk (no token streaming for v1)
 *
 * The route then yields it as a single SSE delta + done event so the client
 * pipeline is unchanged.
 */
import type { Badge } from "./router";
import type { ProviderId } from "@/lib/provider-tiers";

const LOVABLE_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** What the route hands us per attachment after it's signed-URL'd a storage path. */
export type VisionAttachment = {
  /** Signed URL the model can fetch (used by Lovable gateway). */
  url: string;
  /** Raw bytes (used by Cloudflare which wants inline byte arrays). */
  bytes: Uint8Array;
  mime: string;
};

export type VisionTurnArgs = {
  badge: Badge;
  /** History as plain text (assistant + user). System prompt added below. */
  history: { role: "user" | "assistant"; content: string }[];
  /** Current user message text. */
  userText: string;
  attachments: VisionAttachment[];
  systemPrompt?: string;
  signal?: AbortSignal;
};

export type VisionTurnResult = {
  text: string;
  provider: ProviderId;
  model: string;
};

const DEFAULT_VISION_SYSTEM =
  "You are NeuralConnexions. The user has attached one or more images. " +
  "Describe what you see plainly, answer their question if asked, and stay concise.";

const TIMEOUT_MS = 60_000;

/** Vision model picker. PRIVATE stays on Cloudflare to preserve fail-closed. */
function pickVisionModel(badge: Badge): { provider: ProviderId; model: string } {
  switch (badge) {
    case "private":
      return { provider: "cloudflare", model: "@cf/meta/llama-3.2-11b-vision-instruct" };
    case "genius":
      return { provider: "openai", model: "openai/gpt-5" };
    case "pro":
      return { provider: "openai", model: "openai/gpt-5" };
    case "flash":
    default:
      return { provider: "google", model: "google/gemini-3-flash-preview" };
  }
}

export async function runVisionTurn(args: VisionTurnArgs): Promise<VisionTurnResult> {
  const pick = pickVisionModel(args.badge);
  if (pick.provider === "cloudflare") {
    return runCloudflareVision(args, pick.model);
  }
  return runLovableVision(args, pick.model, pick.provider);
}

/* ------------------------------------------------------------------ */
/*  Cloudflare path — PRIVATE                                          */
/* ------------------------------------------------------------------ */

async function runCloudflareVision(
  args: VisionTurnArgs,
  model: string,
): Promise<VisionTurnResult> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("PRIVATE vision unavailable: Cloudflare credentials missing.");
  }

  // Llama 3.2 11B Vision on Workers AI accepts a single image as a byte array
  // alongside a text prompt. For multiple images we describe them sequentially:
  // first image is the primary; subsequent images get a short prefix so the
  // model knows there are more. (Worker AI's vision endpoints don't yet accept
  // multi-image batches.)
  if (args.attachments.length === 0) {
    throw new Error("Vision turn called without attachments");
  }

  const promptParts: string[] = [];
  if (args.systemPrompt) promptParts.push(args.systemPrompt);
  else promptParts.push(DEFAULT_VISION_SYSTEM);
  for (const h of args.history.slice(-6)) {
    promptParts.push(`${h.role === "user" ? "User" : "Assistant"}: ${h.content}`);
  }
  if (args.attachments.length > 1) {
    promptParts.push(
      `(The user attached ${args.attachments.length} images; the first is shown below.)`,
    );
  }
  promptParts.push(`User: ${args.userText || "Describe this image."}`);
  promptParts.push("Assistant:");

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  if (args.signal) {
    if (args.signal.aborted) ctrl.abort();
    else args.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  const doFetch = () =>
    fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: promptParts.join("\n\n"),
        image: Array.from(args.attachments[0].bytes),
        max_tokens: 1024,
      }),
    });

  let res: Response;
  try {
    res = await doFetch();
    // Llama 3.2 vision requires a one-time community-license acceptance per
    // account. Cloudflare returns 403 with a "Model Agreement" message until
    // the account submits `{ prompt: "agree" }`. Auto-accept and retry once.
    if (res.status === 403) {
      const body = await res.clone().text().catch(() => "");
      if (/Model Agreement/i.test(body)) {
        await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "agree" }),
        }).catch(() => null);
        res = await doFetch();
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloudflare vision HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    success?: boolean;
    result?: { response?: string; description?: string };
  };
  const text = json.result?.response ?? json.result?.description ?? "";
  if (!text) throw new Error("Cloudflare vision returned empty response");
  return { text: text.trim(), provider: "cloudflare", model };
}

/* ------------------------------------------------------------------ */
/*  Lovable Gateway path — Flash / Pro / Genius                        */
/* ------------------------------------------------------------------ */

async function runLovableVision(
  args: VisionTurnArgs,
  model: string,
  providerId: ProviderId,
): Promise<VisionTurnResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

  // Build OpenAI-compatible multimodal messages. Image content parts use
  // data URLs (base64) since Lovable gateway can't fetch our private
  // signed URLs from inside the model host with auth.
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  if (args.userText.trim()) {
    userContent.push({ type: "text", text: args.userText });
  } else {
    userContent.push({ type: "text", text: "Describe what you see." });
  }
  for (const att of args.attachments) {
    const b64 = bytesToBase64(att.bytes);
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${att.mime};base64,${b64}` },
    });
  }

  const messages = [
    { role: "system", content: args.systemPrompt || DEFAULT_VISION_SYSTEM },
    ...args.history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent },
  ];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  if (args.signal) {
    if (args.signal.aborted) ctrl.abort();
    else args.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(LOVABLE_GATEWAY_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 1024,
        temperature: 0.4,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Vision gateway HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Vision gateway returned empty response");
  return { text: text.trim(), provider: providerId, model };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Worker runtime supports btoa but not directly on Uint8Array. Chunked
  // String.fromCharCode avoids "argument list too long" on large blobs.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}
