import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Inbox,
  Calendar,
  CheckCircle2,
  PenLine,
  Brain,
  LogOut,
  MessageSquare,
  Sparkles,
  Moon,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";

const nav = [
  { to: "/workspace", label: "Today", icon: LayoutDashboard },
  { to: "/workspace/inbox", label: "Inbox", icon: Inbox },
  { to: "/workspace/drafts", label: "Drafts", icon: Sparkles },
  { to: "/workspace/brief", label: "Evening brief", icon: Moon },
] as const;

export function IconRail() {
  const { pathname } = useLocation();
  const { signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <aside className="hidden md:flex w-16 shrink-0 flex-col items-center bg-sidebar border-r border-sidebar-border backdrop-blur-2xl py-4">
      <Link to="/workspace" className="size-10 rounded-xl bg-gradient-to-br from-primary to-primary-glow flex items-center justify-center ring-1 ring-white/10 shadow-[0_4px_20px_-4px_var(--primary)] mb-6">
        <span className="font-display font-bold text-sm text-primary-foreground">N</span>
      </Link>

      <nav className="flex-1 flex flex-col items-center gap-1.5">
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
              title={item.label}
              className={[
                "group relative size-10 rounded-xl inline-flex items-center justify-center transition-all",
                active
                  ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              ].join(" ")}
            >
              {active && (
                <span className="absolute -left-2 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-gradient-to-b from-primary to-primary-glow" />
              )}
              <Icon className="size-[18px]" />
              <span className="absolute left-full ml-3 px-2 py-1 rounded-md text-[11px] font-medium bg-popover text-foreground ring-1 ring-border opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <button
        onClick={async () => { await signOut(); navigate({ to: "/auth" }); }}
        title="Sign out"
        className="size-10 rounded-xl text-muted-foreground hover:bg-white/5 hover:text-foreground inline-flex items-center justify-center transition-colors"
      >
        <LogOut className="size-[18px]" />
      </button>
    </aside>
  );
}
