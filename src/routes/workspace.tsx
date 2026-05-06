import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import MainApp from "@/components/workspace/MainApp";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/workspace")({
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
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  return <MainApp />;
}
