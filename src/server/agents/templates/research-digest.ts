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
 * **No recordCost call in PR3b.** Per-hop `inference_usage` ledger
 * writes need the `runId` in TemplateCallContext, which today is only
 * `{config, broker}`. Extending the context shape is a runner.ts change,
 * which PR3b explicitly avoids. Cost still flows into `agent_runs.cost_usd`
 * via `_costMicroUsd` accumulation in the runner — just not the per-hop
 * inference_usage breakdown. That breakdown ships in PR3c (or a small
 * follow-up between PR3b and PR3c) once the context-extension question
 * is settled.
 *
 * **Privacy:** the broker `fragment` is forwarded opaquely to the LLM
 * as a system prompt. ResearchDigest never inspects it, never extracts
 * sub-values, and never echoes user content into agent_runs.error or
 * structured logs (errors that bubble out hit the runner's scrubber).
 */
import { z } from "zod";
import { searxngSearch } from "@/lib/search.functions";
import { generate } from "@/server/inference";
import { costMicroUsd as pricingCostMicroUsd } from "@/server/inference/pricing";
import type { ProviderId } from "@/lib/provider-tiers";
import type {
  AgentTemplate,
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
    for (const topic of config.topics) {
      const { results, instance } = await searxngSearch(topic);
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
  },

  dedupeKey(item: ResearchItem): string {
    return canonicaliseUrl(item.url);
  },

  async score(
    item: ResearchItem,
    { config, broker }: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<number> {
    const result = await generate({
      messages: [
        { role: "system", content: broker.fragment },
        { role: "user", content: scorePrompt(item, config.topics) },
      ],
      maxTokens: 8,
      temperature: 0,
    });
    return parseScoreReply(result.text);
  },

  async summarise(
    item: ResearchItem,
    { config, broker }: TemplateCallContext<ResearchDigestConfig>,
  ): Promise<FindingDraft> {
    const result = await generate({
      messages: [
        { role: "system", content: broker.fragment },
        { role: "user", content: summarisePrompt(item, config.topics) },
      ],
      maxTokens: 120,
      temperature: 0.4,
    });

    const microCost = Number(
      pricingCostMicroUsd(
        result.provider as ProviderId,
        result.inputTokens,
        result.outputTokens,
      ),
    );

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
};
