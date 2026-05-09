/**
 * Task #40: one-shot backfill of v1 user_traits sheets to the per-trait
 * freshness format (`trait_meta` + `trait_embeddings`).
 *
 * Usage (from the project root):
 *   pnpm run backfill:trait-meta
 *
 * Requires the same secrets the server uses:
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (Supabase admin RPC)
 *   - CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN  (bge-small-en embeddings)
 *
 * The script is idempotent — already-upgraded rows are detected and skipped
 * without any LLM or embedding work, so it's safe to re-run after partial
 * failures.
 */
import { backfillTraitMetaAllUsers } from "@/server/trait-extraction";

async function main() {
  const summary = await backfillTraitMetaAllUsers();
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[backfill-trait-meta] fatal:", e);
  process.exit(1);
});
