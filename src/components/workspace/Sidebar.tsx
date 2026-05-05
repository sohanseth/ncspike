import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Inbox,
  Calendar,
  CheckCircle2,
  PenLine,
  Brain,
  Settings,
  Sparkles,
  LogOut,
  MessageSquare,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";

const nav = [
  { to: "/workspace", label: "Today", icon: LayoutDashboard },
  { to: "/workspace/chat", label: "Chat", icon: MessageSquare },
  { to: "/workspace/inbox", label: "Inbox", icon: Inbox },
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
    <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-16 items-center gap-2.5 px-5 border-b border-sidebar-border">
        <div className="size-8 rounded-xl bg-primary flex items-center justify-center shadow-soft">
          <Sparkles className="size-4 text-primary-foreground" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight">NeuralConnexions</p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Find · Nurture · Sustain
          </p>
        </div>
      </div>

      <nav className="flex-1 px-3 py-5 space-y-1">
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
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              ].join(" ")}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 pb-3 space-y-2">
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="size-1.5 rounded-full bg-success" />
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Connected
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["Gmail", "Calendar", "Docs", "Slack", "WhatsApp"].map((a) => (
              <span
                key={a}
                className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground"
              >
                {a}
              </span>
            ))}
          </div>
        </div>
        <Link
          to="/workspace"
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <Settings className="size-4" />
          Settings
        </Link>
        <button
          onClick={async () => { await signOut(); navigate({ to: "/auth" }); }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
