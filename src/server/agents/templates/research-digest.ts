/**
 * Phase 3.0 — ResearchDigest, the first concrete AgentTemplate.
 *
 * docs/16 §13 + docs/13 §7.1. Pulls relevant articles on user-chosen
 * topics via SearXNG, scores them for relevance with an LLM, and
 * summarises the top hits into findings.
 *
 * **Invariant pass-condition for PR3b (Sneha):** this file implements
 * the generic AgentTemplate<TConfig, TItem> contract from
 * `../types.ts`. The generic runner (`../runner.ts`) drives it without
 * any template-specific code. If implementing this template had required
 * runner changes, the abstraction was wrong — the answer would have
 * been to fix the contract, not patch the runner.
 *
 *
 * **Privacy:** the broker `fragment` is forwarded opaquely to the LLM
 * as a system prompt. ResearchDigest never inspects it, never extracts
 * sub-values, and never echoes user content into agent_runs.error or
 * structured logs (errors that bubble out hit the runner's scrubber).
 */
import { z } from "zod";
import { runSearch } from "@/lib/search.functions";
import { generate } from "@/server/inference";
import { costMicroUsd as pricingCostMicroUsd } from "@/server/inference/pricing";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ProviderId } from "@/lib/provider-tiers";
import { recordCost } from "../budget";
import { scrubErrorMessage } from "../error-scrub";
import type {
  AgentTemplate,
  BriefingKeptItem,
  BriefingResult,
  FindingDraft,
  TemplateCallContext,
} from "../types";

// ─── Config + item types ──────────────────────────────────────────────────

/**
 * Per-agent config stored as JSONB on `agents.config`. Validated by the
 * `configSchema` Zod schema below; agent-creation code calls
 * `template.configSchema.parse(raw)` before INSERT.
 */
export const ResearchDigestConfigSchema = z.object({
  /** 1–5 topics. Each runs through SearXNG separately. */
  topics: z.array(z.string().min(1).max(120)).min(1).max(5),
  /** Reserved for future "only consider items newer than X hours" filter. */
  lookbackHours: z.number().int().min(1).max(168).default(24),
  /** Floor for `template.score` — items below are dropped before summarise. */
  minScore: z.number().min(0).max(1).default(0.5),
});

export type ResearchDigestConfig = z.infer<typeof ResearchDigestConfigSchema>;

export type ResearchItem = {
  url: string;
  title: string;
  snippet: string;
  /** Which engine inside SearXNG returned it (Google/Bing/DDG/...). */
  engine?: string;
  /** Which SearXNG instance served the result (for telemetry only). */
  instance?: string | null;
  /** Topic that produced this hit — for the score/summarise prompt. */
  matchedTopic: string;
};

// ─── URL canonicalisation (dedupe key) ────────────────────────────────────

/**
 * Strip the common tracking variants so two requests for the same
 * article from different campaigns dedupe correctly. Conservative:
 * leave path + query alone except for known-noisy params.
 *
 * Lowercased host + trailing slash stripped + utm_* / fbclid / gclid / mc_*
 * dropped. We deliberately do NOT touch the path or fragment so two
 * articles at /a/123 vs /a/124 stay distinct.
 */
const TRACKING_PARAM_PREFIXES = ["utm_", "mc_"];
const TRACKING_PARAM_EXACT = new Set([
  "fbclid",
  "gclid",
  "ref",
  "ref_src",
  "igshid",
  "yclid",
  "spm",
]);

export function canonicaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.host = u.host.toLowerCase();
    // Drop tracking params.
    const keep: Array<[string, string]> = [];
    for (const [k, v] of u.searchParams.entries()) {
      const isTracking =
        TRACKING_PARAM_EXACT.has(k) ||
        TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p));
      if (!isTracking) keep.push([k, v]);
    }
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    // Strip trailing slash on the path (but not for the root path).
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    // Drop the fragment — same article from a TOC link should dedupe.
    u.hash = "";
    return u.toString();
  } catch {
    // Malformed URL — fall back to the raw string. The runner's UNIQUE
    // constraint on (agent_id, dedupe_key) still prevents storage dupes.
    return raw;
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────

function scorePrompt(item: ResearchItem, topics: string[]): string {
  // Constrained-output prompt: model returns one number, nothing else.
  // We parseFloat the first token; everything after is discarded.
  return [
    `Rate how relevant this article is to the user's interest topics on a 0.0–1.0 scale.`,
    `Topics: ${topics.join(", ")}`,
    `Article title: ${item.title}`,
    `Snippet: ${item.snippet}`,
    `Reply with ONE number between 0.0 and 1.0. No words.`,
  ].join("\n");
}

// ─── Score parsing ────────────────────────────────────────────────────────

/**
 * Parse the LLM's score reply into [0, 1]. Tolerant of trailing
 * commentary, percentage signs, and "0.7/1" form. Returns 0 on
 * unparseable input — the floor filter then drops it like any other
 * irrelevant item.
 */
export function parseScoreReply(reply: string): number {
  const m = reply.trim().match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  let n = parseFloat(m[0]);
  if (!Number.isFinite(n)) return 0;
  // Percentage tolerance: only INTEGER replies > 1 are treated as
  // percentages ("75" → 0.75). A float reply like "1.5" was probably
  // a model overshoot or a malformed 1.0+; clip instead of dividing.
  if (Number.isInteger(n) && n > 1 && n <= 100) n = n / 100;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── The template ─────────────────────────────────────────────────────────

// ─── Briefing v2 layer (added 2026-05-18 per docs/19 + docs/20) ───────────
//
// v2 inverts the page: the briefing IS the product, findings are evidence,
// sources collapse to a <details> list below. Per-source LLM summaries are
// removed entirely. The briefing's prompt uses the Tavily snippet from
// agent_findings.payload as its scratch material — one LLM call replaces
// the v1 per-item summarise loop (~16x cost reduction for a 15-item run).
//
// Cross-run continuity: each run fetches the most recent prior v2 briefing
// for the same agent and includes it in the prompt as "what you said last
// time." The LLM frames this run's briefing as a delta against the prior,
// with per-item provenance tags (new / continuing / recurring) so the inbox
// can surface "NEW" badges.
//
// Failure handling per docs/19 §3 + docs/20 §6: human-voice failure
// briefings (no HTTP codes in the user surface), classified by
// InferenceError.errorClass into 4 copy variants. Failures are visible —
// the deterministic v1 fallback was wrong because users couldn't
// distinguish real synthesis from scaffolding.
//
// Load-bearing principle (docs/19): "The agent's job is to reduce
// repeated cognition across time, not to summarise every source in the
// current batch." Any change to this file that re-introduces per-source
// paragraphs in the user surface violates the principle.

const BRIEFING_PROVENANCE = ["new", "continuing", "recurring"] as const;
type BriefingProvenance = (typeof BRIEFING_PROVENANCE)[number];

const BRIEFING_FAILURE_CLASSES = [
  "rate_limited",
  "chain_exhausted",
  "malformed",
  "generic",
] as const;

/** Source-input cap per docs/19 §10.2 / docs/20 §11.2 — score-desc top 20. */
const BRIEFING_INPUT_CAP = 20;

/** Failure classification → user-facing copy. Docs/20 §6. No HTTP codes
 *  in user surface; diagnostics go to agent_runs.error only.
 *
 *  ALSO persisted on the briefing payload (as `failureClass`) so the
 *  next run's prior-briefing fetch can skip failure briefings — they
 *  shouldn't pollute the LLM's prior-context memory with "I couldn't
 *  complete this check..." text (Sneha review feedback, 2026-05-18). */
type FailureClass = (typeof BRIEFING_FAILURE_CLASSES)[number];
type FailureCopy = { headline: string; synthesis: string };
const FAILURE_COPY: Record<FailureClass, FailureCopy> = {
  rate_limited: {
    headline: "I couldn't complete this check — the search provider was rate-limited.",
    synthesis: "I'll try again on the next run. Raw sources are below if you want to scan them yourself.",
  },
  chain_exhausted: {
    headline: "I couldn't complete this check — none of my LLM providers were available.",
    synthesis: "This usually clears within an hour. Raw sources are below.",
  },
  malformed: {
    headline: "I couldn't complete this check — my synthesis step produced unusable output.",
    synthesis: "Raw sources are below if you want to scan them yourself.",
  },
  generic: {
    headline: "I couldn't complete this check for this run.",
    synthesis: "I'll try again on the next run. Raw sources are below.",
  },
};

/** Cross-run delta block per docs/19 §1. Optional on first run. */
const BriefingDeltaSchema = z.object({
  whatsNew: z.string().min(1).max(600),
  whatsContinuing: z.string().max(400).optional(),
  whatsChanged: z.string().max(400).optional(),
});

export const ResearchDigestBriefingV2Schema = z.object({
  // ─── Shell (architecture, docs/19 §1) ────────────────────────────────
  version: z.literal(2),
  kind: z.literal("research"),
  headline: z.string().min(1).max(280),
  synthesis: z.string().min(1).max(600),
  delta: BriefingDeltaSchema.optional(),
  qualityNote: z.string().min(1).max(400).optional(),
  /** Present ONLY on failure briefings — marks the briefing as the
   *  output of the failure-handling path rather than real LLM synthesis.
   *  The next run's prior-briefing fetch filters these out so failure
   *  language doesn't pollute the LLM's "what you said last time"
   *  context. Empty-batch briefings (legitimate "nothing matched")
   *  do NOT set this field; they're real synthesis of zero results. */
  failureClass: z.enum(BRIEFING_FAILURE_CLASSES).optional(),

  // ─── Research-specific (docs/20 §2) ──────────────────────────────────
  memorableTakeaways: z
    .array(
      z.object({
        text: z.string().min(1).max(280),
        supportSourceKeys: z.array(z.string()).min(0),
        provenance: z.enum(BRIEFING_PROVENANCE),
      }),
    )
    .min(0)
    .max(8),
  readFirst: z
    .array(
      z.object({
        sourceKey: z.string().min(1),
        reason: z.string().min(1).max(400),
        provenance: z.enum(BRIEFING_PROVENANCE),
      }),
    )
    .min(0)
    .max(5),
  skipOrCollapse: z
    .array(
      z.object({
        reason: z.string().min(1).max(400),
        sourceKeys: z.array(z.string()).min(0),
      }),
    )
    .min(0),
  distinctIdeas: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        summary: z.string().min(1).max(400),
        sourceKeys: z.array(z.string()).min(0),
      }),
    )
    .min(0)
    .max(8),
  nextSearchSuggestions: z.array(z.string().min(1).max(160)).min(0).max(5),
});

export type ResearchDigestBriefingV2 = z.infer<typeof ResearchDigestBriefingV2Schema>;

// ─── v3 briefing schema (docs/25, 2026-05-19) ────────────────────────────
//
// Prose-shaped briefing. The structured v2 shape (memorableTakeaways[],
// readFirst[], skipOrCollapse[], distinctIdeas[]) is replaced by a single
// prose body + exactly-3 keepInMind list + optional broker-driven personal
// relevance + optional what's-new callout. v2 schema stays in this file
// for the inbox's legacy render path; the briefing function only emits v3
// for new runs.
//
// Sneha review 2026-05-19 framing: the artifact was a citation aggregator
// dressed up as a briefing. v3 makes it prose-in-agent-voice with
// scaffolding for skim mode (three-things + whatsNew callout) and depth
// mode (the prose body itself). Source references are inline [n] anchors.

/** Normalized source record for inline [n] references in v3 proseBody. */
const BriefingSourceV3Schema = z.object({
  dedupeKey: z.string().min(1),
  title: z.string().min(1).max(500),
  url: z.string().min(1).max(2000),
  domain: z.string().min(1).max(255),
});

export const ResearchDigestBriefingV3Schema = z.object({
  version: z.literal(3),
  kind: z.literal("research"),

  /** Exactly 3 imperative statements. Compression discipline — the LLM
   *  cannot return 0/1/2/4/5. Zod-enforced. If the LLM produces a
   *  different count, validation fails and we fall to the failure path. */
  keepInMind: z
    .array(
      z.object({
        text: z.string().min(1).max(240),
        provenance: z.enum(BRIEFING_PROVENANCE),
      }),
    )
    .length(3),

  /** 2-3 short paragraphs of prose in first-person agent voice. Inline
   *  source references use [1], [2] notation matching the sources[]
   *  array order. ~400-700 chars total. */
  proseBody: z.string().min(50).max(1400),

  /** Optional broker-driven personal-relevance angle. Null when broker
   *  context is absent or unrelated to the topic — do NOT fabricate. */
  personalRelevance: z.string().min(1).max(400).nullable(),

  /** Optional change callout. Null on first run for this agent OR when
   *  the new batch is genuinely indistinguishable from prior briefings. */
  whatsNew: z.string().min(1).max(300).nullable(),

  /** Optional batch caveat — NOT for surfacing system failures. */
  qualityNote: z.string().min(1).max(300).nullable(),

  /** Sources the agent consulted this run, in the order they're
   *  referenced inline in proseBody ([1], [2], etc.). May be empty
   *  when the batch produced no kept items. */
  sources: z.array(BriefingSourceV3Schema).min(0).max(30),

  /** Failure marker — present ONLY on failure briefings. Carries forward
   *  from v2 fix. fetchPriorBriefingV3 filters these out as prior context. */
  failureClass: z.enum(BRIEFING_FAILURE_CLASSES).optional(),
});

export type ResearchDigestBriefingV3 = z.infer<typeof ResearchDigestBriefingV3Schema>;
export type BriefingSourceV3 = z.infer<typeof BriefingSourceV3Schema>;

/**
 * Extract the first balanced JSON object from a free-form string.
 * LLMs sometimes wrap output in markdown fences or add a sentence; this
 * pulls out the `{...}` body even if there's chatter around it.
 */
function extractFirstJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString: '"' | null = null;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === inString) inString = null;
    } else if (c === '"') {
      inString = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Classify a caught error into one of the 4 failure-copy buckets.
 * Inspects InferenceError.errorClass when available; falls back to
 * 'generic' for anything else.
 */
function classifyFailure(e: unknown): FailureClass {
  const errorClass =
    e && typeof e === "object" && "errorClass" in e
      ? (e as { errorClass?: string }).errorClass
      : undefined;
  if (errorClass === "provider_429") return "rate_limited";
  if (errorClass === "chain_exhausted") return "chain_exhausted";
  if (e instanceof z.ZodError) return "malformed";
  if (e instanceof SyntaxError) return "malformed";
  // Heuristic: a thrown string about JSON parsing is malformed too.
  if (e instanceof Error && /json|parse|sourceKey/i.test(e.message)) return "malformed";
  return "generic";
}

/** Build a docs/20 §6 failure briefing. Used when the LLM call (and its
 *  retry) ultimately fails, or when the parsed output validates to
 *  nothing usable. Sources `<details>` should default to OPEN in the
 *  inbox for failure briefings — the failure caller emits the briefing
 *  with `kind:'research'`; the inbox checks the headline to detect
 *  failure state and decides open/closed. */
function failureBriefing(
  cause: unknown,
  prior: ResearchDigestBriefingV2 | null,
): ResearchDigestBriefingV2 {
  const failureClass = classifyFailure(cause);
  const copy = FAILURE_COPY[failureClass];
  const out: ResearchDigestBriefingV2 = {
    version: 2,
    kind: "research",
    headline: copy.headline,
    synthesis: copy.synthesis,
    memorableTakeaways: [],
    readFirst: [],
    skipOrCollapse: [],
    distinctIdeas: [],
    nextSearchSuggestions: [],
    failureClass, // marks this as a failure for fetchPriorBriefingV2 to skip
  };
  // Failure briefings still carry a delta envelope if we have a prior — the
  // inbox can render "I couldn't update; last time you saw…" if desired.
  if (prior) {
    out.delta = {
      whatsNew: "Briefing did not complete for this run; the most recent successful synthesis is unchanged.",
    };
  }
  return out;
}

/** Build the empty-batch briefing (items_kept === 0, search succeeded).
 *  Docs/20 §6 locked copy. */
function emptyBatchBriefing(
  prior: ResearchDigestBriefingV2 | null,
): ResearchDigestBriefingV2 {
  const out: ResearchDigestBriefingV2 = {
    version: 2,
    kind: "research",
    headline: "Nothing worth keeping in today's check.",
    synthesis:
      "I checked this topic, but this run did not find anything worth keeping. Try narrowing the topic or changing the search angle.",
    memorableTakeaways: [],
    readFirst: [],
    skipOrCollapse: [],
    distinctIdeas: [],
    nextSearchSuggestions: [],
  };
  if (prior) {
    out.delta = { whatsNew: "Nothing relevant this run." };
  }
  return out;
}

/** v3 failure briefing — docs/25 §6 copy. failureClass set so the
 *  next run's fetchPriorBriefingV3 filters this out. */
function failureBriefingV3(
  cause: unknown,
  prior: ResearchDigestBriefingV3 | null,
): ResearchDigestBriefingV3 {
  const failureClass = classifyFailure(cause);
  const copy = FAILURE_COPY[failureClass];
  return {
    version: 3,
    kind: "research",
    // Use exactly 3 keepInMind to satisfy the schema's .length(3) rule
    // even on failure. The third is a forward-looking heads-up.
    keepInMind: [
      { text: copy.headline, provenance: "new" },
      { text: copy.synthesis, provenance: "new" },
      {
        text: prior
          ? "Your prior successful briefing is still the most recent useful synthesis."
          : "I'll try again on the next run.",
        provenance: "new",
      },
    ],
    proseBody:
      prior
        ? `${copy.headline} ${copy.synthesis} Your prior successful briefing remains the most recent useful synthesis — it hasn't been replaced by this attempt.`
        : `${copy.headline} ${copy.synthesis}`,
    personalRelevance: null,
    whatsNew: null,
    qualityNote: null,
    sources: [], // failure briefings carry no sources — none were synthesised
    failureClass,
  };
}

/** v3 empty-batch briefing — items_kept === 0 case. Honest "nothing
 *  worth keeping" framing per docs/25 §6 / docs/20 §6. NOT a failure
 *  (search succeeded, just nothing matched), so no failureClass. */
function emptyBatchBriefingV3(
  prior: ResearchDigestBriefingV3 | null,
): ResearchDigestBriefingV3 {
  return {
    version: 3,
    kind: "research",
    keepInMind: [
      { text: "Nothing in this batch was worth keeping.", provenance: "new" },
      {
        text: "Try narrowing the topic or changing the search angle for the next run.",
        provenance: "new",
      },
      {
        text: prior
          ? "Your prior briefing remains the most recent useful synthesis."
          : "Once the agent finds relevant items, a real briefing will appear here.",
        provenance: "new",
      },
    ],
    proseBody:
      "I checked this topic, but this run didn't find anything worth keeping. " +
      (prior
        ? "The prior briefing remains the most recent useful synthesis. "
        : "") +
      "Try narrowing the topic or changing the search angle for the next run.",
    personalRelevance: null,
    whatsNew: prior ? "Nothing relevant this run." : null,
    qualityNote: null,
    sources: [],
    // failureClass intentionally omitted — empty-batch is NOT a failure
  };
}

/** Normalize a URL into a host string for v3 sources[].domain. Lowercased,
 *  no `www.` prefix, trailing slash on path stripped (host only — path
 *  not included). Falls back to the raw string on parse failure. */
function normalizeDomain(url: string | null): string {
  if (!url) return "(unknown)";
  try {
    let host = new URL(url).host.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return url.slice(0, 80);
  }
}

/** Build the sources[] array v3 uses, in score-desc order matching the
 *  prompt's item order so the LLM's [n] references resolve correctly. */
function buildV3Sources(cappedItems: BriefingKeptItem[]): BriefingSourceV3[] {
  return cappedItems
    .filter((it): it is BriefingKeptItem & { url: string } => typeof it.url === "string")
    .map((it) => ({
      dedupeKey: it.dedupeKey,
      title: it.title,
      url: it.url,
      domain: normalizeDomain(it.url),
    }));
}

/** Strip any v3 source-key reference that isn't in the valid set. If
 *  after stripping the briefing has no usable content (no sources AND
 *  no useful prose), the caller treats it as malformed and falls to
 *  the failure path. Returns the cleaned briefing; never mutates. */
function stripInvalidSourceKeysV3(
  b: ResearchDigestBriefingV3,
  validKeys: ReadonlySet<string>,
): ResearchDigestBriefingV3 {
  return {
    ...b,
    sources: b.sources.filter((s) => validKeys.has(s.dedupeKey)),
  };
}

/** Strip any sourceKey reference in `b` that isn't in `validKeys`.
 *  If a takeaway loses ALL its support, drop the takeaway. If a readFirst
 *  pick references an invalid key, drop the pick. Same for skipOrCollapse
 *  and distinctIdeas. Returns the cleaned briefing; never mutates the
 *  input. */
function stripInvalidSourceKeys(
  b: ResearchDigestBriefingV2,
  validKeys: ReadonlySet<string>,
): ResearchDigestBriefingV2 {
  const filterKeys = (keys: string[]) => keys.filter((k) => validKeys.has(k));
  return {
    ...b,
    memorableTakeaways: b.memorableTakeaways
      .map((t) => ({ ...t, supportSourceKeys: filterKeys(t.supportSourceKeys) }))
      .filter((t) => t.supportSourceKeys.length > 0),
    readFirst: b.readFirst.filter((p) => validKeys.has(p.sourceKey)),
    skipOrCollapse: b.skipOrCollapse
      .map((g) => ({ ...g, sourceKeys: filterKeys(g.sourceKeys) }))
      .filter((g) => g.sourceKeys.length > 0),
    distinctIdeas: b.distinctIdeas
      .map((i) => ({ ...i, sourceKeys: filterKeys(i.sourceKeys) }))
      .filter((i) => i.sourceKeys.length > 0),
  };
}

/** Compact a prior v2 briefing into the minimal form the new prompt
 *  needs as cross-run context. ≤ ~1000 tokens budget. */
function compactPriorForPrompt(b: ResearchDigestBriefingV2): string {
  const takeawayLines = b.memorableTakeaways
    .map((t) => `  - [${t.provenance}] ${t.text}`)
    .join("\n");
  const readFirstLines = b.readFirst
    .map((p) => `  - [${p.provenance}] ${p.sourceKey} — ${p.reason}`)
    .join("\n");
  return [
    `Last run's briefing:`,
    `  headline: ${b.headline}`,
    `  synthesis: ${b.synthesis}`,
    takeawayLines ? `  memorableTakeaways:\n${takeawayLines}` : "",
    readFirstLines ? `  readFirst:\n${readFirstLines}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build the v2 briefing prompt — five-question framing per docs/20 §4.
 *  Exported so scripts/compare-briefing-models.ts can run the SAME prompt
 *  through multiple providers for evaluation without re-creating it. */
export function briefingPromptV2(
  cappedItems: BriefingKeptItem[],
  totalKept: number,
  topics: string[],
  prior: ResearchDigestBriefingV2 | null,
): string {
  // Each item: title + url + score + snippet. The snippet IS the
  // briefing's scratch material — Tavily already gave us one when the
  // search ran, persisted in agent_findings.payload.snippet. No
  // additional LLM call needed (the summarise pass v1 used is gone).
  const itemBlock = cappedItems
    .map((it, i) =>
      [
        `[${i + 1}] id=${it.dedupeKey}`,
        `    title: ${it.title}`,
        `    url: ${it.url ?? "(no url)"}`,
        `    score: ${it.score.toFixed(2)}`,
        `    snippet: ${it.summary ?? "(no snippet)"}`,
      ].join("\n"),
    )
    .join("\n\n");

  const capNote =
    cappedItems.length < totalKept
      ? `\n[Note: capped at ${BRIEFING_INPUT_CAP} of ${totalKept} sources by relevance score.]`
      : "";

  const priorBlock = prior
    ? `\n\n${compactPriorForPrompt(prior)}\n\nFrame this run as a delta against the prior briefing. Provenance tags are scoped to THIS agent's watched context — they do NOT claim "new to the world":\n  - 'new'        = NOT present in the prior briefing context above (new to this agent's record, not necessarily to the world).\n  - 'continuing' = present in the prior briefing context above AND still appears in this batch.\n  - 'recurring'  = previously seen theme that's resurfacing after being absent in the immediately prior run.`
    : `\n\nThis is the FIRST briefing for this agent — there is no prior briefing context. All items are provenance='new' (meaning new to this agent's record; we make no claim about novelty to the world). Omit the 'delta' field.`;

  return [
    `You are producing a memory-oriented briefing for a user who watches these topics recurrently. Your job is to reduce repeated cognition across runs, NOT to summarise every source.`,
    ``,
    `Topics: ${topics.join(", ")}.`,
    `Kept sources this run: ${cappedItems.length}.${capNote}`,
    priorBlock,
    ``,
    `Answer these five questions in the JSON output:`,
    `  1. What 1-5 things should the user REMEMBER from this batch?`,
    `  2. Which sources are REDUNDANT — say the same thing as which others?`,
    `  3. Which 0-3 sources are WORTH OPENING (readFirst)?`,
    `  4. What can be SKIPPED or collapsed?`,
    `  5. What QUESTION should the next run investigate?`,
    ``,
    `Output a JSON object EXACTLY matching this schema (no markdown, no prose):`,
    `{`,
    `  "version": 2,`,
    `  "kind": "research",`,
    `  "headline": "one-line opinionated framing of THIS run, <= 140 chars",`,
    `  "synthesis": "1-2 sentences, <= 300 chars — what to remember in a week",`,
    `  "delta": { "whatsNew": "<paragraph>", "whatsContinuing": "(optional)", "whatsChanged": "(optional)" },`,
    `  "qualityNote": "(optional batch caveat — NOT for surfacing system failures)",`,
    `  "memorableTakeaways": [ { "text": "...", "supportSourceKeys": ["<id>"], "provenance": "new" | "continuing" | "recurring" } ],`,
    `  "readFirst": [ { "sourceKey": "<id>", "reason": "...", "provenance": "new" | "continuing" | "recurring" } ],`,
    `  "skipOrCollapse": [ { "reason": "...", "sourceKeys": ["<id>", ...] } ],`,
    `  "distinctIdeas": [ { "label": "...", "summary": "...", "sourceKeys": ["<id>", ...] } ],`,
    `  "nextSearchSuggestions": ["..."]`,
    `}`,
    ``,
    `Structural rules:`,
    `- All sourceKey / supportSourceKey references MUST be exact dedupeKey strings from the items below (the value after "id=" — e.g. "https://example.com/path"). NEVER use numeric indices like 1, 2, 3. NEVER invent ids.`,
    `- Prefer "skip the rest" over "they're all useful." Honest redundancy framing is the point.`,
    `- readFirst is 0-3 items. Empty is valid — if nothing is worth opening, say so honestly by leaving it empty.`,
    `- distinctIdeas is the lower-confidence taxonomic fallback. Use when memorableTakeaways is empty/sparse.`,
    `- nextSearchSuggestions is optional but high-leverage. Suggest 0-3 follow-ups the agent could investigate next run.`,
    ``,
    `SPECIFICITY CONTRACT — the most important rule. This is what makes the briefing useful vs. textbook-bland:`,
    ``,
    `Each memorableTakeaway MUST contain a CONCRETE claim from a specific source. Quote or near-quote the source. Reference specifics: numbers, dates, names, organizations, methodology details, comparative claims ("X argues Y, while Z disagrees"), or notable concrete assertions.`,
    ``,
    `FORBIDDEN takeaway patterns (these are textbook platitudes — they teach the user nothing):`,
    `  * "[Topic] is essential / important / crucial / a best practice"`,
    `  * "[Topic] helps [restated-topic]"`,
    `  * "[Topic] can be applied to [generalization]"`,
    `  * "[Topic] involves [topic restated in different words]"`,
    `  * "[Topic] can lead to [vague benefit]"`,
    `  * Restating the search topic with synonyms`,
    `  * Generic "best practices" without a source attaching the claim`,
    ``,
    `QUALITY OVER QUANTITY. The schema allows up to 5 takeaways, but FEWER SPECIFIC TAKEAWAYS BEAT MORE GENERIC ONES. Two genuinely-grounded claims is far better than five platitudes. If the snippets don't contain specifics, return 0-2 takeaways and use qualityNote to honestly acknowledge the batch's thinness (e.g. "This batch was mostly introductory material — most sources defined the topic rather than advancing it.").`,
    ``,
    `Examples — copy this register, not the bad one:`,
    `  GOOD: "Microsoft's Foundry docs argue red teaming is NOT a replacement for systematic measurement — both are needed in parallel."`,
    `  GOOD: "World Economic Forum (June 2025) frames red teaming as exploring a wide range of issues rather than testing for specific harms."`,
    `  GOOD: "Varonis distinguishes red teaming (offensive simulation) from penetration testing (vulnerability discovery)."`,
    `  BAD:  "Red teaming is essential for LLM safety."`,
    `  BAD:  "Red teaming helps identify harms."`,
    `  BAD:  "Red teaming can be applied to various AI systems."`,
    `  BAD:  "Red teaming involves emulating an adversary's attack."  (definitional restatement)`,
    ``,
    `Epistemic discipline (you only see this batch, not the wider world):`,
    `- Phrase observations about what's missing as "From this batch, I did not find X." NEVER "There is no X."`,
    `- NEVER make broad absence claims about the world. BAD: "There were no urgent developments." GOOD: "This batch was mostly explainer content; nothing read as breaking research."`,
    `- NEVER claim a finding is THE definitive / THE best / authoritative. BAD: "This is the definitive best source." GOOD: "From this batch, the strongest source appears to be [X]."`,
    `- Be opinionated about WHAT IS HERE — rank, recommend. Hedge only about the world beyond this batch.`,
    `- Do NOT fabricate specifics that aren't in the snippets. If you only have generic snippet content, return fewer takeaways and say so in qualityNote.`,
    ``,
    `Items:`,
    itemBlock,
    ``,
    `Return ONLY the JSON object. No prose before or after.`,
  ].join("\n");
}

/** Compact a prior v3 briefing into the minimal form the new prompt
 *  needs as cross-run context. v3 is already prose, so the compact
 *  form is much simpler than v2's. */
function compactPriorForPromptV3(b: ResearchDigestBriefingV3): string {
  const keepLines = b.keepInMind
    .map((k, i) => `  ${i + 1}. [${k.provenance}] ${k.text}`)
    .join("\n");
  return [
    `Last run's briefing:`,
    `  prose: ${b.proseBody}`,
    `  three-things you said the user should keep in mind:`,
    keepLines,
    b.whatsNew ? `  whatsNew (last run): ${b.whatsNew}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build the v3 briefing prompt — prose-shaped, voice-guided per docs/25 §6.
 *  Exported for scripts/compare-briefing-models.ts to use the SAME prompt
 *  through multiple providers without re-creating it. */
export function briefingPromptV3(
  cappedItems: BriefingKeptItem[],
  totalKept: number,
  topics: string[],
  prior: ResearchDigestBriefingV3 | null,
  brokerFragment: string | null,
): string {
  // Items block: title + url + score + Tavily snippet. The snippet IS
  // the scratch material. Source ids are the dedupeKeys; the LLM uses
  // them via the `sources` field, while the inline [n] references in
  // proseBody refer to the index in the sources[] array it builds.
  const itemBlock = cappedItems
    .map((it, i) =>
      [
        `[id=${it.dedupeKey}]`,
        `    title: ${it.title}`,
        `    url: ${it.url ?? "(no url)"}`,
        `    score: ${it.score.toFixed(2)}`,
        `    snippet: ${it.summary ?? "(no snippet)"}`,
      ].join("\n"),
    )
    .join("\n\n");

  const capNote =
    cappedItems.length < totalKept
      ? `\n[Note: capped at ${BRIEFING_INPUT_CAP} of ${totalKept} sources by relevance score.]`
      : "";

  const priorBlock = prior
    ? `\n\n${compactPriorForPromptV3(prior)}\n\nFrame this run as a delta against the prior briefing. Provenance for keepInMind items:\n  - 'new'        = NOT present in the prior briefing context above\n  - 'continuing' = present in prior AND still appears in this batch\n  - 'recurring'  = previously seen theme resurfacing after being absent\nProvenance is scoped to THIS agent's watched context — NOT "new to the world".`
    : `\n\nThis is the FIRST briefing for this agent — there is no prior briefing context. All keepInMind items are provenance='new' (meaning new to THIS agent's record; we make no claim about novelty to the world). Set whatsNew to null.`;

  const brokerBlock =
    brokerFragment && brokerFragment.trim().length > 0
      ? `\n\n=== User context (from broker; treat as private) ===\n${brokerFragment}\n=== End user context ===\n\nUse this to populate personalRelevance — angle the briefing at THIS user specifically. If the user context is absent or unrelated to the topic, set personalRelevance to null. Do NOT fabricate relevance to seem helpful.`
      : `\n\nNo user context available. Set personalRelevance to null.`;

  return [
    `You are a watching agent reporting back to a user who asked you to keep an eye on a topic. Your job is to reduce repeated cognition — NOT to summarise every source. Write like a knowledgeable peer who has done the reading and respects the user's time.`,
    ``,
    `Topics: ${topics.join(", ")}.`,
    `Sources kept this run: ${cappedItems.length}.${capNote}`,
    priorBlock,
    brokerBlock,
    ``,
    `=== VOICE — apply this throughout proseBody and personalRelevance ===`,
    ``,
    `Register: peer-to-peer, not assistant-to-user. The user is a smart colleague who's been busy.`,
    `  NOT friendly-bot ("Hi! Here's what I found!")`,
    `  NOT academic ("This batch demonstrates that...")`,
    `  NOT corporate ("Per the available evidence...")`,
    `  NOT concierge ("I have prepared the following summary...")`,
    ``,
    `Opening: the FIRST sentence of proseBody MUST contain a specific observation. No greetings, no meta-statements, no "I checked," no "Here are the key findings."`,
    `  GOOD: "Mostly explainer pieces this week, except one — Palo Alto's methodology piece [1]."`,
    `  GOOD: "Two new methodology papers landed. Anthropic's [2] reframes the assumption that red-teaming should replace systematic measurement."`,
    `  GOOD: "Nothing new this week. Sources continue to repeat the same definition; no methodology advances."`,
    `  BAD:  "Hello! I checked the LLM-safety beat this week."`,
    `  BAD:  "Here are the key findings from this batch."`,
    `  BAD:  "This batch contained 5 sources on the topic."`,
    ``,
    `Hedging: hedge only when honesty requires it. State a view when you have one.`,
    `  GOOD: "Microsoft and the WEF disagree on whether red-teaming is sufficient. I'd lean Microsoft's way on the evidence here."`,
    `  BAD:  "There appear to be some interesting findings that could potentially be relevant."`,
    `  BAD:  "Some sources suggest one view while others suggest another."`,
    ``,
    `Confidence boundaries: opinionated about what's IN the batch ("skip the rest" OK), humble about the world beyond ("the definitive best source" NOT OK — you've only seen this batch).`,
    ``,
    `Length: 2-3 short paragraphs. ~400-700 chars total. Cuts beat depth. One idea per paragraph.`,
    `  Para 1: what this batch contained (the most interesting observation first)`,
    `  Para 2: the tension, surprise, or recommendation`,
    `  Para 3 (optional): what to do with it / what's coming`,
    ``,
    `Source references: inline [1], [2] notation matching the sources[] array order. Identify sources by ORG NAME in prose ("Microsoft Foundry", "Palo Alto Networks", "CSET") — NEVER include URLs in the prose body.`,
    ``,
    `=== END VOICE ===`,
    ``,
    `Output a JSON object EXACTLY matching this schema (no markdown, no commentary, no fences):`,
    `{`,
    `  "version": 3,`,
    `  "kind": "research",`,
    `  "keepInMind": [`,
    `    { "text": "imperative statement, <= 240 chars", "provenance": "new" | "continuing" | "recurring" },`,
    `    { "text": "imperative statement, <= 240 chars", "provenance": "new" | "continuing" | "recurring" },`,
    `    { "text": "imperative statement, <= 240 chars", "provenance": "new" | "continuing" | "recurring" }`,
    `  ],`,
    `  "proseBody": "2-3 short paragraphs of prose in the voice above. ~400-700 chars total. Inline [n] source references.",`,
    `  "personalRelevance": "one short paragraph angling at the user given broker context, OR null",`,
    `  "whatsNew": "one sentence on what shifted vs the prior briefing, OR null (null on first run or when nothing genuinely changed)",`,
    `  "qualityNote": "optional batch caveat about THIS batch (e.g. 'mostly introductory material'), OR null",`,
    `  "sources": [`,
    `    { "dedupeKey": "<id from items below>", "title": "...", "url": "...", "domain": "normalized host" }`,
    `  ]`,
    `}`,
    ``,
    `Hard rules:`,
    `- keepInMind MUST have EXACTLY 3 items. Not 0, 1, 2, 4, or 5. Three.`,
    `  If the batch is too thin for three real imperatives, make item 3 a forward-looking "watch for X" rather than padding.`,
    `- sources MUST be a subset of the items below. Use exact dedupeKey strings. Order matches the [n] references in proseBody.`,
    `- proseBody inline [n] references MUST match sources[] indices (1-based). [1] is sources[0], [2] is sources[1], etc.`,
    `- Identify sources by org name in prose, never by URL.`,
    `- personalRelevance: null if no useful broker context; do NOT fabricate.`,
    `- whatsNew: null on first run or when there's no genuine change since the prior briefing.`,
    `- qualityNote: null if no caveat applies. Never use this to surface system failures — that's a separate concern.`,
    ``,
    `Specificity contract (the most important content rule):`,
    ``,
    `Each keepInMind item AND every sentence in proseBody MUST be a CONCRETE claim. Reference specifics: numbers, dates, names, organizations, methodology details, comparative claims, notable assertions.`,
    ``,
    `FORBIDDEN patterns (these teach the user nothing):`,
    `  * "[Topic] is essential / important / crucial / a best practice"`,
    `  * "[Topic] helps [restated-topic]"`,
    `  * "[Topic] can be applied to [generalization]"`,
    `  * "[Topic] involves [topic restated in different words]"`,
    `  * "[Topic] can lead to [vague benefit]"`,
    `  * Restating the search topic with synonyms`,
    `  * Generic "best practices" without a source attaching the claim`,
    ``,
    `Quality over quantity: if the snippets don't contain specifics, say so in qualityNote and write fewer (but still specific) prose sentences. Do NOT pad with platitudes to fill space.`,
    ``,
    `GOOD takeaway/prose examples:`,
    `  "Microsoft's Foundry docs argue red teaming is NOT a replacement for systematic measurement — both are needed in parallel."`,
    `  "World Economic Forum (June 2025) frames red teaming as exploring a wide range of issues rather than testing for specific harms."`,
    `  "Varonis distinguishes red teaming (offensive simulation) from penetration testing (vulnerability discovery)."`,
    `BAD examples (do NOT write these):`,
    `  "Red teaming is essential for LLM safety."`,
    `  "Red teaming helps identify harms."`,
    `  "Red teaming can be applied to various AI systems."`,
    ``,
    `Epistemic discipline:`,
    `- Phrase observations about what's missing as "From this batch, I did not find X." NEVER "There is no X."`,
    `- NEVER make broad absence claims about the world. BAD: "There were no urgent developments." GOOD: "This batch was mostly explainer content; nothing read as breaking research."`,
    `- NEVER claim a finding is THE definitive / THE best / authoritative. BAD: "This is the definitive best source." GOOD: "From this batch, the strongest source appears to be [X]."`,
    `- Be opinionated about WHAT IS HERE. Hedge only about the world beyond this batch.`,
    `- Do NOT fabricate specifics not in the snippets.`,
    ``,
    `=== Items the agent kept this run ===`,
    itemBlock,
    ``,
    `Return ONLY the JSON object. No prose before or after.`,
  ].join("\n");
}

/**
 * Fetch the most recent prior v2 briefing for this agent. Used by the
 * briefing() function for cross-run continuity per docs/20 §5.
 *
 * Owner scope is load-bearing — the admin client bypasses RLS, so the
 * `user_id` filter is the security boundary. Excludes the current run
 * (started_at < now() AND id != currentRunId) so the briefing we just
 * inserted in STEP 6 doesn't show up as "prior."
 *
 * Fail-open: on any DB error, returns null and the caller treats it as
 * first-run. The briefing prompt then omits the delta block. The user
 * sees a first-run-shaped briefing instead of an error. Cross-run
 * continuity is a nice-to-have, not a correctness invariant.
 */
async function fetchPriorBriefingV2(
  agentId: string,
  userId: string,
  currentRunId: string,
): Promise<ResearchDigestBriefingV2 | null> {
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("agent_runs")
      .select("briefing")
      .eq("agent_id", agentId)
      .eq("user_id", userId)
      .neq("id", currentRunId)
      .not("briefing", "is", null)
      .order("started_at", { ascending: false })
      .limit(10);
    if (error || !data) return null;
    // Iterate newest-first; return the first row whose briefing parses
    // as v2 AND is NOT a failure briefing. v1 rows are silently skipped
    // (they don't satisfy the version literal). Failure briefings carry
    // the `failureClass` field and are explicitly excluded — feeding
    // "I couldn't complete this check..." into the next run's prompt
    // as "prior context" would corrupt the LLM's understanding of what
    // it actually knew last time (Sneha review feedback, 2026-05-18).
    //
    // Empty-batch briefings ("Nothing worth keeping...") are NOT skipped
    // — they're real synthesis of zero results, and "still nothing" is
    // useful prior context for the next run to acknowledge.
    for (const row of data as Array<{ briefing: unknown }>) {
      const parsed = ResearchDigestBriefingV2Schema.safeParse(row.briefing);
      if (!parsed.success) continue;
      if (parsed.data.failureClass !== undefined) continue;
      return parsed.data;
    }
    return null;
  } catch (e) {
    console.error(
      `[research-digest] fetchPriorBriefingV2 threw for agent ${agentId}:`,
      scrubErrorMessage(e),
    );
    return null;
  }
}

/**
 * Fetch the most recent prior v3 briefing for this agent. Used by the
 * briefing() function for cross-run continuity (docs/25 §6.9).
 *
 * Only returns v3 briefings — v2 history is ignored because the shapes
 * are different and v3 can't sensibly compact a v2 briefing into its
 * prior-context block. If the agent has only v2 history, the new run
 * is treated as a first run for continuity purposes (no delta, all
 * provenance='new'). That's correct semantically: this IS the first
 * v3 run.
 *
 * Failure briefings (those with failureClass set) are skipped per
 * Sneha review 2026-05-18 — feeding "I couldn't complete this check"
 * forward as prior context would pollute the LLM's "what you said
 * last time" memory.
 *
 * Owner-scope is load-bearing — admin client bypasses RLS so the
 * user_id filter IS the security boundary.
 */
async function fetchPriorBriefingV3(
  agentId: string,
  userId: string,
  currentRunId: string,
): Promise<ResearchDigestBriefingV3 | null> {
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("agent_runs")
      .select("briefing")
      .eq("agent_id", agentId)
      .eq("user_id", userId)
      .neq("id", currentRunId)
      .not("briefing", "is", null)
      .order("started_at", { ascending: false })
      .limit(10);
    if (error || !data) return null;
    for (const row of data as Array<{ briefing: unknown }>) {
      const parsed = ResearchDigestBriefingV3Schema.safeParse(row.briefing);
      if (!parsed.success) continue;
      if (parsed.data.failureClass !== undefined) continue;
      return parsed.data;
    }
    return null;
  } catch (e) {
    console.error(
      `[research-digest] fetchPriorBriefingV3 threw for agent ${agentId}:`,
      scrubErrorMessage(e),
    );
    return null;
  }
}

export const researchDigest: AgentTemplate<ResearchDigestConfig, ResearchItem> = {
  id: "research_digest",
  displayName: "Research Digest",
  description: "Pulls relevant articles on your topics. Daily digest.",
  defaultBadge: "flash",
  defaultCadenceHours: 24,
  defaultBudget: {
    maxRunsPerDay: 1,
    maxItemsConsideredPerRun: 30,
    maxLLMHopsPerItem: 1,
    maxNotificationsPerDay: 1,
  },
  configSchema: ResearchDigestConfigSchema,
  /** Broker categories the agent needs in its system prompt. The broker
   *  decides what actually goes in based on the user's trait sheet. */
  brokerCategories: ["interests", "preferences"],

  async *fetch({ config }: TemplateCallContext<ResearchDigestConfig>) {
    // Track provider outcomes per topic so we can distinguish
    // "search worked, no relevant results" from "every search instance
    // failed". The first is a benign zero-yield day; the second is an
    // operational outage that must surface as a failed run — the
    // runner's outer catch records status='failed' with a scrubbed
    // message, and the lifecycle counter trips at 5 consecutive
    // failures → state='degraded'.
    //
    // 2026-05-18 deploy-verification finding: before this guard, a
    // fully-dead SearXNG instance list looked identical to a legit
    // empty-result day. Run finished status='ok' with items_fetched=0
    // and no error trail.
    const providerErrors: Array<{ topic: string; error: string }> = [];
    let anyTopicReturned = false;

    for (const topic of config.topics) {
      // runSearch dispatches by SEARCH_PROVIDER env (docs/18):
      // tavily → tavilySearch, anything else → searxngSearch (dev fallback).
      // Return shape is identical to the old direct searxngSearch call so
      // the per-topic failure tracking below is unchanged.
      const { results, instance, lastError } = await runSearch(topic);

      if (results.length === 0 && lastError !== null) {
        // Provider returned nothing AND signalled an error for this
        // topic. Record + continue — a later topic might still succeed
        // and we'll yield those items.
        providerErrors.push({ topic, error: lastError });
        continue;
      }

      // Either we got results (success) OR every instance returned an
      // empty array without throwing (search ok, no hits). Both are
      // "topic served" — count it as such.
      anyTopicReturned = true;

      for (const hit of results) {
        yield {
          url: hit.url,
          title: hit.title,
          snippet: hit.snippet,
          engine: hit.engine,
          instance,
          matchedTopic: topic,
        };
      }
    }

    // If EVERY topic failed at the provider layer AND we yielded
    // nothing, throw so the runner records status='failed' with a
    // scrubbed error. Partial-success days (some topics yielded,
    // others errored) finish cleanly — keep what we got. The
    // per-topic errors there are diagnostic-only for now; the future
    // run-history UI can surface them in a per-run detail panel.
    if (!anyTopicReturned && providerErrors.length > 0) {
      const summary = providerErrors
        .map((e) => `${e.topic}: ${e.error}`)
        .join("; ");
      // Provider-agnostic error wording — runSearch may have dispatched
      // to Tavily or SearXNG depending on SEARCH_PROVIDER env. The
      // per-topic error string already names the provider via its
      // prefix (e.g. "Tavily HTTP 401" / "HTTP 429").
      throw new Error(
        `Search provider failed for all ${providerErrors.length} topic(s): ${summary}`,
      );
    }
  },

  dedupeKey(item: ResearchItem): string {
    return canonicaliseUrl(item.url);
  },

  async score(
    item: ResearchItem,
    { config, broker, run }: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<number> {
    const result = await generate(
      {
        messages: [
          { role: "system", content: broker.fragment },
          { role: "user", content: scorePrompt(item, config.topics) },
        ],
        maxTokens: 8,
        temperature: 0,
      },
      { badge: run.badge },
    );
    return parseScoreReply(result.text);
  },

  /**
   * v2 no-op pass-through (was: per-item LLM summarise call).
   *
   * The v2 briefing-first architecture (docs/19+20) forbids user-visible
   * per-source LLM paragraphs. Per-source summarise calls are gone — the
   * briefing carries all synthesis, using the Tavily snippet as scratch
   * material. summarise() stays in the template contract so the runner
   * doesn't need to change.
   *
   * `summary` holds the Tavily snippet (the search provider's raw
   * extract). This is NOT an LLM-generated paragraph — it's just what
   * the search API returned. The v2 inbox render hides summary entirely,
   * so the user never sees this text directly. We persist it because:
   *   (a) the briefing prompt needs it as scratch material (the runner
   *       maps draft.summary → BriefingKeptItem.summary at STEP 7);
   *   (b) it's useful for future features (search-within-findings, etc.);
   *   (c) if a v2 run crashes before briefing, the legacy render path
   *       at least shows the snippet as "summary" rather than empty.
   *
   * Deviation from docs/20 §3 (which said `summary: NULL`): the spec
   * said NULL based on the principle of "no per-source paragraphs."
   * Storing the search provider's raw snippet preserves that principle
   * (snippet ≠ LLM paragraph) while keeping the briefing pipeline
   * pure-functional from BriefingKeptItem — no extra DB query at
   * briefing time. Spec amended inline.
   *
   * `_llmHops: 0`, `_costMicroUsd: 0` — no LLM is called.
   */
  async summarise(
    item: ResearchItem,
    _ctx: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<FindingDraft> {
    return {
      title: item.title,
      summary: item.snippet,
      payload: {
        url: item.url,
        engine: item.engine ?? null,
        instance: item.instance ?? null,
        matched_topic: item.matchedTopic,
        snippet: item.snippet,
        fetched_at: new Date().toISOString(),
      },
      urgency: "normal",
      _llmHops: 0,
      _costMicroUsd: 0,
    };
  },

  /**
   * v2 briefing function per docs/19 + docs/20.
   *
   * Flow:
   *   1. Fetch the most recent prior v2 briefing for this agent (best-
   *      effort; null on miss or DB error).
   *   2. If items_kept === 0: emit empty-batch briefing, no LLM call.
   *   3. Cap kept items at BRIEFING_INPUT_CAP (20) by score desc.
   *   4. Build the prompt (5-question framing) including prior context.
   *   5. Call generate() with one retry on failure.
   *   6. extractFirstJson → JSON.parse → Zod validate → strip invalid
   *      sourceKeys.
   *   7. Record LLM cost (fail-open).
   *   8. On any failure path: emit a failure briefing with human copy.
   *      The failure is VISIBLE, not silently masked with scaffolding.
   *
   * Failure semantics: this function NEVER throws. The runner persists
   * whatever we return as agent_runs.briefing; the run completes
   * status='ok' even when briefing generation fails (the failure
   * briefing IS the agent's report of what happened).
   */
  async briefing(
    keptItems: BriefingKeptItem[],
    { config, broker, run }: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<BriefingResult | null> {
    const startedAt = Date.now();

    // (1) Prior-briefing fetch. Best-effort, null on miss. v3-only —
    // v2 history is ignored for continuity purposes since the shapes
    // are incompatible (see fetchPriorBriefingV3 docblock).
    const prior = await fetchPriorBriefingV3(
      run.agentId,
      run.userId,
      run.id,
    );

    // (2) Empty-batch short-circuit. NO LLM call. v3 empty shape.
    if (keptItems.length === 0) {
      return {
        briefing: emptyBatchBriefingV3(prior) as unknown as Record<string, unknown>,
        _llmHops: 0,
        _costMicroUsd: 0,
      };
    }

    // (3) Cap by score desc per docs/19 §10.2.
    const cappedItems = [...keptItems]
      .sort((a, b) => b.score - a.score)
      .slice(0, BRIEFING_INPUT_CAP);

    // (4) Build prompt. v3 includes broker.fragment for personal
    // relevance synthesis. broker.fragment may be empty/null when
    // the user has no useful trait context — the prompt handles that
    // by instructing the LLM to return personalRelevance: null.
    const brokerFragment =
      broker && typeof broker.fragment === "string" ? broker.fragment : null;
    const prompt = briefingPromptV3(
      cappedItems,
      keptItems.length,
      config.topics,
      prior,
      brokerFragment,
    );

    // (5) Call LLM with one retry. Track cost across both attempts.
    let parsed: ResearchDigestBriefingV3 | null = null;
    let providerForCost: string | null = null;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let modelUsed: string | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await generate(
          {
            messages: [{ role: "user", content: prompt }],
            maxTokens: 1500, // larger than v2 (1200) because prose + 3-things + sources can grow
            temperature: 0.5,
          },
          { badge: run.badge },
        );
        providerForCost = result.provider;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        modelUsed = result.model;

        const jsonStr = extractFirstJson(result.text);
        if (!jsonStr) throw new Error("No JSON object in LLM response");
        const raw = JSON.parse(jsonStr) as unknown;
        // Zod enforces exactly-3 keepInMind via .length(3) — malformed
        // counts fail here and fall to failure briefing path.
        const validated = ResearchDigestBriefingV3Schema.parse(raw);

        // (6) Strip invalid source-key references. Unlike v2, v3 only
        // has source references in the sources[] array and inline [n]
        // markers in proseBody. We strip sources[] to valid keys; if
        // the LLM hallucinated all sources AND there are no valid ones
        // left, treat as malformed.
        const validKeys = new Set(cappedItems.map((i) => i.dedupeKey));
        const stripped = stripInvalidSourceKeysV3(validated, validKeys);
        if (stripped.sources.length === 0 && cappedItems.length > 0) {
          // LLM produced no valid source references for a non-empty
          // batch. The proseBody's [n] anchors won't resolve. Treat
          // as malformed.
          throw new Error("No valid sources after stripping");
        }
        parsed = stripped;
        break;
      } catch (e) {
        lastError = e;
        console.error(
          `[research-digest] briefing attempt ${attempt + 1} failed:`,
          scrubErrorMessage(e),
        );
      }
    }

    // (7) Record cost if we got a provider response. Fail-open.
    let microCost = 0;
    let llmHops = 0;
    if (providerForCost) {
      microCost = Number(
        pricingCostMicroUsd(
          providerForCost as ProviderId,
          inputTokens,
          outputTokens,
        ),
      );
      llmHops = 1;
      try {
        await recordCost({
          userId: run.userId,
          agentRunId: run.id,
          badge: run.badge,
          providerChain: [providerForCost],
          providerUsed: providerForCost,
          modelUsed,
          fallbackDepth: 0,
          inputTokens: inputTokens ?? null,
          outputTokens: outputTokens ?? null,
          costMicroUsd: microCost,
          latencyMs: Date.now() - startedAt,
          status: parsed ? "ok" : "error",
        });
      } catch (e) {
        console.error(
          `[research-digest] briefing recordCost threw for run ${run.id}:`,
          scrubErrorMessage(e),
        );
      }
    }

    // (8) If we have a parsed v3 briefing, also auto-populate sources[]
    // from cappedItems if the LLM returned an empty array (defensive —
    // shouldn't happen since stripInvalidSourceKeysV3 above would have
    // tripped, but belt-and-braces).
    if (parsed && parsed.sources.length === 0 && cappedItems.length > 0) {
      parsed = { ...parsed, sources: buildV3Sources(cappedItems) };
    }

    const briefing = parsed ?? failureBriefingV3(lastError, prior);
    return {
      briefing: briefing as unknown as Record<string, unknown>,
      _llmHops: llmHops,
      _costMicroUsd: microCost,
    };
  },
};
