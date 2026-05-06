import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Set new password — NeuralConnexions" },
      { name: "description", content: "Set a new password for your NeuralConnexions account." },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      // Handle PKCE recovery: exchange ?code=... for a session
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!cancelled) {
          if (error) setError(error.message);
          // Clean the URL
          window.history.replaceState({}, "", "/reset-password");
        }
      }
      const { data } = await supabase.auth.getSession();
      if (!cancelled && data.session) setReady(true);
    };
    check();
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        throw new Error("Recovery session expired. Please request a new reset link.");
      }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      setTimeout(() => navigate({ to: "/workspace" }), 1200);
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

        <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Choose a strong password (at least 8 characters).
        </p>

        {done ? (
          <div className="mt-6 rounded-md ring-1 ring-border bg-surface px-4 py-4 text-sm">
            Password updated. Redirecting to your workspace…
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3 mt-6">
            <input
              type="password"
              required
              minLength={8}
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md ring-1 ring-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {!ready && (
              <p className="text-xs text-muted-foreground">
                Waiting for recovery link… open this page from the email we sent.
              </p>
            )}
            {error && (
              <p className="text-xs text-destructive bg-destructive/10 ring-1 ring-destructive/20 rounded px-3 py-2">
                {error}
              </p>
            )}
            <button
              disabled={busy || !ready}
              className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? "Updating…" : "Update password"}
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
