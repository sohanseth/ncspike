/**
 * Phase 3.0 agent runtime — type surface.
 *
 * Single source of truth for everything that crosses the queue/budget/runner
 * boundary. Mirrors the SQL enums + tables from
 * `supabase/migrations/20260601000000_phase30_agent_runtime.sql` and the
 * AgentTemplate contract from docs/16 §13.
 *
 * **Invariant (docs/16 §13, §22 invariant #7):** this file MUST NOT import
 * from any concrete template (`templates/research-digest`, etc.). The runner,
 * queue, and budget layers see only the generic `AgentTemplate<TConfig,
 * TItem>` interface. Concrete templates ship in PR3 and self-register via a
 * registry; nothing in this file knows what a "research digest" is.
 *
 * **Spec deviation note:** docs/16 §11 sample code references `source` /
 * `source_id` / `cost_usd` columns on `inference_usage`. The real schema
 * uses `cost_micro_usd` + `metadata jsonb` (added in
 * 20260517000200_phase29b_inference_usage_metadata). PR2 uses the real
 * schema; agent runs are tagged via `metadata.agent_run_id`. Update docs/16
 * §11 in a small follow-up.
 */
import type { Badge } from "@/server/inference/router";

// ─── DB row types — mirror the SQL schema 1:1 ─────────────────────────────

/**
 * Lifecycle states from `agent_state_enum`. State transitions happen in
 * `update_agent_lifecycle_state()` per docs/13 §4:
 *
 *   draft → active                  (user activates)
 *   active → degraded               (≥5 consecutive failures)
 *   active → inactive               (>30 days with no useful run)
 *   degraded → error                (≥20 consecutive failures)
 *   degraded → active               (a successful useful run)
 *   inactive → active               (a successful useful run)
 *   *  → paused / archived          (user action)
 *   *  → needs_user_attention       (template requests attention; 3.5+)
 */
export type AgentLifecycleState =
  | "draft"
  | "active"
  | "paused"
  | "degraded"
  | "inactive"
  | "error"
  | "needs_user_attention"
  | "archived";

/**
 * Per-run outcome from `agent_run_status_enum`. Cost durability invariant
 * (docs/16 §11.1): for every status except `running`, the row's `cost_usd`
 * reflects what was actually spent — `recordCost` runs inline per LLM hop
 * so even a runner crash post-hop leaves the cost in the ledger.
 */
export type AgentRunStatus =
  | "running"
  | "ok"
  | "failed"
  | "partial_success"
  | "skipped_budget_exceeded"
  | "skipped_disabled"
  | "timeout"
  | "cancelled";

/** Per-finding state from `agent_finding_state_enum`. Accept/dismiss/snooze
 * ship with 3.1; 3.0 only writes `new`. */
export type AgentFindingState =
  | "new"
  | "seen"
  | "accepted"
  | "dismissed"
  | "snoozed"
  | "archived";

export type AgentFindingUrgency = "normal" | "urgent";

/**
 * Per-agent budget. JSONB on `agents.budget`. Shape is template-agnostic;
 * docs/13 §6 + docs/16 §13.
 *
 * `maxRunsPerDay` — enforced preflight in `checkBudget` (rolling 24h window).
 * `maxItemsConsideredPerRun` — enforced inside the runner's fetch loop.
 * `maxLLMHopsPerItem` — advisory, template-enforced.
 * `maxNotificationsPerDay` — placeholder for 3.1 notification delivery.
 */
export type AgentBudget = {
  maxRunsPerDay: number;
  maxItemsConsideredPerRun: number;
  maxLLMHopsPerItem: number;
  maxNotificationsPerDay: number;
};

/** Notification preferences. Placeholder for 3.1; 3.0 ignores. */
export type AgentNotifyConfig = Record<string, unknown>;

export type AgentRow = {
  id: string;
  user_id: string;
  template_id: string;
  display_name: string;
  config: Record<string, unknown>;
  badge: Badge;
  state: AgentLifecycleState;
  cadence_hours: number;
  budget: AgentBudget;
  notify: AgentNotifyConfig;
  created_at: string;
  updated_at: string;
  last_claimed_at: string | null;
  last_completed_at: string | null;
  last_useful_at: string | null;
  claim_expires_at: string | null;
  consecutive_failures: number;
};

export type AgentRunRow = {
  id: string;
  agent_id: string;
  user_id: string;
  started_at: string;
  finished_at: string | null;
  status: AgentRunStatus;
  items_fetched: number;
  items_kept: number;
  llm_hops: number;
  /** Postgres numeric(10,6) — already in USD, not micro-USD. */
  cost_usd: number;
  /** PII-scrubbed + truncated to 500 chars. NEVER contains user content. */
  error: string | null;
};

export type AgentFindingRow = {
  id: string;
  agent_id: string;
  user_id: string;
  run_id: string;
  dedupe_key: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  payload: Record<string, unknown>;
  score: number;
  state: AgentFindingState;
  urgency: AgentFindingUrgency;
  user_feedback: string | null;
  created_at: string;
  acted_at: string | null;
};

export type AgentStateRow = {
  agent_id: string;
  user_id: string;
  key: string;
  value: unknown;
  updated_at: string;
};

// ─── Template contract — what concrete templates implement in PR3+ ────────

/**
 * Broker output handed to a template — a system-prompt fragment plus the
 * tier the broker resolved (so templates can short-circuit on tier mismatch
 * before making LLM calls). Templates MUST treat `fragment` as opaque text;
 * they MUST NOT introspect it or extract sub-values.
 */
export type BrokerContext = {
  fragment: string;
  resolvedTier: number;
};

/**
 * Per-call context handed to template methods. The shape is intentionally
 * minimal: template methods get the agent's `config` (already validated by
 * the template's Zod schema), a `BrokerContext`, and a `run` sub-object
 * carrying the bare minimum the template needs for cost attribution.
 *
 * **The `run` sub-object (added in PR3b.1):** templates need it to call
 * `recordCost()` inline per LLM hop so that `inference_usage` rows can be
 * tagged with `metadata.agent_run_id = run.id`. Kept as a nested object
 * so future additions (e.g., a `traitVersion` for promotion paths in 3.5)
 * don't pollute the top level — `ctx.run.*` stays self-documenting.
 *
 * Templates MUST NOT use `run.id` or `run.userId` for any purpose other
 * than telemetry / cost attribution. In particular: templates MUST NOT
 * use `run.userId` to query for that user's data outside what's already
 * in `config` and `broker`. The broker is the authoritative privacy
 * boundary; the run identity is purely an accounting handle.
 */
export type TemplateCallContext<TConfig> = {
  config: TConfig;
  broker: BrokerContext;
  run: {
    /** agent_runs.id — tag for `inference_usage.metadata.agent_run_id`. */
    id: string;
    /** agents.user_id — required field on `inference_usage.user_id`. */
    userId: string;
    /** agents.badge — required field on `inference_usage.badge`. */
    badge: Badge;
  };
};

/**
 * What a template returns from `summarise(item)` — the seed for an
 * `agent_findings` row. The two underscored fields carry cost telemetry the
 * runner needs to drive budget enforcement and CPAUD; they don't end up in
 * the DB.
 *
 * **Unit choice (Sneha audit, 2026-05-17):** all internal cost values are
 * micro-USD (1 USD = 1_000_000 micro). Templates that talk to providers
 * which return dollars (or cents) MUST convert at the provider boundary
 * before populating `_costMicroUsd`. Dollar formatting happens only in
 * UI / reporting / log strings — never in budget math. Eliminates the
 * unit-drift class of bugs at source.
 */
export type FindingDraft = {
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  urgency: AgentFindingUrgency;
  /** Number of LLM round-trips this summarise() call performed. */
  _llmHops: number;
  /** Micro-USD spent on this summarise() call (sum of provider costs). */
  _costMicroUsd: number;
};

/**
 * Generic template interface. The runtime sees only this — concrete
 * templates (ResearchDigest in PR3, JobAgent in 3.1, etc.) implement it.
 *
 * **Invariant (docs/16 §22 #7):** the runner type-bounds templates at
 * `AgentTemplate<unknown, unknown>` and never casts to a concrete type.
 * If a future template-specific concern leaks into the runner, the
 * abstraction is wrong; fix the interface, not the runner.
 *
 * Methods:
 *  - `fetch`  — async generator yielding raw items from the template's source.
 *               The runner consumes up to `budget.maxItemsConsideredPerRun`.
 *  - `dedupeKey` — stable key for an item across runs. Indexed in
 *                 `agent_findings.dedupe_key` (UNIQUE per agent).
 *  - `score`  — relevance score in [0, 1]. Items below
 *               `config.minScore` are dropped before summarise.
 *  - `summarise` — produce the finding draft. Cost + hop counts surface to
 *                  the runner via `_costMicroUsd` / `_llmHops`.
 *  - `briefing` (optional) — after the kept-items loop, synthesize a
 *                  run-level briefing (added 2026-05-18 per docs/18
 *                  follow-up). Templates that don't implement it get the
 *                  pre-briefing behaviour. The runner persists the
 *                  returned object to `agent_runs.briefing` as-is; a
 *                  thrown error or null return leaves the column NULL
 *                  and never fails the run.
 */
export type AgentTemplate<TConfig, TItem> = {
  /** Stable id matching `agents.template_id`. */
  id: string;
  displayName: string;
  description: string;
  defaultBadge: Badge;
  defaultCadenceHours: number;
  defaultBudget: AgentBudget;
  /** Zod schema (or any validator) for the template's `config` shape. The
   *  runner doesn't call this directly — agent-creation code does. */
  configSchema: { parse: (raw: unknown) => TConfig };
  /** Broker categories needed for prompt assembly (e.g. ['interests']). */
  brokerCategories: string[];

  fetch(ctx: TemplateCallContext<TConfig>): AsyncIterable<TItem>;
  dedupeKey(item: TItem): string;
  score(item: TItem, ctx: TemplateCallContext<TConfig>): Promise<number>;
  summarise(item: TItem, ctx: TemplateCallContext<TConfig>): Promise<FindingDraft>;

  /**
   * OPTIONAL hook. Called by the runner once per run, after the
   * fetch/score/summarise loop, with the items that produced a kept
   * finding (post-summarise). Returns the briefing JSON the runner
   * persists to `agent_runs.briefing` as-is, PLUS cost telemetry
   * (mirrors `FindingDraft._llmHops` / `_costMicroUsd`) so the
   * briefing hop counts toward `agent_runs.cost_usd` and `llm_hops`.
   *
   * Briefing JSON shape is template-defined (versioned via a `version`
   * field inside the JSON). Runner does no validation; templates own
   * the shape contract with their inbox renderer.
   *
   * **Failure semantics**: a thrown error or rejected promise from
   * `briefing()` does NOT fail the run. The runner logs (scrubbed) and
   * leaves the column NULL. A `null` return is also fine (e.g. zero
   * kept items, or template decides briefing isn't useful for this run).
   */
  briefing?(
    keptItems: Array<BriefingKeptItem>,
    ctx: TemplateCallContext<TConfig>,
  ): Promise<BriefingResult | null>;
};

/**
 * Minimal projection of a kept item passed to `template.briefing`.
 * The runner builds this from the dedupe-key + the FindingDraft
 * returned by `summarise` + the per-item score, so the briefing call
 * is bounded by what the template already produced for that item.
 */
export type BriefingKeptItem = {
  dedupeKey: string;
  title: string;
  url: string | null;
  summary: string | null;
  score: number;
};

/**
 * Return type of `template.briefing()`. The runner persists `briefing`
 * to `agent_runs.briefing`, accumulates `_llmHops` into
 * `agent_runs.llm_hops`, and adds `_costMicroUsd` (micro-USD) to the
 * run's cost accumulator (matches `FindingDraft`'s convention).
 *
 * Templates that fall back to a deterministic briefing should return
 * `_llmHops: 0` and `_costMicroUsd: 0` for the no-LLM branch.
 */
export type BriefingResult = {
  briefing: Record<string, unknown>;
  _llmHops: number;
  _costMicroUsd: number;
};

// ─── Budget check result — used by `checkBudget` ──────────────────────────

/**
 * Outcome of a budget check. `reason` on the failure branch is the
 * developer-facing explanation; it is safe to log (no user content) but
 * is NOT shown to the end user verbatim — the runner maps it to a status
 * + an end-user-friendly inbox surface in 3.1.
 */
export type BudgetCheckResult =
  | { ok: true }
  | { ok: false; reason: string; kind: "per_agent_runs" | "cpaud_ceiling" };
