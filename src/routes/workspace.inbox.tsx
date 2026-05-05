import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { ApprovalCard } from "@/components/workspace/ApprovalCard";
import { SectionHeader } from "@/components/workspace/SectionHeader";

export const Route = createFileRoute("/workspace/inbox")({
  head: () => ({
    meta: [
      { title: "Reply Zero — Operand" },
      { name: "description", content: "Triage your inbox with reviewable AI drafts." },
    ],
  }),
  component: InboxPage,
});

const drafts = [
  {
    badge: "High priority",
    tone: "accent" as const,
    from: "Sarah Chen",
    meta: "Gmail · 8:42 AM",
    context: `"Checking in on the pricing proposal — can we review it before the 2 PM call?"`,
    draft: `Hi Sarah,\n\nFinished the latest draft — attaching it now. Free at 1:30 PM to walk through it before the call.\n\n— Jamie`,
    sources: [
      { label: "Pricing v3 (Docs)", kind: "doc" as const },
      { label: "2 PM call", kind: "calendar" as const },
    ],
  },
  {
    badge: "Follow-up",
    tone: "default" as const,
    from: "Marcus Lee",
    meta: "Gmail · yesterday",
    context: `You promised to send the onboarding pack by EOD.`,
    draft: `Hey Marcus,\n\nSending the onboarding pack now — let me know once you've had a look and I'll set up time to walk through it.\n\n— Jamie`,
    sources: [{ label: "Onboarding v2 (Docs)", kind: "doc" as const }],
  },
  {
    badge: "Quick reply",
    tone: "default" as const,
    from: "Priya Patel",
    meta: "Gmail · 7:15 AM",
    context: `"Can you join Friday's design crit at 3 PM?"`,
    draft: `Hi Priya,\n\nYes — Friday at 3 PM works. I'll bring the latest mocks.\n\n— Jamie`,
    sources: [{ label: "Friday calendar", kind: "calendar" as const }],
  },
  {
    badge: "Newsletter",
    tone: "default" as const,
    from: "Stripe Updates",
    meta: "Gmail · Mon",
    context: `Product newsletter — no reply needed. Operand recommends archiving.`,
    draft: `Archive without replying. Summary: new Connect features for marketplaces.`,
    sources: [],
    primaryLabel: "Archive",
  },
];

function InboxPage() {
  return (
    <>
      <Topbar title="Reply Zero" subtitle="4 drafts ready · 0 sent today" />
      <div className="flex-1 px-6 lg:px-8 py-8 max-w-3xl w-full mx-auto">
        <SectionHeader
          eyebrow="Workflow"
          title="Triage in one pass"
          description="Each card shows what Operand read, what it plans to send, and where it goes."
        />
        <div className="space-y-4">
          {drafts.map((d, i) => (
            <ApprovalCard
              key={i}
              badge={d.badge}
              badgeTone={d.tone}
              from={d.from}
              fromMeta={d.meta}
              context={d.context}
              draft={d.draft}
              sources={d.sources}
              primaryLabel={d.primaryLabel}
            />
          ))}
        </div>
      </div>
    </>
  );
}
