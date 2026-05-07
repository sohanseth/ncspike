import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Inbox,
  Calendar,
  CheckCircle2,
  PenLine,
  Brain,
  Settings,
  LogOut,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";

const nav = [
  { to: "/workspace", label: "Today", icon: LayoutDashboard },
  { to: "/workspace/chat", label: "Chat", icon: MessageSquare },
  { to: "/workspace/inbox", label: "Inbox", icon: Inbox },
  { to: "/workspace/drafts", label: "Drafts", icon: Sparkles },
  { to: "/workspace/calendar", label: "Calendar", icon: Calendar },
  { to: "/workspace/compose", label: "Composer", icon: PenLine },
  { to: "/workspace/followups", label: "Follow-ups", icon: CheckCircle2 },
  { to: "/workspace/memory", label: "Memory", icon: Brain },
] as const;

export function Sidebar() {
  const { pathname } = useLocation();
  const { signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <aside className="hidden lg:flex w-64 shrink-0 flex-col bg-sidebar border-r border-sidebar-border backdrop-blur-2xl">
      <div className="flex h-16 items-center gap-2.5 px-5 border-b border-sidebar-border">
        <div className="size-8 rounded-xl bg-gradient-to-br from-primary to-primary-glow flex items-center justify-center ring-1 ring-white/10 shadow-[0_4px_20px_-4px_var(--primary)]">
          <span className="font-display font-bold text-sm text-primary-foreground">N</span>
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight font-display">NeuralConnexions</p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-mono">
            cognitive · ambient
          </p>
        </div>
      </div>

      <nav className="flex-1 px-3 py-5 space-y-0.5">
        {nav.map((item) => {
          const active =
            item.to === "/workspace"
              ? pathname === "/workspace"
              : pathname.startsWith(item.to);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={[
                "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
                active
                  ? "bg-gradient-to-r from-primary/15 to-primary/5 text-foreground ring-1 ring-primary/25"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              ].join(" ")}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-gradient-to-b from-primary to-primary-glow" />
              )}
              <Icon className={`size-4 ${active ? "text-primary" : ""}`} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 pb-3 space-y-2">
        <div className="rounded-xl glass p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex size-1.5">
              <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" />
              <span className="relative size-1.5 rounded-full bg-success" />
            </span>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider font-mono">
              Sources online
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            {["Gmail", "Calendar", "Docs", "Slack"].map((a) => (
              <span
                key={a}
                className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/5 text-muted-foreground ring-1 ring-white/5"
              >
                {a}
              </span>
            ))}
          </div>
        </div>
        <Link
          to="/workspace"
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
        >
          <Settings className="size-4" />
          Settings
        </Link>
        <button
          onClick={async () => { await signOut(); navigate({ to: "/auth" }); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-white/5 hover:text-foreground transition-colors"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
