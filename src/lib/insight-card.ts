// The one card format shared by the NeuralConnexions Mac app and the web and phone app. Version 1.
// Keep this file identical in both codebases: in the Lovable app it lives at src/lib/insight-card.ts.
// The Mac app's tests check that nc/app/cards.py and contract/insight-card.schema.json agree with it.

export const INSIGHT_CARD_VERSION = 1;

export type InsightCard = {
  id: string;
  kind: "clash" | "free_slot" | "overdue" | "missing_from_calendar" | "prep" | "reminder";
  text: string;        // plain sentences, put together from the person's own data
  why: string;         // the evidence, e.g. "From the email you shared and your calendar."
  sources: ("calendar" | "email" | "tasks" | "mac")[];
  domain: "professional" | "learning" | "social" | "family" | "personal";
  about?: string;      // ISO date or date-time the card is about
  actions: { label: string; kind: "draft_reply" | "block_time" | "add_to_calendar" | "remind" | "open" | "done"; ref?: string }[];
  private?: boolean;   // if true: no colour, no details shown, no actions
  origin: "demo" | "cloud" | "mac";
  createdAt: string;   // ISO date-time
};
