/**
 * Explicit user-initiated import of known names for the PII scrub list.
 *
 * Per gate G7 (LOCKED 2026-05-08, see docs/06 §10): we NEVER auto-pull names
 * from contacts/calendar/email senders on login. Auto-import is the exact
 * pattern users associate with creepy apps, even when (as here) we use the
 * names only to redact them. GDPR Art. 7 also strongly prefers explicit
 * consent for this kind of derived-personal-data.
 *
 * The user invokes this from `/settings/personalization` (Day 5 UI) by:
 *   - typing names into a free-text field, or
 *   - granting one-shot Contacts API permission and reviewing the suggested
 *     list before any row is written.
 *
 * Either way the import is a deliberate user action. This module just exposes
 * the server-side primitives; the consent prompt lives in the UI.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type KnownNameSource = "contacts" | "calendar" | "email_sender" | "manual";

export type KnownNameRow = {
  name: string;
  source: KnownNameSource;
  added_at: string;
};

// Cap is enforced by the `import_known_names` RPC under a transactional lock.
// Mirrored here for documentation; do not rely on this value at the JS layer
// for cap enforcement (the DB is the source of truth).
const MIN_NAME_LEN = 2;
const MAX_NAME_LEN = 80;

/**
 * Import a batch of names for a user. Idempotent — duplicates are upserted
 * (PK is `(user_id, name)` per migration §5). Caps at MAX_NAMES_PER_USER to
 * bound the scrub-time loop and to prevent a malicious caller from
 * effectively DoSing the scrub by stuffing 100k tiny strings.
 *
 * Names are normalised before insert: trimmed, NFC-normalised, and any
 * obviously bad strings (empty, too long, containing newlines or control
 * chars) are dropped silently. We don't throw on per-name validation
 * failures — partial success is the right behaviour for a bulk import.
 */
export async function importKnownNames(
  userId: string,
  names: readonly string[],
  source: KnownNameSource,
): Promise<{ inserted: number; skipped: number; capped: boolean }> {
  // Normalise + dedupe in-memory before hitting the DB.
  const cleaned = new Set<string>();
  let skipped = 0;
  for (const raw of names) {
    if (typeof raw !== "string") {
      skipped++;
      continue;
    }
    const norm = raw.normalize("NFC").trim();
    if (norm.length < MIN_NAME_LEN || norm.length > MAX_NAME_LEN) {
      skipped++;
      continue;
    }
    // Reject strings with newlines / control chars — the scrub is a regex
    // word-boundary check and a multi-line "name" would never match anything
    // useful while bloating the loop.
    if (/[\x00-\x1f\x7f]/.test(norm)) {
      skipped++;
      continue;
    }
    cleaned.add(norm);
  }

  const candidates = Array.from(cleaned);
  if (candidates.length === 0) {
    return { inserted: 0, skipped, capped: false };
  }

  // Atomic cap + insert via SECURITY DEFINER RPC (architect Day-3 fix for
  // TOCTOU between count-then-insert). The RPC locks the user's row scope,
  // computes remaining capacity, and inserts under a single transaction.
  // Returns the TRUE inserted count (excluding pre-existing duplicates),
  // not the candidate count.
  const { data, error } = await (supabaseAdmin as any).rpc("import_known_names", {
    p_user_id: userId,
    p_names: candidates,
    p_source: source,
  });
  if (error) {
    throw new Error(`import_known_names rpc failed: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    inserted: (row?.inserted as number | undefined) ?? 0,
    skipped,
    capped: Boolean(row?.capped),
  };
}

/**
 * List the user's known-names entries. Used by the settings page to show the
 * import status; the scrub uses `loadKnownNames` in pii-scrub.ts (lighter,
 * names-only).
 */
export async function listKnownNames(userId: string): Promise<KnownNameRow[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("user_known_names")
    .select("name, source, added_at")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });
  if (error) throw new Error(`user_known_names list failed: ${error.message}`);
  return (data ?? []) as KnownNameRow[];
}

/**
 * Delete a single known-name entry (user removes someone from their scrub
 * list). PK is `(user_id, name)` so this is exact-match.
 */
export async function deleteKnownName(userId: string, name: string): Promise<void> {
  const { error } = await (supabaseAdmin as any)
    .from("user_known_names")
    .delete()
    .eq("user_id", userId)
    .eq("name", name);
  if (error) throw new Error(`user_known_names delete failed: ${error.message}`);
}

/**
 * Wipe the user's entire known-names list. Used by the settings page's
 * "clear scrub list" action and by the GDPR delete-account flow.
 */
export async function clearKnownNames(userId: string): Promise<void> {
  const { error } = await (supabaseAdmin as any)
    .from("user_known_names")
    .delete()
    .eq("user_id", userId);
  if (error) throw new Error(`user_known_names clear failed: ${error.message}`);
}
