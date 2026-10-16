import { z } from "zod";

// Keep in sync with src/lib/insight-card.ts (the InsightCard type). This is
// the strict runtime check for cards arriving from the Mac app (or anywhere
// else) — unknown keys, oversized fields and inconsistent "private" cards are
// all rejected here.

const noLineBreaks = (max: number) =>
  z.string().min(1).max(max).refine((s) => !/[\r\n]/.test(s), "No line breaks allowed");

const isoDateOrDateTime = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const actionSchema = z
  .object({
    label: z.string().min(1).max(40),
    kind: z.enum(["draft_reply", "block_time", "add_to_calendar", "remind", "open", "done"]),
    ref: z.string().max(200).optional(),
  })
  .strict();

export const insightCardSchema = z
  .object({
    id: noLineBreaks(160),
    kind: z.enum(["clash", "free_slot", "overdue", "missing_from_calendar", "prep", "reminder"]),
    text: noLineBreaks(320),
    why: noLineBreaks(160),
    sources: z
      .array(z.enum(["calendar", "email", "tasks", "mac"]))
      .min(1)
      .refine((arr) => new Set(arr).size === arr.length, "Duplicate source"),
    domain: z.enum(["professional", "learning", "social", "family", "personal"]),
    about: z.string().regex(isoDateOrDateTime).optional(),
    actions: z.array(actionSchema).max(3),
    private: z.boolean().optional(),
    origin: z.enum(["demo", "cloud", "mac"]),
    createdAt: z.string().regex(isoDateOrDateTime),
  })
  .strict()
  .refine(
    (card) => !card.private || (card.actions.length === 0 && card.sources.length === 1 && card.sources[0] === "mac"),
    "Private cards must have no actions and sources exactly [\"mac\"]",
  );

export type InsightCardParsed = z.infer<typeof insightCardSchema>;
