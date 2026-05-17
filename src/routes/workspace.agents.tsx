import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Archive, Loader, Pause, Play, Plus, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  archiveAgent,
  createResearchDigestAgent,
  listAgents,
  pauseAgent,
  resumeAgent,
  type AgentListItem,
  type CreatedAgentSummary,
} from "@/lib/agents.functions";

export const Route = createFileRoute("/workspace/agents")({
  component: AgentsPage,
  head: () => ({
    meta: [
      { title: "Agents — NeuralConnexions" },
      {
        name: "description",
        content:
          "Create and manage research-digest agents that pull articles on your topics on a daily cadence.",
      },
    ],
  }),
});

const MAX_TOPICS = 5;
const MAX_NAME_LEN = 80;
const MAX_TOPIC_LEN = 120;

/**
 * Format an ISO timestamp for the list view. Returns "never" for null
 * (a freshly created agent that the cron hasn't picked up yet).
 *
 * Kept inline + dependency-free; the date-fns / Intl polish can come
 * with the run-history PR when we'll want richer relative-time formatting.
 */
function formatTs(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function stateBadgeClass(state: string): string {
  // Color hints match the runtime semantics: active = good, paused =
  // user-chosen pause, degraded/error/needs_user_attention = warning.
  switch (state) {
    case "active":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    case "paused":
      return "border-amber-500/40 bg-amber-500/10 text-amber-200";
    case "degraded":
    case "needs_user_attention":
      return "border-yellow-500/40 bg-yellow-500/10 text-yellow-200";
    case "error":
      return "border-destructive/40 bg-destructive/10 text-destructive-foreground";
    case "inactive":
    case "draft":
    default:
      return "border-muted/40 bg-muted/10 text-muted-foreground";
  }
}

function AgentsPage() {
  // Auth gate — matches workspace.connections.tsx. Server fn is also
  // gated by requireSupabaseAuth middleware (the authoritative check);
  // this redirect + render gate is the UX layer so an unauthed visitor
  // doesn't see a form that would silently fail on submit, AND so
  // the form doesn't flash for a frame between auth-context settling
  // and the redirect firing.
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  // ─── List state ──────────────────────────────────────────────────────
  // null = first-load in flight; [] = empty list; [...] = populated.
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const refreshAgents = useCallback(async () => {
    setListError(null);
    try {
      const rows = await listAgents();
      setAgents(rows);
    } catch (err) {
      setListError((err as Error).message ?? "Failed to load agents");
      setAgents([]);
    }
  }, []);

  useEffect(() => {
    if (!loading && user) void refreshAgents();
  }, [loading, user, refreshAgents]);

  async function onPause(agentId: string) {
    setMutatingId(agentId);
    try {
      await pauseAgent({ data: { agentId } });
      await refreshAgents();
    } catch (err) {
      setListError((err as Error).message ?? "Pause failed");
    } finally {
      setMutatingId(null);
    }
  }

  async function onResume(agentId: string) {
    setMutatingId(agentId);
    try {
      await resumeAgent({ data: { agentId } });
      await refreshAgents();
    } catch (err) {
      setListError((err as Error).message ?? "Resume failed");
    } finally {
      setMutatingId(null);
    }
  }

  async function onArchive(agentId: string) {
    setMutatingId(agentId);
    try {
      const result = await archiveAgent({ data: { agentId } });
      // `affected: false` on archive means the row didn't match — either
      // already archived, owned by another user, OR currently mid-run
      // (the server's lease guard refuses archive while a runner holds
      // the row's lease). Surface a useful hint rather than silently
      // letting the row reappear in the refetch.
      if (!result.affected) {
        setListError(
          "Archive didn't apply. The agent may be running right now — try again in a few minutes.",
        );
      }
      await refreshAgents();
    } catch (err) {
      setListError((err as Error).message ?? "Archive failed");
    } finally {
      setMutatingId(null);
    }
  }

  // ─── Create-form state ───────────────────────────────────────────────
  const [name, setName] = useState("");
  const [topicDraft, setTopicDraft] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "ok"; agent: CreatedAgentSummary }
    | { kind: "error"; message: string }
    | null
  >(null);

  function addTopic() {
    const trimmed = topicDraft.trim();
    if (!trimmed) return;
    if (topics.length >= MAX_TOPICS) return;
    if (topics.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      setTopicDraft("");
      return;
    }
    setTopics([...topics, trimmed.slice(0, MAX_TOPIC_LEN)]);
    setTopicDraft("");
  }

  function removeTopic(t: string) {
    setTopics(topics.filter((x) => x !== t));
  }

  function onTopicKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTopic();
    }
  }

  const trimmedName = name.trim();
  const canSubmit =
    !submitting && trimmedName.length > 0 && topics.length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setStatus(null);
    try {
      const agent = await createResearchDigestAgent({
        data: { display_name: trimmedName, topics },
      });
      setStatus({ kind: "ok", agent });
      setName("");
      setTopics([]);
      setTopicDraft("");
      // Newly created row appears in the list on refetch.
      await refreshAgents();
    } catch (err) {
      setStatus({
        kind: "error",
        message: (err as Error).message ?? "Create failed",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // Hold render until auth context settles. Without this, an unauth'd
  // visitor sees the form for a frame before the redirect effect fires;
  // an auth'd visitor sees the form referencing `user` before it's set.
  // Matches the gate in workspace.connections.tsx.
  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-wider text-muted-foreground">
          Workspace
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-2 text-muted-foreground">
          Manage your research-digest agents. They pull relevant articles on
          your topics on a daily cadence and drop findings into your inbox.
        </p>
      </header>

      {/* ─── Your agents (list) ─────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-medium">Your agents</h2>
        {listError && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            {listError}
          </div>
        )}
        {agents === null ? (
          <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground">
            Loading agents…
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground">
            No agents yet. Create one below.
          </div>
        ) : (
          <ul className="space-y-3">
            {agents.map((a) => {
              const busy = mutatingId === a.id;
              const canPause = a.state === "active";
              const canResume = a.state === "paused";
              const canArchive = a.state !== "archived"; // server enforces too
              return (
                <li
                  key={a.id}
                  className="rounded-xl border bg-card/40 p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{a.display_name}</span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${stateBadgeClass(a.state)}`}
                      >
                        {a.state}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.template_id} · every {a.cadence_hours}h · last run{" "}
                      {formatTs(a.last_completed_at)} · created{" "}
                      {formatTs(a.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canPause && (
                      <button
                        type="button"
                        onClick={() => onPause(a.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        <Pause className="h-3.5 w-3.5" />
                        Pause
                      </button>
                    )}
                    {canResume && (
                      <button
                        type="button"
                        onClick={() => onResume(a.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Resume
                      </button>
                    )}
                    {canArchive && (
                      <button
                        type="button"
                        onClick={() => onArchive(a.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                      >
                        <Archive className="h-3.5 w-3.5" />
                        Archive
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ─── Create new agent ──────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-lg font-medium">Create a new agent</h2>
        <form
          onSubmit={onSubmit}
          className="rounded-xl border bg-card/40 p-6 space-y-6"
        >
          <div className="space-y-2">
            <label htmlFor="agent-name" className="block text-sm font-medium">
              Agent name
            </label>
            <input
              id="agent-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LEN))}
              placeholder="e.g. AI research digest"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              maxLength={MAX_NAME_LEN}
              required
            />
            <p className="text-xs text-muted-foreground">
              A label you'll recognize later. {trimmedName.length}/{MAX_NAME_LEN}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="agent-topic" className="block text-sm font-medium">
              Topics
            </label>
            <div className="flex gap-2">
              <input
                id="agent-topic"
                type="text"
                value={topicDraft}
                onChange={(e) => setTopicDraft(e.target.value.slice(0, MAX_TOPIC_LEN))}
                onKeyDown={onTopicKeyDown}
                placeholder="e.g. open-source LLMs"
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                maxLength={MAX_TOPIC_LEN}
                disabled={topics.length >= MAX_TOPICS}
              />
              <button
                type="button"
                onClick={addTopic}
                disabled={!topicDraft.trim() || topics.length >= MAX_TOPICS}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
            {topics.length > 0 && (
              <ul className="flex flex-wrap gap-2 pt-1">
                {topics.map((t) => (
                  <li
                    key={t}
                    className="inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1 text-sm"
                  >
                    <span>{t}</span>
                    <button
                      type="button"
                      onClick={() => removeTopic(t)}
                      aria-label={`Remove ${t}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Press Enter or comma to add. {topics.length}/{MAX_TOPICS} topics.
            </p>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader className="h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Create agent"
            )}
          </button>

          {status?.kind === "ok" && (
            <div
              role="status"
              className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
            >
              Created <strong>{status.agent.display_name}</strong>. It'll run on
              the next cron tick (within ~30 minutes).
            </div>
          )}
          {status?.kind === "error" && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
            >
              {status.message}
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
