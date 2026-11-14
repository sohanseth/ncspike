import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import MainApp from "@/components/workspace/MainApp";
import { WorkspaceLocalNav } from "@/components/workspace/WorkspaceLocalNav";
import { MacWorthKnowing } from "@/components/workspace/MacWorthKnowing";
import { MacLists } from "@/components/workspace/MacLists";
import { PrivateDefaultNotice } from "@/components/workspace/PrivateDefaultNotice";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/workspace/")({
  head: () => ({ meta: [
    { title: "Your workspace — NeuralConnexions" },
    { name: "description", content: "Your personal NeuralConnexions workspace for tasks, communication, and daily priorities." },
    { property: "og:title", content: "Your workspace — NeuralConnexions" },
    { property: "og:description", content: "Your personal NeuralConnexions workspace for tasks, communication, and daily priorities." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  // Nav strip above MainApp so Agents / Inbox are reachable from the
  // workspace home — addresses the dead-end Sneha hit during verification.
  // `px-4 pt-4` matches the inner padding the other workspace pages use
  // so the nav doesn't visually clash with MainApp's own layout below.
  return (
    <>
      <div className="px-4 pt-4">
        <WorkspaceLocalNav />
      </div>
      <PrivateDefaultNotice />
      <MacWorthKnowing />
      <MacLists />
      <MainApp />
    </>
  );
}
