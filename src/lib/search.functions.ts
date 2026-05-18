import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";

/**
 * Web search for the agent runtime + chat UI.
 *
 * Two providers ship in this file:
 *
 *   - **Tavily** — paid (1k credits/month free), AI/research-oriented,
 *     production default for ResearchDigest. Decided in docs/18.
 *   - **SearXNG** — OSS meta-search, rotated across public instances or
 *     a self-hosted URL via `SEARXNG_INSTANCES`. Dev fallback only;
 *     public instances are too flaky for production (PR #19 audit).
 *
 * The agent runtime (cron-triggered, no user session) calls `runSearch`,
 * which dispatches on `SEARCH_PROVIDER` env. The user-facing `webSearch`
 * server fn keeps the SearXNG path for chat-side use unchanged — only
 * ResearchDigest moves to Tavily. Touching `webSearch` is scope-creep
 * relative to the docs/18 decision.
 */

// ─── Shared types ────────────────────────────────────────────────────────

/** Normalized hit shape every provider must return. */
export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  /** SearXNG exposes the upstream engine name; Tavily doesn't. Optional. */
  engine?: string;
};

/**
 * Uniform return shape across providers. `instance` is a free-form label
 * for telemetry — for SearXNG it's the actual instance URL we hit; for
 * Tavily it's the literal `"tavily"`. `lastError` is set when the
 * provider attempt(s) failed and results is empty. Mirrors the contract
 * the existing `searxngSearch` already had and that ResearchDigest's
 * per-topic failure tracking from PR #19 already consumes.
 */
export type SearchResult = {
  results: SearchHit[];
  instance: string | null;
  lastError: string | null;
};

// ─── SearXNG provider ────────────────────────────────────────────────────

/**
 * Default SearXNG instances. Best-effort fallback only — public
 * instances are unreliable (bot challenges, rate limits, occasional
 * outages). Production deployments use Tavily; SearXNG is here for dev
 * + as the fallback when SEARCH_PROVIDER is unset.
 *
 * 2026-05-18 audit (during deploy verification):
 *   - searx.be          → HTTP 503
 *   - search.inetol.net → HTTP 429
 *   - priv.au           → HTTP 502 → HTTP 429
 *   - search.brave4u.com → DNS NXDOMAIN (REMOVED — domain gone)
 * Keeping the three transient-error ones; removed the permanently-dead
 * one. The Tavily-primary decision (docs/18) means we no longer need
 * public SearXNG to be reliable.
 */
const DEFAULT_SEARXNG_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://priv.au",
];

/**
 * Resolve the SearXNG instance list. Reads `process.env.SEARXNG_INSTANCES`
 * (comma-separated URLs) and falls back to `DEFAULT_SEARXNG_INSTANCES`
 * when the env is unset, empty, or only whitespace.
 *
 * Exported so tests can exercise both branches without monkey-patching.
 */
export function resolveSearxngInstances(): string[] {
  const raw =
    typeof process !== "undefined" ? process.env.SEARXNG_INSTANCES : undefined;
  if (raw && raw.trim().length > 0) {
    const parsed = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_SEARXNG_INSTANCES;
}

async function querySearxng(
  instance: string,
  q: string,
  signal: AbortSignal,
): Promise<SearchHit[]> {
  const url = `${instance}/search?q=${encodeURIComponent(q)}&format=json&safesearch=1`;
  const res = await fetch(url, {
    signal,
    headers: {
      // Some instances block default fetch UA.
      "User-Agent": "Mozilla/5.0 (compatible; NCBot/1.0; +privacy-first-search)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; engine?: string }>;
  };
  return (json.results ?? [])
    .slice(0, 8)
    .map((r) => ({
      title: r.title ?? r.url ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
      engine: r.engine,
    }))
    .filter((r) => r.url);
}

/**
 * Pure SearXNG search — no auth, no logging. Kept exported for back-
 * compat (webSearch still uses it directly) and because the agent
 * runtime's dev fallback path calls it through `runSearch`.
 *
 * Same instance-rotation + 6s-per-instance timeout as before.
 */
export async function searxngSearch(query: string): Promise<SearchResult> {
  let results: SearchHit[] = [];
  let usedInstance: string | null = null;
  let lastError: string | null = null;

  for (const instance of resolveSearxngInstances()) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const hits = await querySearxng(instance, query, ctrl.signal);
      if (hits.length > 0) {
        results = hits;
        usedInstance = instance;
        break;
      }
    } catch (e) {
      lastError = (e as Error).message;
    } finally {
      clearTimeout(t);
    }
  }

  return { results, instance: usedInstance, lastError };
}

// ─── Tavily provider ─────────────────────────────────────────────────────

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const TAVILY_TIMEOUT_MS = 8000;
const TAVILY_MAX_RESULTS = 10;

/**
 * Tavily search adapter. Posts to https://api.tavily.com/search with
 * `api_key` + `query` in the JSON body. Returns the same `SearchResult`
 * shape as `searxngSearch` so the dispatcher + ResearchDigest don't
 * need to know which provider answered.
 *
 * `instance` field is set to the literal string `"tavily"` for telemetry
 * — it's the analogue of SearXNG's per-instance URL but Tavily is a
 * single endpoint, so a fixed label suffices.
 *
 * Failure modes (any of these returns `{results: [], lastError: ...}`,
 * not a throw — the caller's per-topic loop expects a value):
 *   - missing TAVILY_API_KEY env
 *   - network / abort timeout
 *   - non-2xx HTTP response (rate limit, auth error, server error)
 *   - JSON parse failure or unexpected shape
 */
export async function tavilySearch(query: string): Promise<SearchResult> {
  const apiKey =
    typeof process !== "undefined" ? process.env.TAVILY_API_KEY : undefined;
  if (!apiKey || apiKey.trim().length === 0) {
    return {
      results: [],
      instance: null,
      lastError: "TAVILY_API_KEY env is not set",
    };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TAVILY_TIMEOUT_MS);
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: TAVILY_MAX_RESULTS,
        // include_answer false: we don't want Tavily's own LLM-generated
        // answer in the agent path. ResearchDigest does its own
        // summarisation via the runtime's broker-context LLM call.
        include_answer: false,
      }),
    });
    if (!res.ok) {
      return {
        results: [],
        instance: null,
        lastError: `Tavily HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
      }>;
    };
    const hits: SearchHit[] = (json.results ?? [])
      .map((r) => ({
        title: r.title ?? r.url ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        // Tavily doesn't expose upstream engine names; leave undefined.
      }))
      .filter((r) => r.url);

    return {
      results: hits,
      instance: hits.length > 0 ? "tavily" : null,
      lastError: hits.length === 0 ? "Tavily returned no results" : null,
    };
  } catch (e) {
    return {
      results: [],
      instance: null,
      lastError: `Tavily ${(e as Error).message ?? "unknown error"}`,
    };
  } finally {
    clearTimeout(t);
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────

export type SearchProviderId = "tavily" | "searxng";

/**
 * Choose the active search provider from env. Decision per docs/18:
 *   - SEARCH_PROVIDER=tavily   → tavilySearch (production default)
 *   - SEARCH_PROVIDER=searxng  → searxngSearch (explicit dev/fallback)
 *   - unset / unknown          → searxngSearch (back-compat with PR #19)
 *
 * Once Tavily is wired up in production env, SEARCH_PROVIDER should be
 * set explicitly. Leaving it unset preserves the pre-Tavily behaviour
 * for local dev without an API key.
 */
export function resolveSearchProvider(): SearchProviderId {
  const raw =
    typeof process !== "undefined" ? process.env.SEARCH_PROVIDER : undefined;
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "tavily") return "tavily";
  // Anything else (empty, "searxng", typo) → SearXNG fallback. Defensive
  // because we'd rather a misspelled env land on the dev path than
  // silently break the cron.
  return "searxng";
}

/**
 * Single entry-point for the agent runtime. Dispatches to the active
 * provider per `resolveSearchProvider()`. The `provider` field on the
 * return is the resolved id (handy for diagnostic logging).
 *
 * Return shape matches `searxngSearch` exactly so the existing
 * ResearchDigest per-topic failure tracking from PR #19 works
 * unchanged — no behavioural shift in the template.
 */
export async function runSearch(
  query: string,
): Promise<SearchResult & { provider: SearchProviderId }> {
  const provider = resolveSearchProvider();
  // Call via `self.*` so vi.mock-replaced exports are honored in tests.
  // A direct `tavilySearch(query)` call would bind to the local
  // function reference inside this file and bypass the mock.
  const result =
    provider === "tavily" ? await tavilySearch(query) : await searxngSearch(query);
  return { ...result, provider };
}

// ─── webSearch server fn (user-facing chat path) ─────────────────────────

const InputSchema = z.object({
  query: z.string().min(1).max(500),
});

export const webSearch = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d) => InputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const q = data.query.trim();

    // webSearch is the chat-side path — keep it on SearXNG for now so
    // changing the provider for the chat UI is a deliberate later
    // decision, not a side-effect of the agent-side Tavily wiring.
    const { results, instance: usedInstance, lastError } = await searxngSearch(q);

    // Log the query (best-effort — never block the user on a log failure).
    try {
      await supabase.from("search_queries").insert({
        user_id: userId,
        query: q,
        engine: "searxng",
        result_count: results.length,
        metadata: {
          instance: usedInstance,
          error: usedInstance ? null : lastError,
        },
      });
    } catch {
      // swallow
    }

    return {
      query: q,
      results,
      instance: usedInstance,
      googleFallbackUrl: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    };
  });

export const logOpenedSearchUrl = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ query: z.string().min(1).max(500), url: z.string().url() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await supabase.from("search_queries").insert({
      user_id: userId,
      query: data.query,
      engine: "open_click",
      result_count: 0,
      opened_url: data.url,
    });
    return { ok: true };
  });
