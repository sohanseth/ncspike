import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { exportAccountData, deleteAccount } from "@/lib/gdpr.functions";
import { Loader, Download, Trash2, ShieldCheck, AlertTriangle, RefreshCw } from "lucide-react";
import { PersonalizationDisclosure } from "@/components/workspace/PersonalizationDisclosure";
import { ConnectMacSection } from "@/components/workspace/ConnectMacSection";
import { CloudFeaturesSection } from "@/components/workspace/CloudFeaturesSection";

export const Route = createFileRoute("/workspace/privacy")({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: "Privacy — NeuralConnexions" },
      {
        name: "description",
        content:
          "Privacy invariants for NeuralConnexions personalization, plus full data export and account deletion controls.",
      },
      { property: "og:title", content: "Privacy — NeuralConnexions" },
      { property: "og:description", content: "Privacy invariants for NeuralConnexions personalization, plus full data export and account deletion controls." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

/**
 * Verbatim from docs/06 §10 — Privacy Invariants. Updating these copies
 * means updating the spec first; this page is the user-facing source of
 * truth.
 */
const INVARIANTS: Array<{ n: number; title: string; body: string }> = [
  {
    n: 1,
    title: "Your raw memory never leaves your device for personalization.",
    body: "We derive a small structured trait sheet from memory locally. The provider only ever sees the sheet — and only the slice the broker decides is relevant to the current question.",
  },
  {
    n: 2,
    title: "Identifiers are banned by schema.",
    body: "Names, emails, phone numbers, employer, salary, exact age and government IDs are forbidden from the trait sheet at the schema level. The Zod validator refuses any extraction patch that contains them.",
  },
  {
    n: 3,
    title: "The broker assembles JSON-only fragments — never free text.",
    body: "The system-prompt fragment is always a single USER_CONTEXT JSON object. It cannot contain free prose pulled from your memory.",
  },
  {
    n: 4,
    title: "Privacy tiers gate what categories any provider can see.",
    body: "Each provider has a privacy tier (0 on-device → 3 closed third-party). Sensitive categories (household, wellness, transient) have minimum tiers. The strictest tier in your selected chain wins.",
  },
  {
    n: 5,
    title: "The Private badge is fail-closed.",
    body: "When you pick the Private badge, the chat runs entirely on this device — your question, the answer and any picture never reach our servers. There is no silent fallback to a cloud provider — if the on-device model can't serve, you see an error, not a leak.",
  },
  {
    n: 6,
    title: "Every assembled fragment is scrubbed by a hard floor of regex patterns.",
    body: "Even after schema and tier filtering, we run a final regex scrub for emails, phone numbers, postal addresses, credit cards, gov IDs, exact ages, employer phrases, and your own known-names list. Any hit drops the entire fragment.",
  },
  {
    n: 7,
    title: "Every personalization decision is logged to your account.",
    body: "Each chat message records which categories were used, the strictest tier in the chain, and whether scrubbing fired. You can see and forget any of it from Settings → Personalization.",
  },
];

function PrivacyPage() {
  const { user } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [showDisclosure, setShowDisclosure] = useState(false);

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setStatus(null);
    try {
      const result = await exportAccountData();
      const blob = new Blob([result.json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
      setStatus(`Exported ${total} rows across ${Object.keys(result.counts).length} tables.`);
    } catch (e) {
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    if (deleting) return;
    if (confirmText !== "DELETE") {
      setStatus("Type DELETE in the box to confirm.");
      return;
    }
    setDeleting(true);
    setStatus(null);
    try {
      const result = await deleteAccount();
      const wiped = Object.entries(result.perTable)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}=${n}`)
        .join(", ");
      const revokeNote = result.googleRevokeFailed
        ? " We couldn't cancel Google access from here — please remove NeuralConnexions at https://myaccount.google.com/permissions."
        : "";
      setStatus(
        `Your account, everything stored with it and every stored photo have been deleted. Wiped: ${wiped || "no rows present"}.${revokeNote} Signing you out…`,
      );
      setConfirmText("");
      // The sign-in no longer exists — end this browser's session too.
      await supabase.auth.signOut();
    } catch (e) {
      setStatus(`Delete failed: ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      {showDisclosure && (
        <PersonalizationDisclosure
          force
          userId={user?.id ?? null}
          onDismiss={() => setShowDisclosure(false)}
        />
      )}
      <header className="mb-8">
        <p className="text-sm uppercase tracking-wider text-muted-foreground">Settings</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Privacy</h1>
        <p className="mt-2 text-muted-foreground">
          The seven privacy invariants below are guaranteed by the system, not promised by policy.
          See also{" "}
          <Link to="/workspace/personalization" className="underline underline-offset-4">
            Personalization
          </Link>{" "}
          for category-level controls.
        </p>
      </header>

      <CloudFeaturesSection />

      <section className="mb-12 rounded-xl border bg-card/40 p-6">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-500" />
          <h2 className="text-xl font-semibold">Privacy invariants</h2>
          <button
            type="button"
            onClick={() => setShowDisclosure(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
          >
            <RefreshCw className="h-3 w-3" />
            Show first-run disclosure
          </button>
        </div>
        <ol className="space-y-5">
          {INVARIANTS.map((inv) => (
            <li key={inv.n} className="border-l-2 border-emerald-500/40 pl-4">
              <div className="text-sm font-mono text-muted-foreground">§{inv.n}</div>
              <div className="font-medium">{inv.title}</div>
              <p className="mt-1 text-sm text-muted-foreground">{inv.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <ConnectMacSection />

      <section className="mb-8 rounded-xl border bg-card/40 p-6">
        <h2 className="mb-2 text-xl font-semibold">Export your data</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Downloads a single JSON file containing your trait sheet, memory graph, chat history,
          provider blocks, scrub events, and known-names list. Nothing is sent off-device.
        </p>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || !user}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-60"
        >
          {exporting ? <Loader className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {exporting ? "Preparing export…" : "Download my data (JSON)"}
        </button>
      </section>

      <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-6">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          <h2 className="text-xl font-semibold">Delete your account</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          This deletes your account and everything stored with it: your sign-in, trait sheet,
          memory graph, chat history, drafts, connections, voice profile, research, settings,
          and every stored photo and file. Where possible we also cancel NeuralConnexions'
          access to your Google account; if that can't be completed from here, remove it at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            myaccount.google.com/permissions
          </a>
          . Nothing can be recovered afterwards.
        </p>
        <label className="mb-3 block text-sm font-medium">
          Type <span className="font-mono">DELETE</span> to confirm:
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="mt-2 block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
            placeholder="DELETE"
          />
        </label>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting || confirmText !== "DELETE" || !user}
          className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-60"
        >
          {deleting ? <Loader className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {deleting ? "Deleting…" : "Permanently delete my data"}
        </button>
      </section>

      {status && (
        <div className="mt-6 rounded-md border bg-card/60 px-4 py-3 text-sm">{status}</div>
      )}
    </div>
  );
}
