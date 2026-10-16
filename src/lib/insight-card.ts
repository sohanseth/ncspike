export type InsightCard = {
  id: string;
  kind: "clash" | "free_slot" | "overdue" | "missing_from_calendar" | "prep" | "reminder";
  text: string; // one plain sentence
  why: string; // the evidence, e.g. "From Priya's email and your calendar"
  sources: ("calendar" | "email" | "tasks" | "mac")[];
  domain: "professional" | "learning" | "social" | "family" | "personal";
  about?: string; // ISO date-time the card is about
  actions: {
    label: string;
    kind: "draft_reply" | "block_time" | "add_to_calendar" | "remind" | "open";
    ref?: string;
  }[];
  private?: boolean; // if true: no colour, no details shown
  origin: "demo" | "cloud" | "mac";
  createdAt: string;
};
