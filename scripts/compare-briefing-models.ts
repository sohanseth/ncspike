/**
 * Compare the v2 briefing prompt across multiple LLM providers using the
 * EXACT same prompt that ran in production. Surfaced by Sneha 2026-05-18:
 * the safety agent's run produced bland-feeling takeaways; we need to
 * know whether the bottleneck is the model (Groq Llama-3.3-70b via the
 * 'flash' chain) or the prompt + Tavily-snippet inputs.
 *
 * Methodology:
 *   1. Pull the most recent successful v2 run for an agent (--agent-id).
 *   2. Fetch the agent_findings inserted by that run — these are the
 *      exact kept items the briefing saw.
 *   3. Rebuild the SAME prompt via briefingPromptV2().
 *   4. Call each provider listed in --providers (default: groq, anthropic,
 *      openai). Print outputs side-by-side with token counts.
 *   5. Optional --no-prior to omit the prior briefing (test first-run
 *      shape only).
 *
 * Cost: one LLM call per provider. ~$0.05 total for the default set.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env.local scripts/compare-briefing-models.ts \
 *     --agent-id d0ce1f55-6e53-44a3-a8a9-c955164fd346
 *
 *   pnpm exec tsx --env-file=.env.local scripts/compare-briefing-models.ts \
 *     --agent-id <uuid> --providers groq,anthropic
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * plus whatever provider keys you want to test (GROQ_API_KEY,
 * ANTHROPIC_API_KEY, OPENAI_API_KEY).
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getProvider } from "@/server/inference";
import {
  briefingPromptV2,
  ResearchDigestBriefingV2Schema,
} from "@/server/agents/templates/research-digest";
import type { ProviderId } from "@/lib/provider-tiers";
import type { BriefingKeptItem } from "@/server/agents/types";

type Args = {
  agentId: string | null;
  providers: ProviderId[];
  withPrior: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    agentId: null,
    providers: ["groq", "anthropic", "openai"],
    withPrior: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent-id") out.agentId = argv[++i] ?? null;
    else if (a === "--providers")
      out.providers = (argv[++i] ?? "").split(",").map((p) => p.trim().toLowerCase() as ProviderId);
    else if (a === "--no-prior") out.withPrior = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx --env-file=.env.local scripts/compare-briefing-models.ts " +
          "--agent-id <uuid> [--providers groq,anthropic,openai] [--no-prior]",
      );
      process.exit(0);
    } else {
      console.error(`[compare-briefing-models] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.agentId) {
    console.error("--agent-id is required");
    process.exit(2);
  }

  // 1. Pull the most recent SUCCESSFUL v2 run for this agent.
  const { data: runs, error: runsErr } = await (supabaseAdmin as any)
    .from("agent_runs")
    .select("id, agent_id, user_id, started_at")
    .eq("agent_id", args.agentId)
    .eq("status", "ok")
    .not("briefing", "is", null)
    .order("started_at", { ascending: false })
    .limit(2);
  if (runsErr || !runs || runs.length === 0) {
    console.error("No successful runs found for agent", args.agentId, runsErr?.message);
    process.exit(1);
  }
  const targetRun = runs[0];
  const priorRun = runs[1] ?? null;

  // 2. Fetch the agent + its config (topics).
  const { data: agent } = await (supabaseAdmin as any)
    .from("agents")
    .select("display_name, config")
    .eq("id", args.agentId)
    .single();
  const topics: string[] = agent?.config?.topics ?? [];

  // 3. Fetch the kept findings from this run.
  const { data: findings } = await (supabaseAdmin as any)
    .from("agent_findings")
    .select("dedupe_key, title, source_url, summary, score, payload, created_at")
    .eq("agent_id", args.agentId)
    .gte("created_at", targetRun.started_at)
    .order("score", { ascending: false });

  if (!findings || findings.length === 0) {
    console.error("No findings for this run");
    process.exit(1);
  }

  const keptItems: BriefingKeptItem[] = (findings as Array<{
    dedupe_key: string;
    title: string;
    source_url: string | null;
    summary: string | null;
    score: number;
  }>).map((f) => ({
    dedupeKey: f.dedupe_key,
    title: f.title,
    url: f.source_url,
    summary: f.summary, // Tavily snippet (v2)
    score: Number(f.score),
  }));

  // 4. Optionally pull the prior briefing (so we exercise the
  // cross-run-continuity prompt shape).
  let priorBriefing: any = null;
  if (args.withPrior && priorRun) {
    const { data: prior } = await (supabaseAdmin as any)
      .from("agent_runs")
      .select("briefing")
      .eq("id", priorRun.id)
      .single();
    const raw = prior?.briefing ?? null;
    // Validate against the v2 schema — older runs may be v1 (different
    // shape) and would crash compactPriorForPrompt. Same defensive
    // discipline as production fetchPriorBriefingV2.
    if (raw) {
      const parsed = ResearchDigestBriefingV2Schema.safeParse(raw);
      if (parsed.success && parsed.data.failureClass === undefined) {
        priorBriefing = parsed.data;
      }
    }
  }

  // 5. Build the prompt.
  const prompt = briefingPromptV2(keptItems, keptItems.length, topics, priorBriefing);

  // 6. Print metadata + run each provider.
  console.log("─".repeat(72));
  console.log(`AGENT: ${agent.display_name}`);
  console.log(`TOPICS: ${topics.join(", ")}`);
  console.log(`RUN: ${targetRun.id} (started ${targetRun.started_at})`);
  console.log(`KEPT ITEMS: ${keptItems.length}`);
  console.log(`PRIOR BRIEFING: ${priorBriefing ? "yes (included)" : "none"}`);
  console.log(`PROMPT SIZE: ${prompt.length} chars`);
  console.log("─".repeat(72));

  for (const providerId of args.providers) {
    console.log(`\n${"═".repeat(72)}`);
    console.log(`  PROVIDER: ${providerId}`);
    console.log(`${"═".repeat(72)}`);
    const startedAt = Date.now();
    try {
      const provider = await getProvider(providerId);
      const result = await provider.generate({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1200,
        temperature: 0.4,
      });
      const elapsed = Date.now() - startedAt;
      console.log(`model:    ${result.model}`);
      console.log(`latency:  ${elapsed}ms`);
      console.log(`tokens:   in=${result.inputTokens} out=${result.outputTokens}`);
      console.log(`─── output ${"─".repeat(60)}`);
      console.log(result.text);

      // Try to parse as JSON to extract just the takeaways for a
      // quick "what does this look like" view.
      try {
        const jsonStart = result.text.indexOf("{");
        if (jsonStart !== -1) {
          const obj = JSON.parse(result.text.slice(jsonStart));
          console.log(`─── parsed shape (takeaways only) ${"─".repeat(38)}`);
          console.log(`headline:    ${obj.headline}`);
          console.log(`synthesis:   ${obj.synthesis}`);
          if (Array.isArray(obj.memorableTakeaways)) {
            console.log(`takeaways (${obj.memorableTakeaways.length}):`);
            for (const t of obj.memorableTakeaways) {
              console.log(`  - ${t.text}`);
            }
          }
        }
      } catch {
        console.log("(could not parse as JSON for takeaway view)");
      }
    } catch (e) {
      console.error(`[${providerId}] threw:`, e);
    }
  }
}

main().catch((e) => {
  console.error("[compare-briefing-models] fatal:", e);
  process.exit(1);
});
