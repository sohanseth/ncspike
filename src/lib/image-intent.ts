/**
 * Phase 2.9b — image-intent heuristic shared between client and server.
 *
 * Lifted out of `src/server/inference/imagegen.ts` so the client-side
 * dispatcher in `chat-stream.ts` can fork PRIVATE turns to the WebGPU
 * on-device image-gen runner BEFORE any network round-trip. The server
 * still re-runs the same heuristic as defense-in-depth (the route can't
 * trust the client to have classified the intent correctly), so both
 * sides stay in sync by importing the same function.
 *
 * Pure: no DOM, no Node, no Supabase. Safe to import from anywhere.
 */
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
