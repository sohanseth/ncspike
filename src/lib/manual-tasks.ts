/**
 * Manual to-do tasks — entered by the user, classified into one of the five
 * workspace domains (bento boxes) using a small keyword-based classifier.
 *
 * Persistence is localStorage-only for now (matches the local-first Phase-1
 * direction in mem://features/local-first-roadmap). Easy to swap for a
 * Supabase-backed table later without changing the hook contract.
 */

import { useCallback, useEffect, useState } from "react";

export type DomainId = "learning" | "family" | "social" | "professional" | "personal";

export interface ManualTask {
  id: string;
  text: string;
  domain: DomainId;
  urgent: boolean;
  createdAt: string; // ISO
  done?: boolean;
}

const STORAGE_KEY = "nc.manualTasks.v1";

// ---------------------------------------------------------------------------
// Classifier — keyword scoring per domain. Extensible: add words to a list
// and they immediately bias new tasks toward that domain. Ties resolve toward
// "personal" (the lowest-stakes default).
// ---------------------------------------------------------------------------

const KEYWORDS: Record<DomainId, string[]> = {
  family: [
    "kid", "kids", "child", "children", "school", "ballet", "pickup", "drop off",
    "daughter", "son", "mom", "mum", "dad", "parent", "grandma", "grandpa",
    "grocery", "groceries", "dinner at home", "laundry", "cleaning", "babysit",
    "zara", "playdate", "homework", "bedtime", "nursery", "pediatrician",
  ],
  professional: [
    "work", "linkedin", "meeting", "client", "boss", "manager", "team",
    "presentation", "deck", "slides", "report", "project", "slack", "jira",
    "deadline", "invoice", "salary", "interview", "ceo", "cto", "1:1",
    "standup", "review", "kickoff", "stakeholder", "okrs", "sprint", "demo",
    "email reply", "email back", "draft email", "follow up with",
  ],
  learning: [
    "book", "course", "study", "learn", "tutorial", "read", "reading",
    "lesson", "chapter", "exam", "certificate", "lecture", "podcast",
    "coursera", "udemy", "youtube", "watch video", "research paper", "notes on",
    "practice", "khan", "duolingo", "language",
  ],
  social: [
    "friend", "party", "coffee", "drinks", "brunch", "lunch with",
    "dinner with", "message", "text", "dm", "whatsapp", "instagram",
    "hangout", "catch up", "birthday", "wedding", "rsvp", "reach out",
    "maya", "jake", "alex",
  ],
  personal: [
    "buy", "shop", "shopping", "order", "amazon", "gym", "run", "running",
    "workout", "fitness", "yoga", "meditate", "doctor", "dentist", "haircut",
    "travel", "trip", "paris", "hotel", "flight", "vacation", "holiday",
    "dress", "shoes", "outfit", "skincare", "renew", "passport", "license",
    "bills", "bank", "budget", "savings",
  ],
};

const URGENT_HINTS = [
  /\btoday\b/i, /\btonight\b/i, /\bnow\b/i, /\basap\b/i, /\burgent\b/i,
  /\bdue\s+today\b/i, /\bovernight\b/i, /\bin\s+\d+\s+(min|mins|minutes|hours?)\b/i,
  /!!+/,
];

export function classifyTask(raw: string): { domain: DomainId; urgent: boolean } {
  const text = raw.toLowerCase();
  const scores: Record<DomainId, number> = {
    learning: 0, family: 0, social: 0, professional: 0, personal: 0,
  };
  for (const [domain, words] of Object.entries(KEYWORDS) as [DomainId, string[]][]) {
    for (const w of words) {
      // word-boundary match for single words; substring for multi-word phrases
      const pattern = w.includes(" ")
        ? new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
        : new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (pattern.test(text)) scores[domain] += 1;
    }
  }
  // Pick highest score; on tie, prefer in this order (most specific first).
  const order: DomainId[] = ["family", "professional", "learning", "social", "personal"];
  let best: DomainId = "personal";
  let bestScore = 0;
  for (const d of order) {
    if (scores[d] > bestScore) {
      best = d;
      bestScore = scores[d];
    }
  }
  const urgent = URGENT_HINTS.some((re) => re.test(raw));
  return { domain: best, urgent };
}

// ---------------------------------------------------------------------------
// Storage + cross-tab sync
// ---------------------------------------------------------------------------

function readAll(): ManualTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.id === "string") : [];
  } catch {
    return [];
  }
}

function writeAll(tasks: ManualTask[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    // Notify other components in this tab (storage event only fires across tabs).
    window.dispatchEvent(new CustomEvent("nc:manual-tasks-updated"));
  } catch {
    /* quota exceeded — silently drop */
  }
}

export function useManualTasks() {
  const [tasks, setTasks] = useState<ManualTask[]>(() => readAll());

  useEffect(() => {
    const refresh = () => setTasks(readAll());
    window.addEventListener("storage", refresh);
    window.addEventListener("nc:manual-tasks-updated", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("nc:manual-tasks-updated", refresh);
    };
  }, []);

  const addTask = useCallback((text: string): ManualTask | null => {
    const trimmed = text.trim().slice(0, 240);
    if (!trimmed) return null;
    const { domain, urgent } = classifyTask(trimmed);
    const task: ManualTask = {
      id: `mt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      text: trimmed,
      domain,
      urgent,
      createdAt: new Date().toISOString(),
    };
    const next = [task, ...readAll()];
    writeAll(next);
    setTasks(next);
    return task;
  }, []);

  // Bulk add — accepts an array of free-text lines (or a single block where
  // each newline is one task). Empty lines and pure-bullet glyphs get stripped.
  const addTasks = useCallback((input: string | string[]): ManualTask[] => {
    const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
    const created: ManualTask[] = [];
    for (const raw of lines) {
      const cleaned = raw.replace(/^\s*[-*•·–—]\s+/, "").replace(/^\s*\d+[.)]\s+/, "").trim().slice(0, 240);
      if (!cleaned) continue;
      const { domain, urgent } = classifyTask(cleaned);
      created.push({
        id: `mt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        text: cleaned,
        domain,
        urgent,
        createdAt: new Date().toISOString(),
      });
    }
    if (!created.length) return [];
    const next = [...created, ...readAll()];
    writeAll(next);
    setTasks(next);
    return created;
  }, []);

  const removeTask = useCallback((id: string) => {
    const next = readAll().filter((t) => t.id !== id);
    writeAll(next);
    setTasks(next);
  }, []);

  const toggleDone = useCallback((id: string) => {
    const next = readAll().map((t) => (t.id === id ? { ...t, done: !t.done } : t));
    writeAll(next);
    setTasks(next);
  }, []);

  return { tasks, addTask, addTasks, removeTask, toggleDone };
}
