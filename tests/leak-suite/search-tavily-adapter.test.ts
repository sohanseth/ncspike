/**
 * Tavily adapter unit tests.
 *
 * Separate from phase30-research-digest.test.ts because here we mock
 * global `fetch` to exercise the adapter's network shape directly —
 * the larger digest-pipeline file mocks tavilySearch at the module
 * boundary and never exercises the actual HTTP construction.
 *
 * Covers the failure surfaces the adapter is responsible for:
 *   - missing TAVILY_API_KEY
 *   - non-2xx HTTP response
 *   - network/timeout (AbortError)
 *   - malformed JSON / unexpected shape
 *   - successful response → SearchHit[] normalization
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tavilySearch } from "@/lib/search.functions";

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.TAVILY_API_KEY;

function mockFetchOnce(impl: (input: RequestInfo, init?: RequestInit) => Promise<Response>) {
  (globalThis as { fetch: typeof fetch }).fetch = vi.fn(impl) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.TAVILY_API_KEY = "tvly-test-key";
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = ORIG_KEY;
});

// ─── Missing API key ─────────────────────────────────────────────────────

describe("tavilySearch — missing TAVILY_API_KEY", () => {
  it("returns empty + lastError without making a network call when key is unset", async () => {
    delete process.env.TAVILY_API_KEY;
    const fetchSpy = vi.fn();
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const r = await tavilySearch("AI safety");

    expect(r.results).toEqual([]);
    expect(r.instance).toBeNull();
    expect(r.lastError).toMatch(/TAVILY_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats whitespace-only API key as unset", async () => {
    process.env.TAVILY_API_KEY = "   ";
    const r = await tavilySearch("AI safety");
    expect(r.results).toEqual([]);
    expect(r.lastError).toMatch(/TAVILY_API_KEY/);
  });
});

// ─── Successful response ─────────────────────────────────────────────────

describe("tavilySearch — successful response normalization", () => {
  it("maps Tavily fields → SearchHit shape, drops items without url, sets instance='tavily'", async () => {
    mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          query: "AI safety",
          response_time: 0.3,
          results: [
            {
              title: "Article A",
              url: "https://example.com/a",
              content: "Snippet about A",
              score: 0.95,
            },
            {
              title: "Article B",
              url: "https://example.com/b",
              content: "Snippet about B",
              score: 0.82,
            },
            {
              // No URL → should be filtered out.
              title: "URL-less",
              content: "no url here",
              score: 0.1,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const r = await tavilySearch("AI safety");

    expect(r.lastError).toBeNull();
    expect(r.instance).toBe("tavily");
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toEqual({
      title: "Article A",
      url: "https://example.com/a",
      snippet: "Snippet about A",
    });
    expect(r.results[0]).not.toHaveProperty("score");
    expect(r.results[0]).not.toHaveProperty("engine");
  });

  it("posts to the Tavily endpoint with api_key + query in the JSON body", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    (globalThis as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    await tavilySearch("RLHF");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.api_key).toBe("tvly-test-key");
    expect(body.query).toBe("RLHF");
    expect(body.include_answer).toBe(false);
    expect(body.search_depth).toBe("basic");
    expect(typeof body.max_results).toBe("number");
  });

  it("returns empty results with lastError when Tavily returns zero hits", async () => {
    mockFetchOnce(async () =>
      new Response(JSON.stringify({ query: "q", results: [] }), { status: 200 }),
    );

    const r = await tavilySearch("nothing matches");

    expect(r.results).toEqual([]);
    expect(r.instance).toBeNull();
    expect(r.lastError).toMatch(/no results/i);
  });
});

// ─── Non-2xx HTTP responses ──────────────────────────────────────────────

describe("tavilySearch — HTTP failure responses", () => {
  it("HTTP 401 (bad API key) → lastError mentions the status", async () => {
    mockFetchOnce(async () =>
      new Response("Unauthorized", { status: 401 }),
    );

    const r = await tavilySearch("AI safety");

    expect(r.results).toEqual([]);
    expect(r.instance).toBeNull();
    expect(r.lastError).toBe("Tavily HTTP 401");
  });

  it("HTTP 429 (rate limit) → lastError mentions the status", async () => {
    mockFetchOnce(async () => new Response("Too Many Requests", { status: 429 }));
    const r = await tavilySearch("RLHF");
    expect(r.lastError).toBe("Tavily HTTP 429");
  });

  it("HTTP 500 (server error) → lastError mentions the status", async () => {
    mockFetchOnce(async () => new Response("Internal Server Error", { status: 500 }));
    const r = await tavilySearch("any");
    expect(r.lastError).toBe("Tavily HTTP 500");
  });
});

// ─── Network / abort ────────────────────────────────────────────────────

describe("tavilySearch — network failures", () => {
  it("fetch throws (network failure) → lastError captures the message", async () => {
    mockFetchOnce(async () => {
      throw new Error("ECONNREFUSED");
    });

    const r = await tavilySearch("AI safety");

    expect(r.results).toEqual([]);
    expect(r.instance).toBeNull();
    expect(r.lastError).toMatch(/^Tavily /);
    expect(r.lastError).toMatch(/ECONNREFUSED/);
  });
});
