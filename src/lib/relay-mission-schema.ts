import { z } from "zod";

export const MAX_MISSION_BODY = 16 * 1024;
const id = z.string().regex(/^m-[0-9a-f]{16}$/);
const trimmed = (max: number) => z.string().min(1).max(max).refine((s) => s === s.trim());
export const missionUpsertSchema = z.object({
  v: z.literal(1),
  mission: z.object({
    v: z.literal(1), id, template: z.literal("research_digest"), name: trimmed(80),
    topics: z.array(trimmed(120)).min(1).max(5).refine((ts) => new Set(ts.map((t) => t.toLowerCase())).size === ts.length),
    cadence: z.enum(["weekly", "nightly"]), status: z.enum(["active", "paused"]),
  }).strict(),
}).strict();
export const missionDeleteSchema = z.object({ v: z.literal(1), missionId: id }).strict();
export const missionResultsSchema = z.object({
  v: z.literal(1),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/).refine((s) => !Number.isNaN(Date.parse(s))),
}).strict();