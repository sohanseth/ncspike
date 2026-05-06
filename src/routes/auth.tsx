import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — NeuralConnexions" },
      { name: "description", content: "Sign in to your NeuralConnexions cognitive workspace." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) navigate({ to: "/workspace" });
  }, [user, loading, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/workspace`,
            data: { name },
          },
        });
        if (error) throw error;
        navigate({ to: "/workspace" });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/workspace" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async () => {
    setError(null);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: `${window.location.origin}/workspace`,
      });
      if (result.error) {
        setError("Google sign-in failed. Please try again.");
        return;
      }
      if (result.redirected) return;
      navigate({ to: "/workspace" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
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

        <h1 className="text-2xl font-semibold tracking-tight">
          {mode === "signin" ? "Welcome back" : "Create your workspace"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {mode === "signin"
            ? "Pick up where your assistant left off."
            : "Your private cognitive companion. Your data, your control."}
        </p>

        <button
          onClick={onGoogle}
          className="mt-6 w-full flex items-center justify-center gap-2 rounded-md ring-1 ring-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-secondary"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
          </svg>
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          {mode === "signup" && (
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md ring-1 ring-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          )}
          <input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md ring-1 ring-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Password (min 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
          {mode === "signin" && (
            <div className="text-right">
              <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-primary hover:underline">
                Forgot password?
              </Link>
            </div>
          )}
        </form>

        <p className="mt-5 text-xs text-center text-muted-foreground">
          {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="text-primary font-medium hover:underline"
          >
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>

        <p className="mt-8 text-[11px] text-center text-muted-foreground">
          By continuing you agree to our terms. We never sell your data.
        </p>
      </div>
    </div>
  );
}
