import { Link, useLocation } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Inbox,
  Calendar,
  CheckCircle2,
  PenLine,
  Brain,
  Settings,
  Sparkles,
} from "lucide-react";

const nav = [
  { to: "/workspace", label: "Today", icon: LayoutDashboard },
  { to: "/workspace/inbox", label: "Reply Zero", icon: Inbox },
  { to: "/workspace/calendar", label: "Calendar", icon: Calendar },
  { to: "/workspace/followups", label: "Follow-ups", icon: CheckCircle2 },
  { to: "/workspace/compose", label: "Composer", icon: PenLine },
  { to: "/workspace/memory", label: "Memory", icon: Brain },
] as const;

export function Sidebar() {
  const { pathname } = useLocation();

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="flex h-16 items-center gap-2 px-5 border-b border-sidebar-border">
        <div className="size-7 rounded-lg bg-primary flex items-center justify-center">
          <Sparkles className="size-4 text-primary-foreground" />
        </div>
        <span className="text-sm font-semibold tracking-tight">NeuralConnexions</span>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Beta
        </span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
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
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              ].join(" ")}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 pb-3">
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="size-1.5 rounded-full bg-success" />
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              Connected
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["Gmail", "Calendar", "Docs", "Slack"].map((a) => (
              <span
                key={a}
                className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground"
              >
                {a}
              </span>
            ))}
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-warning/20 text-warning-foreground ring-1 ring-warning/30">
              WhatsApp · soon
            </span>
          </div>
        </div>
        <Link
          to="/workspace"
          className="mt-2 flex items-center gap-2 px-2.5 py-2 rounded-md text-sm text-muted-foreground hover:bg-secondary/60"
        >
          <Settings className="size-4" />
          Settings
        </Link>
      </div>
    </aside>
  );
}
