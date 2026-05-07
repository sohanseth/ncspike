/**
 * Voice profile extractor — pure, deterministic, no AI.
 *
 * Input: an array of the user's recent sent messages.
 * Output: a structural summary of how they write, used later as prompt
 * context for draft generation.
 *
 * Design notes:
 * - No external calls. No randomness. Same input → same output.
 * - Conservative by default: when signal is weak, fields are empty/null
 *   rather than confidently wrong. The downstream prompt template treats
 *   missing fields as "use a neutral default."
 * - Strips quoted reply text and obvious signature blocks before analysis.
 */

export type SentMessage = {
  /** Provider message id (Gmail message id) — for traceability only. */
  id: string;
  /** Plain-text body of the user's contribution to the thread. */
  body: string;
  /** ISO date string. */
  date: string;
  /** Subject line (used to detect re:/fwd patterns; not currently scored). */
  subject?: string;
};

export type VoiceProfile = {
  /** Most common sign-off block (e.g. "Cheers,\nSneha"). Empty string if unclear. */
  sign_off: string;
  /** Top opener phrases (first sentence of the message, normalized). */
  opener_phrases: string[];
  /** Mean sentence length in words across the corpus. 0 if no signal. */
  avg_sentence_length: number;
  /** 0 (very casual) → 1 (very formal). 0.5 = neutral / no signal. */
  formality_score: number;
  /** Up to 20 distinctive bigrams/trigrams, sorted by occurrence. */
  characteristic_phrases: string[];
  /** Number of sent messages that contributed to this profile. */
  sample_count: number;
};

const EMPTY_PROFILE: VoiceProfile = {
  sign_off: "",
  opener_phrases: [],
  avg_sentence_length: 0,
  formality_score: 0.5,
  characteristic_phrases: [],
  sample_count: 0,
};

// ---------------------------------------------------------------------------
// Cleaning helpers
// ---------------------------------------------------------------------------

/**
 * Strip quoted reply blocks and common signature delimiters.
 * Returns the user's own contribution to the thread, best-effort.
 */
export function cleanBody(raw: string): string {
  if (!raw) return "";

  let text = raw.replace(/\r\n/g, "\n");

  // Cut at "On <date>, <name> wrote:" reply markers.
  const onWroteIdx = text.search(/^On .+ wrote:$/m);
  if (onWroteIdx !== -1) text = text.slice(0, onWroteIdx);

  // Cut at "From: ... Sent: ..." Outlook-style forwarded blocks.
  const outlookIdx = text.search(/^(From|De|Von|Da):\s.+\n(Sent|Date|Enviado|Gesendet):/m);
  if (outlookIdx !== -1) text = text.slice(0, outlookIdx);

  // Cut at standard signature delimiter "-- " on its own line.
  const sigIdx = text.search(/^-- $/m);
  if (sigIdx !== -1) text = text.slice(0, sigIdx);

  // Drop quoted lines (start with ">").
  text = text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

  // Collapse runs of blank lines to a single blank line.
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"'(\[])/;

function splitSentences(body: string): string[] {
  const lines = body.split(/\n+/).filter((l) => l.trim());
  const sentences: string[] = [];
  for (const line of lines) {
    const parts = line.split(SENTENCE_SPLIT);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Sign-off detection
// ---------------------------------------------------------------------------

const SIGN_OFF_TERMS = new Set([
  "thanks",
  "thank you",
  "thanks!",
  "thx",
  "ta",
  "cheers",
  "best",
  "best regards",
  "regards",
  "kind regards",
  "warm regards",
  "warmly",
  "all the best",
  "sincerely",
  "yours",
  "yours sincerely",
  "yours truly",
  "love",
  "xx",
  "xoxo",
  "talk soon",
  "speak soon",
  "looking forward",
  "br",
  "rgds",
]);

/**
 * Pick out the sign-off block (last 1–3 short lines that look like a closing).
 * Returns the canonical form ("Cheers,\nSneha") or "" if no clear pattern.
 */
function extractSignOff(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";

  // Inspect the last up-to-4 lines.
  const tail = lines.slice(-4);
  for (let take = Math.min(3, tail.length); take >= 1; take--) {
    const candidate = tail.slice(tail.length - take);
    const first = candidate[0].toLowerCase().replace(/[,.!]+$/, "");
    if (SIGN_OFF_TERMS.has(first)) {
      // All remaining lines should be short (<5 words) — a name, not a sentence.
      if (candidate.slice(1).every((l) => wordCount(l) <= 5)) {
        return candidate.join("\n");
      }
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Opener detection
// ---------------------------------------------------------------------------

/** Normalized first sentence, trimmed to ~6 words. */
function extractOpener(body: string): string {
  const sentences = splitSentences(body);
  if (!sentences.length) return "";
  const first = sentences[0];
  const words = first.split(/\s+/).slice(0, 6).join(" ");
  return words.replace(/[,.!?]+$/, "").trim();
}

// ---------------------------------------------------------------------------
// Formality scoring
// ---------------------------------------------------------------------------

const FORMAL_MARKERS = [
  /\bdear\b/i,
  /\bregards\b/i,
  /\bsincerely\b/i,
  /\bplease find attached\b/i,
  /\bi am writing to\b/i,
  /\bplease do not hesitate\b/i,
  /\bkindly\b/i,
  /\byours (sincerely|truly|faithfully)\b/i,
];

const CASUAL_MARKERS = [
  /\bhey\b/i,
  /\bhiya\b/i,
  /\byo\b/i,
  /\bcheers\b/i,
  /\bgonna\b/i,
  /\bwanna\b/i,
  /\bkinda\b/i,
  /\bya\b/i,
  /\bhaha+\b/i,
  /\blol\b/i,
  /\bxx\b/i,
];

const CONTRACTION = /\b\w+'(s|t|re|ve|ll|d|m)\b/gi;

function scoreFormality(body: string): { score: number; signal: number } {
  let formal = 0;
  let casual = 0;
  for (const re of FORMAL_MARKERS) if (re.test(body)) formal++;
  for (const re of CASUAL_MARKERS) if (re.test(body)) casual++;

  const contractions = (body.match(CONTRACTION) || []).length;
  // Lots of contractions → casual; very few in a long-ish message → formal.
  const wc = wordCount(body);
  if (wc > 40) {
    const ratio = contractions / wc;
    if (ratio > 0.02) casual++;
    else if (ratio < 0.005) formal++;
  }

  // Exclamation marks → casual.
  const exclaims = (body.match(/!/g) || []).length;
  if (exclaims >= 2) casual++;

  const total = formal + casual;
  if (total === 0) return { score: 0.5, signal: 0 };
  return { score: formal / total, signal: total };
}

// ---------------------------------------------------------------------------
// Characteristic n-grams
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "in", "on", "at", "to",
  "for", "with", "from", "by", "as", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "can", "this", "that", "these", "those",
  "i", "you", "he", "she", "we", "they", "it", "me", "him", "her", "us", "them",
  "my", "your", "his", "their", "our", "its", "so", "not", "no", "yes",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

function extractNgrams(bodies: string[]): string[] {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    const tokens = tokenize(body);
    for (let i = 0; i < tokens.length - 1; i++) {
      const bg = `${tokens[i]} ${tokens[i + 1]}`;
      counts.set(bg, (counts.get(bg) || 0) + 1);
      if (i < tokens.length - 2) {
        const tg = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
        counts.set(tg, (counts.get(tg) || 0) + 1);
      }
    }
  }

  // Keep n-grams that appear at least 3 times — pure signal, no oneoffs.
  const ranked = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([g]) => g);

  return ranked;
}

// ---------------------------------------------------------------------------
// Public extractor
// ---------------------------------------------------------------------------

export function extractVoiceProfile(messages: SentMessage[]): VoiceProfile {
  if (!messages || messages.length === 0) return { ...EMPTY_PROFILE };

  const cleaned = messages
    .map((m) => ({ ...m, body: cleanBody(m.body) }))
    .filter((m) => wordCount(m.body) >= 5); // ignore one-liners ("ok", "thanks")

  if (cleaned.length === 0) return { ...EMPTY_PROFILE };

  // --- sign-offs: pick the most common (case-insensitive opener line) ---
  const signOffCounts = new Map<string, { display: string; count: number }>();
  for (const m of cleaned) {
    const so = extractSignOff(m.body);
    if (!so) continue;
    const key = so.toLowerCase();
    const prev = signOffCounts.get(key);
    if (prev) prev.count++;
    else signOffCounts.set(key, { display: so, count: 1 });
  }
  const topSignOff = [...signOffCounts.values()].sort((a, b) => b.count - a.count)[0];
  const sign_off = topSignOff && topSignOff.count >= 2 ? topSignOff.display : "";

  // --- openers: top distinct first-sentences (normalized) ---
  const openerCounts = new Map<string, { display: string; count: number }>();
  for (const m of cleaned) {
    const op = extractOpener(m.body);
    if (!op || wordCount(op) < 2) continue;
    const key = op.toLowerCase();
    const prev = openerCounts.get(key);
    if (prev) prev.count++;
    else openerCounts.set(key, { display: op, count: 1 });
  }
  const opener_phrases = [...openerCounts.values()]
    .filter((o) => o.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((o) => o.display);

  // --- avg sentence length ---
  let totalWords = 0;
  let totalSentences = 0;
  for (const m of cleaned) {
    const sents = splitSentences(m.body);
    totalSentences += sents.length;
    for (const s of sents) totalWords += wordCount(s);
  }
  const avg_sentence_length =
    totalSentences > 0 ? Math.round((totalWords / totalSentences) * 10) / 10 : 0;

  // --- formality ---
  let formalSum = 0;
  let signalSum = 0;
  for (const m of cleaned) {
    const f = scoreFormality(m.body);
    formalSum += f.score * f.signal;
    signalSum += f.signal;
  }
  const formality_score =
    signalSum > 0 ? Math.round((formalSum / signalSum) * 100) / 100 : 0.5;

  // --- characteristic phrases (excluding the sign-off block, which would dominate) ---
  const bodiesForNgrams = cleaned.map((m) => {
    const so = extractSignOff(m.body);
    if (!so) return m.body;
    const idx = m.body.lastIndexOf(so);
    return idx > 0 ? m.body.slice(0, idx) : m.body;
  });
  const characteristic_phrases = extractNgrams(bodiesForNgrams);

  return {
    sign_off,
    opener_phrases,
    avg_sentence_length,
    formality_score,
    characteristic_phrases,
    sample_count: cleaned.length,
  };
}

// ---------------------------------------------------------------------------
// Templates + prompt rendering (Week 2)
// ---------------------------------------------------------------------------

export const TEMPLATE_IDS = [
  "acknowledge",
  "decline",
  "schedule",
  "ask_info",
  "confirm",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

const TEMPLATE_INSTRUCTIONS: Record<TemplateId, string> = {
  acknowledge:
    "Write a short reply that acknowledges receipt and confirms you've read it. Do not commit to anything specific. 2–3 sentences.",
  decline:
    "Write a polite decline. Be warm but clear. Do not over-explain. Offer a brief reason only if obvious from context. 3–4 sentences.",
  schedule:
    "Write a short reply proposing to schedule a call or meeting. If specific free slots are provided in the email context, propose those exact times (use the human-readable form). Otherwise, ask them to share a couple of times that work. 2–3 sentences.",
  ask_info:
    "Write a short reply asking one or two clarifying questions needed before you can respond properly. 2–3 sentences.",
  confirm:
    "Write a short reply confirming the plan, detail, or arrangement raised in the email. 2–3 sentences.",
};

export type IncomingEmail = {
  subject: string;
  from: string;
  snippet: string;
  /** Full plain-text body if we could fetch it. Falls back to snippet. */
  body?: string;
  /**
   * For forwarded emails ("Fwd: …"): the parsed original sender header
   * found inside the body, e.g. "Alexandra Breslin <alex@nearform.com>".
   * When present, the reply should be addressed to this person, not `from`.
   */
  originalSender?: string;
  /**
   * Free meeting slots from the user's calendar, human-readable.
   * Only populated when template === "schedule" and Google Calendar is connected.
   * The prompt instructs the model to offer these as concrete options.
   */
  proposedSlots?: string[];
};

/** Heuristic: parse "From: …" line from a forwarded email body. */
export function parseForwardedSender(body: string): string | null {
  if (!body) return null;
  // Match "From: Name <email>" — first occurrence after a forward marker.
  const lines = body.split(/\r?\n/);
  let inForward = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-]+\s*Forwarded message\s*[-]+/i.test(line) || /^Begin forwarded message/i.test(line)) {
      inForward = true;
      continue;
    }
    if (inForward || /^From:\s+/i.test(line)) {
      const m = line.match(/^From:\s*(.+)$/i);
      if (m) return m[1].trim().replace(/^"|"$/g, "");
    }
  }
  return null;
}

/**
 * Pick the most appropriate template for an incoming email using cheap
 * deterministic rules. The caller can pass `exclude` to rotate through
 * other templates on regenerate.
 */
export function selectTemplate(
  email: IncomingEmail,
  exclude: TemplateId[] = [],
): TemplateId {
  const text = `${email.subject}\n${email.body ?? email.snippet}`.toLowerCase();
  const has = (re: RegExp) => re.test(text);

  // Order matters — first match wins among non-excluded.
  const ordered: Array<[TemplateId, boolean]> = [
    [
      "schedule",
      has(/\b(meet|meeting|call|chat|catch[\s-]?up|sync|zoom|google meet|teams|coffee|lunch|available|availability|free)\b/),
    ],
    [
      "confirm",
      has(/\b(confirm|confirming|please confirm|to confirm|just to confirm|on track|still on)\b/),
    ],
    [
      "ask_info",
      has(/\b(could you|can you|would you|please send|share|details|more info|spec|deadline|when is|what is|how many|any chance)\b/) ||
        text.trimEnd().endsWith("?"),
    ],
    [
      "decline",
      has(/\b(invitation|invite|opportunity|offer|partnership|collaborat|sponsor|guest post|feature|interview)\b/),
    ],
    ["acknowledge", true], // fallback always matches
  ];

  for (const [id, matched] of ordered) {
    if (matched && !exclude.includes(id)) return id;
  }
  // All excluded? rotate from the start anyway.
  return ordered.find(([id]) => !exclude.includes(id))?.[0] ?? "acknowledge";
}

function senderFirstName(from: string): string {
  // "Alex Smith <alex@x.com>" → "Alex"
  const namePart = from.split("<")[0].trim().replace(/^"|"$/g, "");
  if (!namePart) return "";
  const first = namePart.split(/\s+/)[0];
  // Skip obvious non-names ("noreply", "support", etc.)
  if (/^(no[-_]?reply|support|hello|hi|info|admin|notifications)$/i.test(first)) return "";
  return first;
}

function describeFormality(score: number): string {
  if (score < 0.25) return "very casual (uses contractions, short sentences, light tone)";
  if (score < 0.45) return "casual";
  if (score < 0.6) return "neutral";
  if (score < 0.8) return "professional";
  return "formal (full sentences, no contractions, no slang)";
}

/**
 * Build the prompt sent to the inference provider. Returns system + user
 * messages ready for the chat-completions API.
 */
export function renderDraftPrompt(
  profile: VoiceProfile,
  template: TemplateId,
  email: IncomingEmail,
): { system: string; user: string } {
  const voiceLines: string[] = [];
  voiceLines.push(`- Tone: ${describeFormality(profile.formality_score)}.`);
  if (profile.avg_sentence_length > 0) {
    voiceLines.push(
      `- Average sentence length: ~${Math.round(profile.avg_sentence_length)} words.`,
    );
  }
  if (profile.opener_phrases.length) {
    voiceLines.push(
      `- Common openers they use: ${profile.opener_phrases.slice(0, 3).map((o) => `"${o}"`).join(", ")}.`,
    );
  }
  if (profile.characteristic_phrases.length) {
    voiceLines.push(
      `- Phrases they use often: ${profile.characteristic_phrases.slice(0, 8).map((p) => `"${p}"`).join(", ")}.`,
    );
  }
  const signOff = profile.sign_off || "Thanks";

  const system = [
    "You write email replies in the voice of a specific person. Match their tone, sentence rhythm, and habitual phrases. Do not invent commitments, dates, names, or facts not present in the incoming email.",
    "",
    "Voice profile:",
    voiceLines.join("\n"),
    "",
    `End with this exact sign-off:\n${signOff}`,
    "",
    "Output rules:",
    "- Reply body only. No subject line. No quoted original. No 'Sure!' meta-commentary.",
    "- Do not include placeholders like [Name] or [date]. If you don't know something, ask for it instead of inventing.",
    "- Keep it tight. No filler.",
  ].join("\n");

  // For forwarded mail, the real recipient of the reply is the original sender,
  // not whoever forwarded it. Address them by first name.
  const replyTo = email.originalSender || email.from;
  const recipient = senderFirstName(replyTo);
  const greeting = recipient ? `Address them as "${recipient}".` : "Use a neutral greeting (no name).";

  // Trim body for the prompt — keep cost bounded and avoid prompt-injection
  // surface area from very long forwards.
  const fullBody = (email.body ?? email.snippet ?? "").trim();
  const truncated = fullBody.length > 4000 ? fullBody.slice(0, 4000) + "\n[...truncated]" : fullBody;

  const lines: string[] = [
    `Incoming email:`,
    `From (envelope): ${email.from}`,
  ];
  if (email.originalSender && email.originalSender !== email.from) {
    lines.push(`This is a FORWARDED message. Reply to the original sender: ${email.originalSender}`);
  }
  lines.push(
    `Subject: ${email.subject}`,
    `Body:`,
    truncated,
    "",
  );
  if (email.proposedSlots && email.proposedSlots.length > 0) {
    lines.push(
      `Free slots on the user's calendar (offer these as concrete options):`,
      ...email.proposedSlots.map((s) => `  - ${s}`),
      "",
    );
  }
  lines.push(
    `Task: ${TEMPLATE_INSTRUCTIONS[template]}`,
    `Reply to ${recipient || "the sender"} based on what they actually wrote — reference specific details from the body. Do NOT just acknowledge receipt.`,
    greeting,
  );

  return { system, user: lines.join("\n") };
}
