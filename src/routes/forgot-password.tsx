import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Reset password — NeuralConnexions" },
      { name: "description", content: "Reset your NeuralConnexions password." },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        <Link to="/" className="flex items-center gap-2 mb-8">
          <div className="size-8 rounded-xl bg-primary flex items-center justify-center">
            <Sparkles className="size-4 text-primary-foreground" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight">NeuralConnexions</p>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Find · Nurture · Sustain
            </p>
          </div>
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enter your email and we'll send you a link to set a new password.
        </p>

        {sent ? (
          <div className="mt-6 rounded-md ring-1 ring-border bg-surface px-4 py-4 text-sm">
            Check <span className="font-medium">{email}</span> for a reset link. It may take a minute to arrive.
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3 mt-6">
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md ring-1 ring-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {error && (
              <p className="text-xs text-destructive bg-destructive/10 ring-1 ring-destructive/20 rounded px-3 py-2">
                {error}
              </p>
            )}
            <button
              disabled={busy}
              className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        <p className="mt-5 text-xs text-center text-muted-foreground">
          <Link to="/auth" className="text-primary font-medium hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
