# 18 — Search provider decision (ResearchDigest beta)

**Status:** decision pending
**Owner:** Sneha
**Opened:** 2026-05-18
**Blocks:** live findings in `/workspace/inbox`; ResearchDigest output quality pass; further product surface beyond what's already shipped

---

## 1. Current verified state

Phase 3.0 deploy verification is complete via the provider-failure path (gate B from the original 15-step checklist). The runtime + product loop is proven end-to-end on real Supabase:

```
agent (created via UI)
  → claim_due_agents (PR #17 fix for RETURNING-into-uuid[] bug)
  → runner.execute
  → ResearchDigest.fetch (PR #19 diagnostic for all-providers-fail case)
  → finalize (PR #18 fix for budget self-count bug)
  → update_agent_lifecycle_state
  → row available to listAgents / listFindings
```

Verified outcome with the current public-SearXNG defaults (2026-05-18):

```json
{
  "status": "failed",
  "items_fetched": 0,
  "items_kept": 0,
  "cost_usd": 0,
  "error": "Error: SearXNG providers failed for all 1 topic(s): AI Safety: HTTP 429"
}
```

`consecutive_failures` increments correctly; the agent will auto-degrade to `state='degraded'` after 5 consecutive failures per the existing lifecycle rules. Nothing more to fix at the runtime level.

## 2. Why public/self-hosted SearXNG is not sufficient

Public instance probe (2026-05-18, repeated multiple times across the verification window):

| Instance | Status |
|---|---|
| `https://searx.be` | HTTP 503 |
| `https://search.inetol.net` | HTTP 429 |
| `https://priv.au` | HTTP 502 → HTTP 429 on retry |
| `https://search.brave4u.com` | DNS NXDOMAIN (gone) |
| `https://searx.tiekoetter.com` | HTTP 429 |
| `https://baresearch.org` | HTTP 429 |
| `https://opnxng.com` | HTTP 429 |
| `https://search.disroot.org` | HTTP 200 but Anubis bot-challenge HTML body |

**Self-hosting SearXNG does NOT solve this.** The 429s come from Google/Bing/DDG responding to SearXNG's IP, which would become your own IP once self-hosted. Same rate-limit, different operator. Self-hosted SearXNG only buys you control, not reliability — and reliability is what NC beta needs.

Acceptable role for SearXNG going forward: **dev fallback only**, behind the chosen reliable provider.

## 3. Provider candidates

Pricing as of 2026-05-18:

### Brave Search API
- **Cost:** $5 per 1,000 search requests; $5/month credit baked in for new accounts → ~1,000 included searches/month
- **Index:** Brave's own independent index (not a Google/Bing relay)
- **Format:** JSON with title / url / description / snippet
- **Compliance:** clear ToS, no scraping concerns since it's their first-party index
- **Free tier:** capped at ~1k/month effectively (no separate free tier beyond the credit)

### Tavily
- **Cost:** 1,000 API credits / month free, then $0.008 / credit
- **Index:** aggregates multiple sources, agent/research-oriented (includes summarization helpers, citations metadata)
- **Format:** JSON with structured `results[]` + optional `answer` field for direct LLM use
- **Compliance:** explicit "built for AI agents" positioning; no scraping ambiguity
- **Quality:** marketed as higher-relevance for LLM consumption; less raw SERP, more curated

### Serper
- **Cost:** 2,500 free queries; $0.30 per 1,000 after that
- **Index:** Google SERP scrape (not first-party)
- **Format:** JSON mirroring Google's SERP structure (organic results, knowledge graph, etc.)
- **Compliance:** Google ToS questions — Serper's model is scraping Google; long-term legal posture is murkier than Brave or Tavily
- **Quality:** Google-equivalent relevance (which is what most users actually expect)

## 4. Decision criteria

| Criterion | Why it matters for NC |
|---|---|
| Reliability | Single biggest reason we're here. Daily cron, beta users seeing zero findings is the current failure mode. |
| Cost per beta user | At ~1 ResearchDigest run/agent/day × N agents × ~5 topics each, beta-scale = single-digit dollars/month. All three fit. |
| Result quality | ResearchDigest summarises top hits via LLM. Garbage-in → garbage-out. Quality matters for actually being useful. |
| Terms / compliance | Privacy-first product. Scraping-based APIs have residual ToS risk; first-party indexes don't. |
| API simplicity | Single endpoint, JSON shape compatible with the existing `searxngSearch` return type (`{results, instance, lastError}`) means a smaller integration PR. |
| Privacy / data retention | What does the provider do with our queries? Tavily and Brave have clear retention policies; Serper less so. |

## 5. Recommendation placeholder

**To be filled in by Sneha.** Pre-decision leans (from chat 2026-05-18):

> "Probably start with **Tavily** if output quality matters more than raw cost, or **Serper** if you want the cheapest reliable beta path."

Both are reasonable. Brave is a fallback option but more expensive per 1k than Serper and less LLM-friendly than Tavily.

## 6. Required env / API key

Whichever provider is chosen, the integration will follow the established env pattern from PR #19's `SEARXNG_INSTANCES`:

```bash
# In .env.local + Lovable preview env + (eventually) Cloudflare Worker env
SEARCH_PROVIDER=tavily|serper|brave|searxng   # default: tavily once chosen
TAVILY_API_KEY=...                            # or SERPER_API_KEY=... or BRAVE_API_KEY=...
SEARXNG_INSTANCES=https://...                 # kept as dev fallback per PR #19
```

The API key MUST stay server-only (same posture as `SUPABASE_SERVICE_ROLE_KEY` — never expose via `VITE_*`).

## 7. Next code PR after decision

**Not now. After provider choice.** Sketched scope only:

```
feat(search): add SearchProvider abstraction + <chosen> impl

- src/lib/search.functions.ts:
  - export new SearchProvider interface (search(q): Promise<{results, instance, lastError}>)
  - existing SearXNG impl becomes one SearchProvider
  - new <chosen> impl added (single file, ~50 lines)
  - dispatcher reads SEARCH_PROVIDER env, falls back to searxng
- src/server/agents/templates/research-digest.ts:
  - NO behavioural change — still consumes {results, instance, lastError}
  - the abstraction is below the template
- tests/leak-suite/phase30-research-digest.test.ts:
  - extend existing mock to cover dispatcher branch
  - keep PR #19's failure-mode tests
- NO runner / batch / cron / budget / migration / UI touches
```

Acceptance criteria for that PR:

```
- SEARCH_PROVIDER env routes to the chosen impl
- API key validation at startup (fail fast if missing in non-dev mode)
- chosen-provider failures surface via the same lastError path as SearXNG
- ResearchDigest tests still pass without changes
- end-to-end: real findings appear in /workspace/inbox after one batch run
  (closing out deploy verification gate A from the original checklist)
```

## 8. Out of scope for this decision

- Run-history / degraded-state UI (queue item #4 — waits until live findings exist)
- Provider abstraction beyond two providers (don't build for n=3+ until n=2 actually ships)
- Self-hosted SearXNG production deployment (dev fallback only)
- Search-quality tuning / relevance scoring (separate from provider choice)
