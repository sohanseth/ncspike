import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { SectionHeader } from "@/components/workspace/SectionHeader";

export const Route = createFileRoute("/workspace/calendar")({
  head: () => ({
    meta: [
      { title: "Calendar — Operand" },
      { name: "description", content: "Calendar-aware day plan and scheduling." },
    ],
  }),
  component: CalendarPage,
});

const hours = Array.from({ length: 10 }, (_, i) => 8 + i);

const events = [
  { start: 9.5, end: 11, title: "Deep work — Alpha brief", kind: "focus" },
  { start: 11, end: 12, title: "Q3 strategy w/ Mark & Priya", kind: "meeting" },
  { start: 13, end: 14, title: "Lunch", kind: "break" },
  { start: 14, end: 15, title: "Pricing review w/ Sarah", kind: "meeting" },
  { start: 15.5, end: 17, title: "Suggested: focus block", kind: "suggested" },
];

const tones: Record<string, string> = {
  focus: "bg-primary/10 border-primary/30 text-primary",
  meeting: "bg-accent/10 border-accent/30 text-accent",
  break: "bg-muted border-border text-muted-foreground",
  suggested:
    "bg-warning/10 border-warning/40 text-warning-foreground border-dashed",
};

function CalendarPage() {
  return (
    <>
      <Topbar title="Calendar" subtitle="Plan-aware schedule · drag to reschedule" />
      <div className="flex-1 px-6 lg:px-8 py-8 max-w-5xl w-full mx-auto">
        <SectionHeader
          eyebrow="Plan my day"
          title="Today's timeline"
          description="Operand grouped focus around your meetings and suggested a block for an open promise."
        />

        <div className="rounded-xl bg-surface ring-1 ring-border shadow-soft overflow-hidden">
          <div className="grid grid-cols-[64px_1fr]">
            <div className="border-r border-border">
              {hours.map((h) => (
                <div
                  key={h}
                  className="h-16 px-3 text-[11px] text-muted-foreground font-mono pt-1"
                >
                  {h}:00
                </div>
              ))}
            </div>
            <div className="relative">
              {hours.map((h) => (
                <div key={h} className="h-16 border-b border-border last:border-b-0" />
              ))}
              {events.map((e, i) => {
                const top = (e.start - 8) * 64;
                const height = (e.end - e.start) * 64 - 4;
                return (
                  <div
                    key={i}
                    className={`absolute left-3 right-3 rounded-lg border px-3 py-2 text-xs ${tones[e.kind]}`}
                    style={{ top, height }}
                  >
                    <p className="font-semibold">{e.title}</p>
                    <p className="opacity-80 mt-0.5 text-[11px]">
                      {fmt(e.start)} – {fmt(e.end)}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-xl bg-surface ring-1 ring-border p-4 text-sm flex items-start gap-3">
          <div className="size-7 rounded-full bg-warning/15 text-warning-foreground flex items-center justify-center text-xs font-semibold">
            !
          </div>
          <div className="flex-1">
            <p className="font-medium">Suggested reschedule</p>
            <p className="text-muted-foreground text-pretty mt-0.5">
              Your 2 PM with Sarah overlaps with a deep work block. Move focus to
              3:30 PM (90 min still free)?
            </p>
          </div>
          <div className="flex gap-2">
            <button className="px-3 py-1.5 rounded-md text-xs ring-1 ring-border hover:bg-secondary">
              Skip
            </button>
            <button className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90">
              Apply
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function fmt(h: number) {
  const hr = Math.floor(h);
  const m = (h - hr) * 60;
  const period = hr >= 12 ? "PM" : "AM";
  const hh = ((hr + 11) % 12) + 1;
  return `${hh}:${m === 0 ? "00" : m} ${period}`;
}
