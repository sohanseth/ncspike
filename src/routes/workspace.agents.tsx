import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Loader, Plus, X } from "lucide-react";
import {
  createResearchDigestAgent,
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
          "Create research-digest agents that pull articles on your topics on a daily cadence.",
      },
    ],
  }),
});

const MAX_TOPICS = 5;
const MAX_NAME_LEN = 80;
const MAX_TOPIC_LEN = 120;

function AgentsPage() {
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
    } catch (err) {
      setStatus({
        kind: "error",
        message: (err as Error).message ?? "Create failed",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-wider text-muted-foreground">
          Workspace
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-2 text-muted-foreground">
          Create a research-digest agent. It pulls relevant articles on your
          topics once a day and drops the findings into your inbox.
        </p>
      </header>

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
    </div>
  );
}
