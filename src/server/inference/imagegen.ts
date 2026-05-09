/**
 * Image generation / editing turn for the chat panel.
 *
 * Routes through Lovable AI Gateway using Google's image-output models:
 *   - google/gemini-3.1-flash-image-preview (default — fast, supports edit)
 *   - google/gemini-3-pro-image-preview (higher quality, used for "genius")
 *
 * The model returns a base64 data URL in
 * `choices[0].message.images[0].image_url.url`. We decode it, upload to the
 * private `chat-attachments` bucket under `{userId}/imagegen/{uuid}.png`,
 * and return a storage path the caller can persist as a chat attachment row.
 */
import type { Badge } from "./router";
import type { ProviderId } from "@/lib/provider-tiers";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOVABLE_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const TIMEOUT_MS = 90_000;

export type ImageGenAttachment = {
  bytes: Uint8Array;
  mime: string;
};

export type ImageGenTurnArgs = {
  badge: Badge;
  userId: string;
  history: { role: "user" | "assistant"; content: string }[];
  userText: string;
  /** Optional source images for edit / variation. */
  attachments: ImageGenAttachment[];
  signal?: AbortSignal;
};

export type ImageGenTurnResult = {
  text: string;
  storagePath: string;
  signedUrl: string;
  mime: string;
  bytes: number;
  provider: ProviderId;
  model: string;
};

function pickModel(badge: Badge): string {
  if (badge === "genius" || badge === "pro") return "google/gemini-3-pro-image-preview";
  return "google/gemini-3.1-flash-image-preview";
}

/** Heuristic: does this turn look like an image generation/edit request? */
export function detectImageIntent(args: {
  text: string;
  hasAttachments: boolean;
}): boolean {
  const t = args.text.toLowerCase();
  // Edit case: attachment + a verb that implies modification.
  const editVerbs =
    /\b(edit|modify|change|alter|add|remove|replace|recolor|colou?r|turn (it|this) into|make (it|this|him|her|them)|put|give (it|him|her|them)|swap|crop|rotate|enhance|upscale|restyle|redraw|render)\b/;
  if (args.hasAttachments && editVerbs.test(t)) return true;

  // Generate case: explicit verbs + image/picture/photo/etc nouns.
  const genVerbs =
    /\b(generate|create|make|draw|paint|design|render|produce|illustrate|sketch|imagine|visualize|visualise|show me)\b/;
  const visualNouns =
    /\b(image|picture|photo|photograph|illustration|drawing|painting|sketch|logo|icon|poster|wallpaper|portrait|render|artwork|art|scene|comic|meme|avatar|sticker|graphic|banner|thumbnail|mockup)\b/;
  if (genVerbs.test(t) && visualNouns.test(t)) return true;

  // Direct phrasings.
  if (
    /\b(image of|picture of|photo of|drawing of|painting of|illustration of)\b/.test(t)
  )
    return true;

  return false;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("Image model returned malformed data URL");
  const mime = m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

function extOf(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}

export async function runImageGenTurn(
  args: ImageGenTurnArgs,
): Promise<ImageGenTurnResult> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY missing");
  const model = pickModel(args.badge);

  // Build OpenAI-style messages. Source images (for edit) go inline as image
  // parts on the user turn — Gemini image-out models accept the same
  // multimodal shape as the vision models.
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  const promptText =
    args.userText.trim() ||
    (args.attachments.length > 0
      ? "Edit the attached image."
      : "Generate an image.");
  userContent.push({ type: "text", text: promptText });
  for (const att of args.attachments) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${att.mime};base64,${bytesToBase64(att.bytes)}` },
    });
  }

  const messages = [
    {
      role: "system",
      content:
        "You are an image generation assistant. When the user requests an image " +
        "(creation or editing), produce the image directly. Do not refuse capability.",
    },
    ...args.history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
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
        modalities: ["image", "text"],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Image gateway HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        images?: Array<{ image_url?: { url?: string } }>;
      };
    }>;
  };
  const msg = json.choices?.[0]?.message;
  const dataUrl = msg?.images?.[0]?.image_url?.url;
  if (!dataUrl) {
    throw new Error("Image model returned no image");
  }
  const { bytes, mime } = decodeDataUrl(dataUrl);
  const captionRaw = (msg?.content ?? "").trim();
  const caption = captionRaw || "Here's the image you asked for.";

  const uuid = crypto.randomUUID();
  const storagePath = `${args.userId}/imagegen/${uuid}.${extOf(mime)}`;
  const up = await supabaseAdmin.storage
    .from("chat-attachments")
    .upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (up.error) {
    throw new Error(`Image upload failed: ${up.error.message}`);
  }
  const sign = await supabaseAdmin.storage
    .from("chat-attachments")
    .createSignedUrl(storagePath, 60 * 60 * 24);

  return {
    text: caption,
    storagePath,
    signedUrl: sign.data?.signedUrl ?? "",
    mime,
    bytes: bytes.length,
    provider: "google" as ProviderId,
    model,
  };
}
