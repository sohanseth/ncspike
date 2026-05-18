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

function summarisePrompt(item: ResearchItem, topics: string[]): string {
  return [
    `Summarise this article in exactly two sentences for someone interested in: ${topics.join(", ")}.`,
    `Don't mention that you're summarising. Just write the summary.`,
    ``,
    `Title: ${item.title}`,
    `Snippet: ${item.snippet}`,
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

// ─── Briefing layer (added 2026-05-18 per docs/18 follow-up) ──────────────
//
// The runner calls `template.briefing()` after the summarise loop. We
// synthesize a small JSON object the inbox renders ABOVE the finding
// cards so the experience stops looking like a search-results page and
// starts feeling agentic.
//
// LLM-primary with deterministic fallback. The LLM gets only the bounded
// per-item summary the template already produced; no raw provider output
// is in the prompt. If the LLM call fails OR the response fails Zod
// validation, fall through to a minimal deterministic briefing (top-3-
// by-score + URL-heuristic source-type labels) so the inbox always has
// SOMETHING to show.
//
// Per Sneha's product rule: phrase observations about what's MISSING
// from this batch as "From this batch, I did not find X" — never
// "There is no X" (the agent only sees this batch).

const BRIEFING_PRIORITIES = [
  "read_first",
  "useful",
  "background",
  "low_priority",
] as const;
const BRIEFING_SOURCE_TYPES = [
  "expert",
  "company",
  "directory",
  "opinion",
  "encyclopedia",
  "other",
] as const;

export const ResearchDigestBriefingSchema = z.object({
  /** Shape version. Bump when the schema changes; older runs stay readable. */
  version: z.literal(1),
  /** One-line opinionated framing. ≤ 140 chars. */
  headline: z.string().min(1).max(280),
  /** One paragraph synthesizing the batch. ≤ ~600 chars. */
  synthesis: z.string().min(1).max(1200),
  /** Top 2–3 picks the user should read first, with a reason each. */
  topPicks: z
    .array(
      z.object({
        findingId: z.string().min(1),
        title: z.string().min(1).max(400),
        reason: z.string().min(1).max(400),
      }),
    )
    .min(0)
    .max(5),
  /** Per-finding labels keyed by the same id used in `topPicks`. */
  findingLabels: z.record(
    z.string(),
    z.object({
      priority: z.enum(BRIEFING_PRIORITIES),
      sourceType: z.enum(BRIEFING_SOURCE_TYPES),
      reason: z.string().min(1).max(400).optional(),
    }),
  ),
  /** Optional caveat — "this batch is broad/introductory" etc. */
  qualityNote: z.string().min(1).max(600).optional(),
});

export type ResearchDigestBriefing = z.infer<typeof ResearchDigestBriefingSchema>;

/**
 * URL-heuristic source type. Cheap, deterministic, fallback-only.
 * The LLM is expected to do better; this is what we ship when the LLM
 * is unavailable or returns garbage.
 */
function classifySourceTypeFromUrl(
  url: string | null,
): (typeof BRIEFING_SOURCE_TYPES)[number] {
  if (!url) return "other";
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith("wikipedia.org")) return "encyclopedia";
    if (host.endsWith(".gov") || host.endsWith(".edu")) return "expert";
    if (host === "reddit.com" || host.endsWith(".reddit.com")) return "opinion";
    if (host.endsWith("medium.com") || host.endsWith("substack.com")) return "opinion";
    // Naive directory detection — search-y aggregator hosts.
    if (host.includes("awesome-") || host.includes("/list/")) return "directory";
    // Anything else with a clear corporate TLD-ish footprint. We
    // intentionally err on "other" rather than mis-tagging things as
    // "company"; the LLM will do better when it's available.
    return "other";
  } catch {
    return "other";
  }
}

function deterministicBriefing(
  keptItems: BriefingKeptItem[],
  topics: string[],
): ResearchDigestBriefing {
  const sorted = [...keptItems].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, Math.min(3, sorted.length));
  const findingLabels: ResearchDigestBriefing["findingLabels"] = {};
  for (const it of keptItems) {
    findingLabels[it.dedupeKey] = {
      priority: top.includes(it) ? "read_first" : "useful",
      sourceType: classifySourceTypeFromUrl(it.url),
    };
  }
  const topicsLabel = topics.length === 1 ? topics[0] : `${topics.length} topic(s)`;
  return {
    version: 1,
    headline: `${keptItems.length} item(s) found for ${topicsLabel}.`,
    synthesis:
      keptItems.length > 0
        ? `From this batch I kept ${keptItems.length} item(s) after scoring. ` +
          `Top picks are ranked by relevance score; this is the deterministic ` +
          `fallback summary (full briefing was unavailable).`
        : `From this batch I did not find any items above the relevance threshold.`,
    topPicks: top.map((t) => ({
      findingId: t.dedupeKey,
      title: t.title,
      reason: `Highest relevance score in this batch (${t.score.toFixed(2)}).`,
    })),
    findingLabels,
    qualityNote:
      "This is a fallback briefing (LLM synthesis was unavailable). Priorities are derived from score only.",
  };
}

function briefingPrompt(
  keptItems: BriefingKeptItem[],
  topics: string[],
): string {
  // Bounded input: only the kept items' title/url/summary/score. No raw
  // provider output, no broker fragments. Topic names are config-trust
  // (same level as display_name).
  const itemBlock = keptItems
    .map((it, i) =>
      [
        `[${i + 1}] id=${it.dedupeKey}`,
        `    title: ${it.title}`,
        `    url: ${it.url ?? "(no url)"}`,
        `    score: ${it.score.toFixed(2)}`,
        `    summary: ${it.summary ?? "(no summary)"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `You are summarising a daily research digest for a user.`,
    `Topics: ${topics.join(", ")}.`,
    `You have ${keptItems.length} kept items below.`,
    ``,
    `Output a JSON object EXACTLY matching this schema (no markdown, no prose):`,
    `{`,
    `  "version": 1,`,
    `  "headline": "one-line opinionated framing, <= 140 chars",`,
    `  "synthesis": "one paragraph, <= 600 chars, opinionated",`,
    `  "topPicks": [ { "findingId": "<id from below>", "title": "...", "reason": "why read this" } ],`,
    `  "findingLabels": { "<id>": { "priority": "read_first" | "useful" | "background" | "low_priority", "sourceType": "expert" | "company" | "directory" | "opinion" | "encyclopedia" | "other", "reason": "(optional)" } },`,
    `  "qualityNote": "(optional caveat about this batch)"`,
    `}`,
    ``,
    `Rules:`,
    `- topPicks should include 2-3 items max (the most useful ones), in priority order.`,
    `- Cover EVERY id below in findingLabels.`,
    ``,
    `Epistemic discipline (IMPORTANT — you only see this batch, not the wider world):`,
    `- Phrase observations about what's missing as "From this batch, I did not find X." NEVER "There is no X."`,
    `- NEVER make broad absence claims about the world. BAD: "There were no urgent developments." GOOD: "This batch mostly contains introductory or institutional material." or "From this batch, nothing read as breaking news."`,
    `- NEVER claim a finding is THE definitive / THE best / authoritative. BAD: "This is the definitive best source." GOOD: "From this batch, the strongest source appears to be [X]." or "Of what arrived, [X] looks like the most substantive."`,
    `- Be opinionated about WHAT IS HERE — rank, prioritise, recommend. Don't hedge about the items in front of you. Hedge only about (a) the world beyond this batch and (b) absolute claims of superiority.`,
    `- Mark company-owned PR pages as sourceType="company".`,
    `- Mark Wikipedia as "encyclopedia". Reddit/Medium/Substack as "opinion".`,
    ``,
    `Items:`,
    itemBlock,
    ``,
    `Return ONLY the JSON object. No prose before or after.`,
  ].join("\n");
}

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

  async summarise(
    item: ResearchItem,
    { config, broker, run }: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<FindingDraft> {
    const startedAt = Date.now();
    const result = await generate(
      {
        messages: [
          { role: "system", content: broker.fragment },
          { role: "user", content: summarisePrompt(item, config.topics) },
        ],
        maxTokens: 120,
        temperature: 0.4,
      },
      { badge: run.badge },
    );
    const latencyMs = Date.now() - startedAt;

    const microCost = Number(
      pricingCostMicroUsd(
        result.provider as ProviderId,
        result.inputTokens,
        result.outputTokens,
      ),
    );

    // Per-hop cost ledger entry (PR3b.1). Tagged via metadata.agent_run_id
    // so CPAUD breakdowns can attribute spend to specific agent runs.
    //
    // **Fail-open** (Sneha: "recordCost() failure should be logged/scrubbed
    // and not break the digest generation"). recordCost itself doesn't
    // throw on insert failure (cap fail-open inherited from chat's
    // writeUsage), but if anything else goes wrong — a network blip
    // before the insert even starts, a synchronous throw in the supabase
    // chain construction — we catch + scrub + continue. The cost would
    // be lost from the ledger (acceptable under-counting per the existing
    // CAP-CRITICAL convention) but the finding still lands.
    try {
      await recordCost({
        userId: run.userId,
        agentRunId: run.id,
        badge: run.badge,
        providerChain: [result.provider],
        providerUsed: result.provider,
        modelUsed: result.model,
        fallbackDepth: 0,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        costMicroUsd: microCost,
        latencyMs,
        status: "ok",
      });
    } catch (e) {
      console.error(
        `[research-digest] recordCost threw for run ${run.id}:`,
        scrubErrorMessage(e),
      );
    }

    return {
      title: item.title,
      summary: result.text,
      payload: {
        url: item.url,
        engine: item.engine ?? null,
        instance: item.instance ?? null,
        matched_topic: item.matchedTopic,
        provider: result.provider,
        model: result.model,
        fetched_at: new Date().toISOString(),
      },
      urgency: "normal",
      _llmHops: 1,
      _costMicroUsd: microCost,
    };
  },

  async briefing(
    keptItems: BriefingKeptItem[],
    { config, run }: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<BriefingResult | null> {
    // LLM-primary. On any failure mode (request error, malformed JSON,
    // Zod validation failure), fall through to the deterministic
    // briefing. The fallback is BETTER than nothing and ships enough
    // shape that the inbox UI never has to special-case absent fields.
    const startedAt = Date.now();

    let parsed: ResearchDigestBriefing | null = null;
    // Match summarise's typing: provider stays a plain string; cast to
    // ProviderId only at the pricingCostMicroUsd call which is the one
    // place it's strongly typed.
    let providerForCost: string | null = null;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let modelUsed: string | null = null;

    try {
      const result = await generate(
        {
          messages: [
            { role: "user", content: briefingPrompt(keptItems, config.topics) },
          ],
          // Briefing JSON is small. 800 tokens is enough headroom for
          // headline + synthesis + 3 topPicks + ~10 findingLabels.
          maxTokens: 800,
          temperature: 0.4,
        },
        { badge: run.badge },
      );
      providerForCost = result.provider;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      modelUsed = result.model;

      const jsonStr = extractFirstJson(result.text);
      if (jsonStr) {
        const raw = JSON.parse(jsonStr) as unknown;
        // Zod validation — bounded, predictable. Any deviation falls
        // through to the deterministic briefing below.
        parsed = ResearchDigestBriefingSchema.parse(raw);
      }
    } catch (e) {
      // Three failure classes lump together here: provider error,
      // malformed JSON, Zod validation failure. All resolve to the
      // deterministic fallback. The recordCost call below still
      // attempts to log the LLM hop if the provider actually responded.
      console.error(
        `[research-digest] briefing generation failed; falling back to deterministic:`,
        scrubErrorMessage(e),
      );
    }

    // Record the cost of the LLM hop if we actually made one. The
    // recordCost call mirrors summarise's shape — same fail-open
    // wrap; ledger outage never crashes briefing generation.
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
          status: "ok",
        });
      } catch (e) {
        console.error(
          `[research-digest] briefing recordCost threw for run ${run.id}:`,
          scrubErrorMessage(e),
        );
      }
    }

    const briefing = parsed ?? deterministicBriefing(keptItems, config.topics);
    return {
      briefing: briefing as unknown as Record<string, unknown>,
      _llmHops: llmHops,
      _costMicroUsd: microCost,
    };
  },
};
