/**
 * Phase 3.0 — agent home (server-only handler).
 *
 * Server-only impls of listAgentRowsFor + getAgentHomeFor. Lives in a
 * .server.ts sibling to keep `@/server/...` imports out of the client
 * bundle (vite's import-protection plugin denies them).
 *
 * Reads only — no writes. Pure aggregation over existing tables:
 *   - agents
 *   - agent_runs
 *
 * Owner-scope: every query filters by user_id BEFORE returning, even
 * though we already verified the supabase auth via the middleware.
 * supabaseAdmin bypasses RLS, so the user_id filter IS the security
 * boundary.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

import {
  type AgentHome,
  type AgentRow,
  type JsonValue,
} from "./agent-home.functions";

const RECENT_RUNS_LIMIT = 10;

/** Helper: build a human-readable topics_label from agents.config. */
function topicsLabelFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const c = config as Record<string, unknown>;
  if (!Array.isArray(c.topics)) return null;
  const topics = (c.topics as unknown[]).filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  if (topics.length === 0) return null;
  if (topics.length === 1) return topics[0];
  if (topics.length === 2) return `${topics[0]} · ${topics[1]}`;
  return `${topics[0]} +${topics.length - 1} more`;
}

/**
 * List agents for the inbox-level row list. One row per non-archived
 * agent with their latest run's status-line data.
 */
export async function listAgentRowsFor(userId: string): Promise<AgentRow[]> {
  // 1. Fetch agents.
  const { data: agents, error: agentsErr } = await (supabaseAdmin as any)
    .from("agents")
    .select(
      "id, display_name, template_id, state, cadence_hours, config, created_at, last_completed_at",
    )
    .eq("user_id", userId)
    .neq("state", "archived")
    .order("created_at", { ascending: false });

  if (agentsErr) {
    throw new Error(
      `Agent home list failed: ${scrubErrorMessage(agentsErr.message ?? String(agentsErr))}`,
    );
  }

  const agentRows = (agents ?? []) as Array<{
    id: string;
    display_name: string;
    template_id: string;
    state: string;
    cadence_hours: number;
    config: unknown;
  }>;

  if (agentRows.length === 0) return [];

  // 2. Fetch the most-recent run for each agent. One query per agent
  // is cheap at this scale (single-user inbox), and simpler than a
  // window-function workaround over the n×runs space.
  const rows: AgentRow[] = [];
  for (const a of agentRows) {
    const { data: latestRun } = await (supabaseAdmin as any)
      .from("agent_runs")
      .select("id, status, started_at, finished_at, items_kept, briefing")
      .eq("agent_id", a.id)
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(1);

    const lr = (latestRun ?? [])[0] as
      | {
          id: string;
          status: string;
          started_at: string;
          finished_at: string | null;
          items_kept: number;
          briefing: unknown;
        }
      | undefined;

    rows.push({
      id: a.id,
      display_name: a.display_name,
      template_id: a.template_id,
      state: a.state,
      cadence_hours: a.cadence_hours,
      topics_label: topicsLabelFromConfig(a.config),
      latest_run: lr
        ? {
            id: lr.id,
            status: lr.status,
            started_at: lr.started_at,
            finished_at: lr.finished_at,
            has_briefing: lr.briefing !== null && lr.briefing !== undefined,
            items_kept: lr.items_kept ?? 0,
          }
        : null,
    });
  }

  return rows;
}

/**
 * Fetch the agent home payload for a single agent. Returns null if
 * the agent doesn't exist OR belongs to a different user.
 */
export async function getAgentHomeFor(
  userId: string,
  agentId: string,
): Promise<AgentHome | null> {
  // 1. Fetch the agent (owner-scoped).
  const { data: agentRows, error: agentErr } = await (supabaseAdmin as any)
    .from("agents")
    .select("id, display_name, template_id, state, cadence_hours, config")
    .eq("id", agentId)
    .eq("user_id", userId)
    .limit(1);

  if (agentErr) {
    throw new Error(
      `Agent home fetch failed: ${scrubErrorMessage(agentErr.message ?? String(agentErr))}`,
    );
  }
  const agent = (agentRows ?? [])[0] as
    | {
        id: string;
        display_name: string;
        template_id: string;
        state: string;
        cadence_hours: number;
        config: unknown;
      }
    | undefined;
  if (!agent) return null;

  // 2. Fetch recent runs (newest first). Same query supplies the
  // activity timeline AND lets us derive latest_run + latest_briefing_run.
  const { data: runs, error: runsErr } = await (supabaseAdmin as any)
    .from("agent_runs")
    .select(
      "id, status, started_at, finished_at, items_kept, briefing",
    )
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(RECENT_RUNS_LIMIT);

  if (runsErr) {
    throw new Error(
      `Agent home runs fetch failed: ${scrubErrorMessage(runsErr.message ?? String(runsErr))}`,
    );
  }

  const runRows = (runs ?? []) as Array<{
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    items_kept: number;
    briefing: unknown;
  }>;

  // 3. Identify latest_run (most recent of any status).
  const latestRunRow = runRows[0] ?? null;

  // 4. Identify latest_briefing_run: most recent run whose briefing is
  // non-null. Distinct from latest_run because a failed run leaves
  // briefing NULL (or sets failureClass on the briefing JSON, but we
  // don't filter those out here — the render component handles them).
  const latestBriefingRow =
    runRows.find((r) => r.briefing !== null && r.briefing !== undefined) ?? null;

  return {
    agent: {
      id: agent.id,
      display_name: agent.display_name,
      template_id: agent.template_id,
      state: agent.state,
      cadence_hours: agent.cadence_hours,
      topics_label: topicsLabelFromConfig(agent.config),
    },
    latest_briefing_run: latestBriefingRow
      ? {
          id: latestBriefingRow.id,
          started_at: latestBriefingRow.started_at,
          finished_at: latestBriefingRow.finished_at,
          status: latestBriefingRow.status,
          briefing: latestBriefingRow.briefing as JsonValue,
          items_kept: latestBriefingRow.items_kept ?? 0,
        }
      : null,
    latest_run: latestRunRow
      ? {
          id: latestRunRow.id,
          started_at: latestRunRow.started_at,
          finished_at: latestRunRow.finished_at,
          status: latestRunRow.status,
          items_kept: latestRunRow.items_kept ?? 0,
          has_briefing:
            latestRunRow.briefing !== null && latestRunRow.briefing !== undefined,
        }
      : null,
    recent_runs: runRows.map((r) => ({
      id: r.id,
      started_at: r.started_at,
      finished_at: r.finished_at,
      status: r.status,
      items_kept: r.items_kept ?? 0,
      has_briefing: r.briefing !== null && r.briefing !== undefined,
      briefing: (r.briefing ?? null) as JsonValue,
    })),
  };
}
