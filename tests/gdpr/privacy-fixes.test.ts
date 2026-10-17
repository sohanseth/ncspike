/**
 * Privacy fixes (prompt D) — static guards for the pieces that don't need a
 * live backend: the migration's one-time data fixes, the retired WhatsApp
 * and legacy-chat entry points, the Gmail pull no longer auto-queueing
 * research, retention rules, the phone app's HTTPS address, and the mobile
 * "More" sheet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20261018000000_privacy_fixes.sql");

describe("migration: one-time privacy fixes", () => {
  it("resets Voice Drafts consent for everyone", () => {
    expect(MIGRATION).toMatch(
      /update\s+public\.user_settings\s+set\s+voice_drafts_consent_at\s*=\s*null/i,
    );
  });

  it("cancels automatically queued research tasks that haven't run", () => {
    expect(MIGRATION).toMatch(
      /update\s+public\.research_tasks[\s\S]*?status\s*=\s*'cancelled'[\s\S]*?source\s*=\s*'auto'\s+and\s+status\s*=\s*'pending'/i,
    );
  });

  it("makes delete_user_data service-role only", () => {
    expect(MIGRATION).toMatch(
      /revoke\s+execute\s+on\s+function\s+public\.delete_user_data\(uuid\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(MIGRATION).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.delete_user_data\(uuid\)\s+to\s+service_role/i,
    );
  });

  it("retention sweeps 30-day-old search queries and expired voice profiles", () => {
    expect(MIGRATION).toMatch(
      /delete\s+from\s+public\.search_queries\s+where\s+created_at\s*<\s*now\(\)\s*-\s*interval\s*'30 days'/i,
    );
    expect(MIGRATION).toMatch(
      /delete\s+from\s+public\.voice_profiles\s+where\s+expires_at\s*<\s*now\(\)/i,
    );
  });
});

describe("Gmail pull no longer auto-queues sender research", () => {
  it("gmail.functions.ts never enqueues research tasks", () => {
    const src = read("src/lib/gmail.functions.ts");
    expect(src).not.toMatch(/enqueueResearchTask/);
    expect(src).not.toMatch(/research-queue/);
  });
});

describe("retired endpoints answer 410 gone", () => {
  it("WhatsApp server function is gone and calls nothing", () => {
    const src = read("src/lib/whatsapp.functions.ts");
    expect(src).toMatch(/status:\s*410/);
    expect(src).toMatch(/"gone"/);
    expect(src).not.toMatch(/connector-gateway/);
    expect(src).not.toMatch(/console\./);
  });

  it("WhatsApp webhook route is gone and logs nothing", () => {
    const src = read("src/routes/api.public.whatsapp.ts");
    expect(src).toMatch(/status:\s*410/);
    expect(src).toMatch(/"gone"/);
    expect(src).not.toMatch(/console\./);
  });

  it("legacy supabase chat function is gone and calls no AI service", () => {
    const src = read("supabase/functions/chat/index.ts");
    expect(src).toMatch(/status:\s*410/);
    expect(src).toMatch(/"gone"/);
    expect(src).not.toMatch(/ai\.gateway/);
    expect(src).not.toMatch(/LOVABLE_API_KEY/);
  });
});

describe("nightly job sweeps orphaned attachments but keeps linked files", () => {
  it("research-cron deletes day-old unreferenced files and keeps imagegen output", () => {
    const src = read("src/server/research-cron.ts");
    expect(src).toMatch(/sweepOrphanedAttachments/);
    expect(src).toMatch(/chat-attachments/);
    expect(src).toMatch(/imagegen/);
    expect(src).toMatch(/chat_message_attachments/);
    expect(src).toMatch(/24 \* 60 \* 60 \* 1000/);
  });
});

describe("phone app loads the published site over HTTPS", () => {
  const src = read("capacitor.config.ts");

  it("server.url is https and not a private network address", () => {
    const m = src.match(/url:\s*"([^"]+)"/);
    expect(m).toBeTruthy();
    const url = m![1];
    expect(url.startsWith("https://")).toBe(true);
    expect(url).not.toMatch(/192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\.local|localhost/);
  });

  it("cleartext is gone, androidScheme and allowNavigation kept", () => {
    expect(src).not.toMatch(/cleartext/);
    expect(src).toMatch(/androidScheme:\s*"https"/);
    expect(src).toMatch(/allowNavigation/);
    expect(src).toMatch(/ncspike\.lovable\.app/);
  });
});

describe("mobile More sheet", () => {
  const src = read("src/components/workspace/MainApp.tsx");
  const sheet = src.slice(src.indexOf("function MobileQuickBar"));

  it("offers all nine header actions", () => {
    for (const label of [
      "Search", "Compose", "You", "Connect", "Test", "Personalization", "Sign out",
    ]) {
      expect(sheet).toContain(label);
    }
    // AddTaskButton and BriefingsButton are reused as-is.
    expect(sheet).toMatch(/<AddTaskButton\s*\/>/);
    expect(sheet).toMatch(/<BriefingsButton\s*\/>/);
  });

  it("stays mobile-only and leaves the desktop header untouched", () => {
    expect(sheet).toMatch(/md:hidden/);
  });
});

describe("Voice Drafts consent gate", () => {
  it("buildVoiceProfile refuses without consent", () => {
    const src = read("src/lib/voice-drafts.functions.ts");
    const fnStart = src.indexOf("export const buildVoiceProfile");
    const body = src.slice(fnStart, fnStart + 800);
    expect(body).toMatch(/assertCanDraft\(context\.userId\)/);
    // Consent check comes before any Gmail access.
    expect(body.indexOf("assertCanDraft")).toBeLessThan(body.indexOf("getValidGmailAccessToken"));
  });

  it("consent dialog names Gemini via the Lovable AI gateway", () => {
    const src = read("src/components/workspace/MainApp.tsx");
    expect(src).toContain("Google's Gemini model through Lovable's AI gateway");
    expect(src).toContain("200 of your sent emails");
    expect(src).not.toContain("Cloudflare Workers AI");
  });
});
