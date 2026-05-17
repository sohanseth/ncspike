import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";

/**
 * Privacy-first web search via SearXNG public instances.
 *
 * SearXNG is OSS, self-hostable, strips trackers, and aggregates results
 * from Google/Bing/DDG/etc. server-side. We rotate through a small list
 * of known-good public instances on failure so a single instance going
 * down doesn't break search for the user. See mem://preferences/oss-first.
 */

// Public instances ordered by recent reliability. JSON format must be
// enabled on the instance — most major ones have it on.
const SEARXNG_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://priv.au",
  "https://search.brave4u.com",
];

const InputSchema = z.object({
  query: z.string().min(1).max(500),
});

type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
};

async function querySearxng(instance: string, q: string, signal: AbortSignal): Promise<SearchHit[]> {
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
 * Pure search call — no auth, no logging. Extracted so the agent runtime
 * (cron-triggered, no user session) can call SearXNG directly without
 * going through the user-auth-wrapped `webSearch` server-fn.
 *
 * Returns `{results, instance, lastError}` so callers that want to log
 * the query themselves can (e.g., the agent runtime tags via
 * inference_usage.metadata, the user-facing webSearch logs to
 * search_queries).
 *
 * Same instance-rotation + 6s-per-instance timeout as webSearch.
 */
export async function searxngSearch(
  query: string,
): Promise<{ results: SearchHit[]; instance: string | null; lastError: string | null }> {
  let results: SearchHit[] = [];
  let usedInstance: string | null = null;
  let lastError: string | null = null;

  for (const instance of SEARXNG_INSTANCES) {
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

export const webSearch = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d) => InputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const q = data.query.trim();

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
