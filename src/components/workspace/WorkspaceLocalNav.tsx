import { Link } from "@tanstack/react-router";

/**
 * Small inline nav rendered at the top of every workspace product-surface
 * page (Agents, Inbox, future siblings). The standalone routes don't share
 * a layout, and the existing `src/components/workspace/Sidebar.tsx` /
 * `IconRail.tsx` aren't wired into them either — so this component is the
 * minimal-diff way to close the discoverability gap surfaced during the
 * post-#14 local verification ("how do I go back to workspace?").
 *
 * Scope on purpose:
 *   - Workspace home link (the bit that used to be a non-clickable
 *     "Workspace" breadcrumb label)
 *   - Two siblings — Agents + Inbox
 *
 * No icons, no badges, no active-state styling beyond a simple underline.
 * The full sidebar/IconRail rewire belongs in a separate UX pass; this
 * one is plain text so it's obvious and short.
 */

const ITEMS: Array<{ to: "/workspace" | "/workspace/agents" | "/workspace/inbox"; label: string }> = [
  { to: "/workspace", label: "Workspace" },
  { to: "/workspace/agents", label: "Agents" },
  { to: "/workspace/inbox", label: "Inbox" },
];

export function WorkspaceLocalNav() {
  return (
    <nav className="mb-6 flex items-center gap-4 text-sm text-muted-foreground">
      {ITEMS.map((item, i) => (
        <span key={item.to} className="inline-flex items-center gap-4">
          {i > 0 && <span aria-hidden="true">·</span>}
          <Link
            to={item.to}
            className="hover:text-foreground hover:underline underline-offset-4"
            activeProps={{ className: "text-foreground font-medium" }}
            activeOptions={{ exact: true }}
          >
            {item.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
