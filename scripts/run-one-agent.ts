/**
 * Manual one-shot trigger for the Phase 3.0 agent runtime.
 *
 * Why this script exists:
 *   - The Cloudflare Worker cron that fires `runAgentBatchTick()` every
 *     30 min is not yet deployed to production (see project memory:
 *     "Cloudflare Worker production deploy" listed as pending).
 *   - There is no "Run now" affordance in the agents UI today.
 *   - PR #22 (briefing layer) deploy verification requires actually
 *     firing an agent run against the deployed Supabase so we can see
 *     the briefing column populate.
 *
 * This script bridges that gap without adding product surface: it uses
 * the same production deps as the Worker (`runAgentBatchTick` from
 * `src/worker.ts` already wires `resolveTemplate` + the production
 * broker), and uses the service-role Supabase admin client to optionally
 * force an agent "due" before the batch claims.
 *
 * Usage (from the project root):
 *
 *   # List active agents + their next-due timestamps.
 *   pnpm exec tsx --env-file=.env.local scripts/run-one-agent.ts
 *
 *   # Force a specific agent due (clears lease + sets last_run_at to
 *   # a past time) and fire one batch tick.
 *   pnpm exec tsx --env-file=.env.local scripts/run-one-agent.ts \
 *     --agent-id <uuid> --force-due
 *
 *   # Fire one batch tick without forcing any agent due (only naturally
 *   # due agents run — useful once cron is deployed).
 *   pnpm exec tsx --env-file=.env.local scripts/run-one-agent.ts --tick
 *
 * Required env vars (mirror the Worker):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   GROQ_API_KEY, TAVILY_API_KEY
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 *
 * Safe to re-run: --force-due is idempotent; the runner has its own
 * dedupe + per-finding upsert; failure modes match the production tick.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runAgentBatchTick } from "@/worker";

type Args = {
  agentId: string | null;
  forceDue: boolean;
  tick: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { agentId: null, forceDue: false, tick: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent-id") {
      out.agentId = argv[++i] ?? null;
    } else if (a === "--force-due") {
      out.forceDue = true;
    } else if (a === "--tick") {
      out.tick = true;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`[run-one-agent] unknown arg: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return out;
}

function printUsage(): void {
  console.log(
    "Usage: tsx --env-file=.env.local scripts/run-one-agent.ts " +
      "[--agent-id <uuid> --force-due | --tick]",
  );
}

async function listAgents(): Promise<void> {
  const { data, error } = await (supabaseAdmin as any)
    .from("agents")
    .select(
      "id, display_name, template_id, state, cadence_hours, last_completed_at, last_claimed_at, claim_expires_at, user_id",
    )
    .neq("state", "archived")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[run-one-agent] failed to list agents:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log("(no non-archived agents)");
    return;
  }
  console.log(`Active/inactive agents (${data.length}):\n`);
  for (const a of data as Array<{
    id: string;
    display_name: string;
    template_id: string;
    state: string;
    cadence_hours: number;
    last_completed_at: string | null;
    last_claimed_at: string | null;
    claim_expires_at: string | null;
  }>) {
    const nextDue = a.last_completed_at
      ? new Date(
          new Date(a.last_completed_at).getTime() + a.cadence_hours * 3600 * 1000,
        ).toISOString()
      : "(due now — never completed)";
    const leased = a.claim_expires_at && new Date(a.claim_expires_at) > new Date();
    console.log(
      `  ${a.id}  state=${a.state}  template=${a.template_id}\n` +
        `    name: ${a.display_name}\n` +
        `    cadence: ${a.cadence_hours}h  last_completed: ${a.last_completed_at ?? "never"}\n` +
        `    next_due: ${nextDue}  leased: ${leased ? "yes" : "no"}\n`,
    );
  }
}

async function forceDue(agentId: string): Promise<void> {
  // Clear the lease (in case a previous run is leased) and reset
  // last_completed_at so the agent qualifies under the cadence check.
  // claim_due_agents uses (last_completed_at + cadence_hours <= now())
  // as its due-ness predicate; setting last_completed_at to NULL is
  // the cleanest "treat as never run" signal (predicate becomes vacuous
  // true via COALESCE in the SQL function).
  const { error } = await (supabaseAdmin as any)
    .from("agents")
    .update({
      claim_expires_at: null,
      last_completed_at: null,
    })
    .eq("id", agentId);
  if (error) {
    console.error(`[run-one-agent] force-due failed:`, error.message);
    process.exit(1);
  }
  console.log(`[run-one-agent] forced due: agent ${agentId}`);
}

async function reportLatestRun(agentId: string): Promise<void> {
  const { data, error } = await (supabaseAdmin as any)
    .from("agent_runs")
    .select(
      "id, status, items_fetched, items_kept, llm_hops, cost_usd, error, briefing, started_at, finished_at",
    )
    .eq("agent_id", agentId)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error(`[run-one-agent] could not read agent_runs:`, error.message);
    return;
  }
  if (!data || data.length === 0) {
    console.log(`[run-one-agent] no agent_runs row found for agent ${agentId}`);
    return;
  }
  const r = data[0];
  console.log(`\nLatest agent_runs for ${agentId}:`);
  console.log(`  id:             ${r.id}`);
  console.log(`  status:         ${r.status}`);
  console.log(`  items_fetched:  ${r.items_fetched}`);
  console.log(`  items_kept:     ${r.items_kept}`);
  console.log(`  llm_hops:       ${r.llm_hops}`);
  console.log(`  cost_usd:       ${r.cost_usd}`);
  console.log(`  error:          ${r.error ?? "(none)"}`);
  console.log(`  started_at:     ${r.started_at}`);
  console.log(`  finished_at:    ${r.finished_at}`);
  console.log(`  briefing:       ${r.briefing ? "POPULATED" : "NULL"}`);
  if (r.briefing && typeof r.briefing === "object") {
    const b = r.briefing as Record<string, unknown>;
    console.log(`    version:      ${b.version}`);
    console.log(`    headline:     ${b.headline}`);
    if (typeof b.synthesis === "string") {
      console.log(`    synthesis:    ${b.synthesis.slice(0, 200)}${b.synthesis.length > 200 ? "…" : ""}`);
    }
    if (Array.isArray(b.topPicks)) {
      console.log(`    topPicks:     ${b.topPicks.length}`);
    }
    if (b.findingLabels && typeof b.findingLabels === "object") {
      console.log(`    findingLabels: ${Object.keys(b.findingLabels).length} keys`);
    }
    if (b.qualityNote) {
      console.log(`    qualityNote:  ${b.qualityNote}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Sanity: surface a clean error before the runner does, since the
  // service-role client throws lazily on the first call.
  for (const k of [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GROQ_API_KEY",
    "TAVILY_API_KEY",
  ]) {
    if (!process.env[k]) {
      console.error(
        `[run-one-agent] missing env var: ${k} — ` +
          `did you forget --env-file=.env.local?`,
      );
      process.exit(2);
    }
  }

  // No args → list mode.
  if (!args.agentId && !args.tick) {
    await listAgents();
    console.log(
      "\nNext: pass --agent-id <uuid> --force-due to run one, " +
        "or --tick to run the natural batch.",
    );
    return;
  }

  if (args.agentId && args.forceDue) {
    await forceDue(args.agentId);
  }

  console.log("\n[run-one-agent] firing runAgentBatchTick()…\n");
  const startedAt = Date.now();
  await runAgentBatchTick();
  console.log(
    `\n[run-one-agent] tick complete (${Date.now() - startedAt}ms)`,
  );

  if (args.agentId) {
    await reportLatestRun(args.agentId);
  }
}

main().catch((e) => {
  console.error("[run-one-agent] fatal:", e);
  process.exit(1);
});
