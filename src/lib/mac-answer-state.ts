import type { MacCard } from "@/lib/mac-cards";

export const ANSWERED_KEY = "nc-answered";
export type AnsweredCards = Record<string, number>;
export const answerIdentity = (row: MacCard["row"]) => `${row.ref}:${row.nonce}`;
export function recentAnswers(value: unknown, now = Date.now()): AnsweredCards {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === "number" && at > now - 4 * 86400000 && at <= now));
}
export function readAnswered(): AnsweredCards {
  try { return recentAnswers(JSON.parse(localStorage.getItem(ANSWERED_KEY) || "{}")); } catch { return {}; }
}
export function rememberAnswered(row: MacCard["row"]): AnsweredCards {
  const next = { ...readAnswered(), [answerIdentity(row)]: Date.now() };
  try { localStorage.setItem(ANSWERED_KEY, JSON.stringify(next)); } catch { /* still hide this session */ }
  return next;
}
export const answerableActions = (card: MacCard) => card.private ? [] : card.actions.filter((a) => (a.kind === "done" || a.kind === "remind") && a.ref);