import { Search, Command, LogOut } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";

export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/auth" });
  };

  return (
    <header className="h-16 shrink-0 sticky top-0 z-30 border-b border-border bg-background/40 backdrop-blur-xl">
      <div className="h-full px-6 lg:px-8 flex items-center gap-6">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight font-display truncate">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2 px-3 h-9 rounded-lg glass text-sm text-muted-foreground w-72">
            <Search className="size-4" />
            <span className="flex-1">Ask anything…</span>
            <kbd className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white/5 ring-1 ring-white/10 inline-flex items-center gap-1 font-mono">
              <Command className="size-3" />K
            </kbd>
          </div>
          <button
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
            className="size-9 rounded-lg inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/5 ring-1 ring-white/10 transition-colors"
          >
            <LogOut className="size-4" />
          </button>
          <div className="size-9 rounded-full bg-gradient-to-br from-primary to-primary-glow ring-1 ring-white/10 overflow-hidden">
            <img
              src={`https://i.pravatar.cc/64?u=jamie`}
              alt="You"
              className="size-full object-cover mix-blend-luminosity opacity-90"
            />
          </div>
        </div>
      </div>
    </header>
  );
}
