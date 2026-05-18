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

/** Source-input cap per docs/19 §10.2 / docs/20 §11.2 — score-desc top 20. */
const BRIEFING_INPUT_CAP = 20;

/** Failure classification → user-facing copy. Docs/20 §6. No HTTP codes
 *  in user surface; diagnostics go to agent_runs.error only. */
type FailureClass =
  | "rate_limited"      // provider 429s, single provider or whole chain
  | "chain_exhausted"   // all providers in the chain failed
  | "malformed"         // LLM responded, output unparseable / Zod-invalid
  | "generic";          // anything else
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
  const copy = FAILURE_COPY[classifyFailure(cause)];
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

/** Build the v2 briefing prompt — five-question framing per docs/20 §4. */
function briefingPromptV2(
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
    ? `\n\n${compactPriorForPrompt(prior)}\n\nFrame this run as a delta against the prior briefing. Tag items as 'continuing' when they restate the prior, 'recurring' if they appeared 2+ runs back, 'new' otherwise.`
    : `\n\nThis is the FIRST briefing for this agent — there is no prior briefing. All items are provenance='new'. Omit the 'delta' field.`;

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
    `Rules:`,
    `- All sourceKey references MUST be ids from the items below. Don't invent ids.`,
    `- Prefer "skip the rest" over "they're all useful." Honest redundancy framing is the point.`,
    `- readFirst is 0-3 items. Empty is valid — if nothing is worth opening, say so honestly by leaving it empty.`,
    `- memorableTakeaways is the user-memory contract. ≤5 items, each ≤140 chars, each grounded by at least one supportSourceKey.`,
    `- distinctIdeas is the lower-confidence taxonomic fallback. Use when memorableTakeaways is empty/sparse.`,
    `- nextSearchSuggestions is optional but high-leverage. Suggest 0-3 follow-ups the agent could investigate next run.`,
    ``,
    `Epistemic discipline (you only see this batch, not the wider world):`,
    `- Phrase observations about what's missing as "From this batch, I did not find X." NEVER "There is no X."`,
    `- NEVER make broad absence claims about the world. BAD: "There were no urgent developments." GOOD: "This batch was mostly explainer content; nothing read as breaking research."`,
    `- NEVER claim a finding is THE definitive / THE best / authoritative. BAD: "This is the definitive best source." GOOD: "From this batch, the strongest source appears to be [X]."`,
    `- Be opinionated about WHAT IS HERE — rank, recommend. Hedge only about the world beyond this batch.`,
    ``,
    `Items:`,
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
    // as v2. v1 rows are silently skipped (they don't satisfy the
    // version literal). This keeps cross-run continuity working even
    // when there are interleaved v1 / v2 rows in the history.
    for (const row of data as Array<{ briefing: unknown }>) {
      const parsed = ResearchDigestBriefingV2Schema.safeParse(row.briefing);
      if (parsed.success) return parsed.data;
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
    { config, run }: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<BriefingResult | null> {
    const startedAt = Date.now();

    // (1) Prior-briefing fetch. Best-effort, null on miss.
    const prior = await fetchPriorBriefingV2(
      run.agentId,
      run.userId,
      run.id,
    );

    // (2) Empty-batch short-circuit. NO LLM call.
    if (keptItems.length === 0) {
      return {
        briefing: emptyBatchBriefing(prior) as unknown as Record<string, unknown>,
        _llmHops: 0,
        _costMicroUsd: 0,
      };
    }

    // (3) Cap by score desc per docs/19 §10.2.
    const cappedItems = [...keptItems]
      .sort((a, b) => b.score - a.score)
      .slice(0, BRIEFING_INPUT_CAP);

    // (4) Build prompt.
    const prompt = briefingPromptV2(
      cappedItems,
      keptItems.length,
      config.topics,
      prior,
    );

    // (5) Call LLM with one retry. Track cost across both attempts;
    // only the successful attempt's tokens count toward the recorded
    // cost (the failed attempt's tokens are lost, mirroring how the
    // inference chain itself handles fall-through cost telemetry).
    let parsed: ResearchDigestBriefingV2 | null = null;
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
            maxTokens: 1200,
            temperature: 0.4,
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
        const validated = ResearchDigestBriefingV2Schema.parse(raw);

        // (6) Strip invalid sourceKeys. If everything strips, treat as
        // malformed — fall to failure briefing.
        const validKeys = new Set(cappedItems.map((i) => i.dedupeKey));
        const stripped = stripInvalidSourceKeys(validated, validKeys);
        if (
          stripped.memorableTakeaways.length === 0 &&
          stripped.readFirst.length === 0 &&
          stripped.distinctIdeas.length === 0
        ) {
          throw new Error("No valid sourceKeys after stripping");
        }
        parsed = stripped;
        break;
      } catch (e) {
        lastError = e;
        console.error(
          `[research-digest] briefing attempt ${attempt + 1} failed:`,
          scrubErrorMessage(e),
        );
        // Loop continues for the second attempt; the second iteration
        // overwrites providerForCost/inputTokens/outputTokens/modelUsed
        // if it gets a response. If both attempts fail, those vars hold
        // the second attempt's response (or undefined if neither
        // attempt produced a response).
      }
    }

    // (7) Record cost if we got a provider response (success OR last
    // failed attempt). Fail-open per summarise's pattern in v1.
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

    // (8) Either we have a parsed v2 briefing or we go to failure.
    const briefing = parsed ?? failureBriefing(lastError, prior);
    return {
      briefing: briefing as unknown as Record<string, unknown>,
      _llmHops: llmHops,
      _costMicroUsd: microCost,
    };
  },
};
