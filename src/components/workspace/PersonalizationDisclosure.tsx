/**
 * First-run disclosure for personalization (Phase 2.7 D8 Day 7).
 *
 * Shown once per user (localStorage-gated) on the Personalization and Privacy
 * pages — explains the four guarantees in plain English before the user
 * touches any toggle. Dismissable via "Got it"; the user can re-read it any
 * time on the Privacy page.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldCheck, X } from "lucide-react";

const STORAGE_KEY_PREFIX = "nc.personalization.disclosure.v1.";

/**
 * Per-user storage key. A shared browser would otherwise let one user dismiss
 * the disclosure for everyone — bad for privacy UX. Falls back to a global
 * key only when no userId is supplied.
 */
function storageKeyFor(userId?: string | null): string {
  return STORAGE_KEY_PREFIX + (userId && userId.length > 0 ? userId : "_anon");
}

export function PersonalizationDisclosure({
  /** Force-show even if previously dismissed (used from Privacy "show again"). */
  force = false,
  /** Authenticated user id — keys the dismissal record per-account. */
  userId,
  onDismiss,
}: {
  force?: boolean;
  userId?: string | null;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (force) {
      setOpen(true);
      return;
    }
    try {
      if (typeof window === "undefined") return;
      const seen = window.localStorage.getItem(storageKeyFor(userId));
      if (!seen) setOpen(true);
    } catch {
      // localStorage unavailable (e.g. SSR or private mode) — silently skip.
    }
  }, [force, userId]);

  function dismiss() {
    setOpen(false);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKeyFor(userId), new Date().toISOString());
      }
    } catch {
      /* ignore */
    }
    onDismiss?.();
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nc-disclosure-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="relative w-full max-w-lg rounded-xl border bg-background p-6 shadow-xl">
        <button
          type="button"
          aria-label="Close"
          onClick={dismiss}
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-500" />
          <h2 id="nc-disclosure-title" className="text-lg font-semibold">
            How personalization works here
          </h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Before you start tweaking categories, four things to know:
        </p>
        <ol className="mb-5 space-y-2 text-sm">
          <li>
            <span className="font-medium">1. Your raw memory never leaves your device.</span>{" "}
            We extract a small structured trait sheet locally; only relevant slices reach
            the model.
          </li>
          <li>
            <span className="font-medium">2. Identifiers are banned by schema.</span>{" "}
            Names, emails, phone numbers, employer, salary, and exact age can't enter the
            sheet — even if you ask for it.
          </li>
          <li>
            <span className="font-medium">3. The Private badge is fail-closed.</span>{" "}
            Pick Private and only the on-rails provider runs. There's no silent fallback.
          </li>
          <li>
            <span className="font-medium">4. Every personalization decision is logged for you.</span>{" "}
            You can see what was used (and forget it) under each chat message and on the
            Personalization page.
          </li>
        </ol>
        <p className="mb-5 text-xs text-muted-foreground">
          Full guarantees on the{" "}
          <Link to="/workspace/privacy" className="underline underline-offset-4">
            Privacy page
          </Link>
          .
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
