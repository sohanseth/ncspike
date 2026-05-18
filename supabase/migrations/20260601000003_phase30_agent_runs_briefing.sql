-- ────────────────────────────────────────────────────────────────────────────
-- Phase 3.0 — agent_runs.briefing (product-layer persistence for the
-- briefing layer added 2026-05-18)
-- ────────────────────────────────────────────────────────────────────────────
--
-- Adds a nullable JSONB column to hold the per-run briefing — a small
-- LLM-synthesized object (`headline`, `synthesis`, `topPicks[]`,
-- `findingLabels{}`, `qualityNote?`) the inbox renders above the
-- per-finding cards so the experience stops looking like a search-
-- results page and starts feeling agentic.
--
-- Shape lives in TypeScript (src/server/agents/templates/research-digest.ts);
-- the column stores the JSON unchanged. A `version` field inside the JSON
-- gives us migration flexibility — bump to 2+ when the shape evolves.
--
-- Freeze rule exception (Sneha 2026-05-18): the current product output
-- is verified technically working but not useful. This migration is the
-- minimal persistence change required for the next user-visible product
-- layer — not a return to runtime architecture.
--
-- Nullable on purpose: existing rows stay valid, runs whose template
-- doesn't generate a briefing (or whose briefing generation falls back
-- entirely) leave the column NULL. The inbox UI handles NULL by
-- rendering findings without a briefing block (back-compat).

alter table public.agent_runs
  add column if not exists briefing jsonb;

comment on column public.agent_runs.briefing is
  'Phase 3.0 (added 2026-05-18) — per-run briefing JSON synthesized by the template after kept findings exist. Contains a versioned object with headline/synthesis/topPicks/findingLabels. NULL when the template did not produce a briefing or when generation failed and the deterministic fallback was also skipped.';
