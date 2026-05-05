import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { useMemo, useState } from "react";
import { Sparkles, Clock, Users, FileText, ChevronLeft, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/workspace/calendar")({
  head: () => ({
    meta: [
      { title: "Calendar — NeuralConnexions" },
      { name: "description", content: "Your schedule and meeting prep." },
    ],
  }),
  component: CalendarPage,
});

type EventKind = "meeting" | "focus" | "break";
type Event = {
  id: string;
  day: number; // 0-6 in current week
  title: string;
  start: string;
  end: string;
  kind: EventKind;
  attendees?: string[];
  prep?: string[];
  notes?: string;
};

const today = new Date();
const todayDay = today.getDay() === 0 ? 6 : today.getDay() - 1; // Mon=0

const weekStart = new Date(today);
weekStart.setDate(today.getDate() - todayDay);

const days = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(weekStart);
  d.setDate(weekStart.getDate() + i);
  return d;
});

const events: Event[] = [
  {
    id: "standup",
    day: todayDay,
    title: "Team Standup",
    start: "10:00 AM",
    end: "10:15 AM",
    kind: "meeting",
    attendees: ["Jamie", "Priya", "Tom"],
    prep: ["Yesterday's blockers", "Today's top 3"],
    notes: "Share the partnership update at the top — Sarah's terms came in last night.",
  },
  {
    id: "focus",
    day: todayDay,
    title: "Focus Time — Partnership Proposal Review",
    start: "11:00 AM",
    end: "12:30 PM",
    kind: "focus",
    prep: ["Partnership v3 (Docs)", "Pricing comparison"],
    notes: "Deep work block. Notifications muted automatically.",
  },
  {
    id: "marcus",
    day: todayDay,
    title: "1:1 with Marcus",
    start: "2:00 PM",
    end: "2:30 PM",
    kind: "meeting",
    attendees: ["Marcus", "Jamie"],
    prep: ["Career growth notes", "Q2 deliverables"],
    notes: "Marcus wanted to discuss promotion criteria — pull last 1:1 notes.",
  },
  {
    id: "wed-design",
    day: 2,
    title: "Design review",
    start: "3:00 PM",
    end: "4:00 PM",
    kind: "meeting",
    attendees: ["Lin", "Jamie"],
  },
  {
    id: "thu-focus",
    day: 3,
    title: "Roadmap polish",
    start: "9:00 AM",
    end: "11:00 AM",
    kind: "focus",
  },
];

const dayLabels = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function CalendarPage() {
  const [selectedDay, setSelectedDay] = useState(todayDay);

  const dayEvents = useMemo(
    () => events.filter((e) => e.day === selectedDay),
    [selectedDay]
  );

  // Auto-select next upcoming event for the day, or first event
  const nextUpcomingId = useMemo(() => {
    if (dayEvents.length === 0) return null;
    return dayEvents[0].id;
  }, [dayEvents]);

  const [selectedId, setSelectedId] = useState<string | null>(nextUpcomingId);

  // Reset selection when day changes
  useMemo(() => {
    setSelectedId(nextUpcomingId);
  }, [nextUpcomingId]);

  const selected = dayEvents.find((e) => e.id === selectedId) ?? dayEvents[0];

  const dayCount = (i: number) => events.filter((e) => e.day === i).length;
  const selectedDate = days[selectedDay];

  return (
    <>
      <Topbar title="Calendar" subtitle="Your schedule and meeting prep" />
      <div className="flex-1 px-6 lg:px-10 py-8 max-w-7xl w-full mx-auto">
        {/* Week strip */}
        <div className="flex items-center gap-2 mb-6">
          <button className="size-9 rounded-lg ring-1 ring-border bg-surface text-muted-foreground hover:text-foreground hover:bg-muted inline-flex items-center justify-center">
            <ChevronLeft className="size-4" />
          </button>
          <div className="grid grid-cols-7 gap-2 flex-1">
            {days.map((d, i) => {
              const active = i === selectedDay;
              const count = dayCount(i);
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDay(i)}
                  className={`rounded-2xl py-3 px-2 ring-1 transition-all text-center ${
                    active
                      ? "bg-primary text-primary-foreground ring-primary shadow-soft"
                      : "bg-surface ring-border hover:bg-muted"
                  }`}
                >
                  <p
                    className={`text-[10px] font-semibold tracking-wider ${
                      active ? "text-primary-foreground/80" : "text-muted-foreground"
                    }`}
                  >
                    {dayLabels[i]}
                  </p>
                  <p className="text-2xl font-bold tabular-nums mt-1 leading-none">
                    {d.getDate()}
                  </p>
                  <div className="flex justify-center items-center gap-0.5 mt-1.5 h-1.5">
                    {Array.from({ length: Math.min(count, 3) }).map((_, k) => (
                      <span
                        key={k}
                        className={`size-1.5 rounded-full ${
                          active ? "bg-primary-foreground/70" : "bg-primary"
                        }`}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
          <button className="size-9 rounded-lg ring-1 ring-border bg-surface text-muted-foreground hover:text-foreground hover:bg-muted inline-flex items-center justify-center">
            <ChevronRight className="size-4" />
          </button>
          <button
            onClick={() => setSelectedDay(todayDay)}
            className="h-9 px-3 rounded-lg ring-1 ring-border bg-surface text-xs font-semibold hover:bg-muted"
          >
            Today
          </button>
        </div>

        {/* Two-column: schedule + AI prep */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-5">
          <section className="rounded-2xl bg-surface ring-1 ring-border shadow-soft p-5">
            <h2 className="text-xs font-bold uppercase tracking-wider mb-4">
              {selectedDate.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </h2>
            {dayEvents.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground text-sm">
                Nothing scheduled. A great day for focused work.
              </div>
            ) : (
              <div className="space-y-2.5">
                {dayEvents.map((e) => {
                  const active = selected?.id === e.id;
                  const tile =
                    e.kind === "focus" ? "bg-tile-mint/40" : "bg-tile-lavender/40";
                  const bar = e.kind === "focus" ? "bg-success" : "bg-primary";
                  return (
                    <button
                      key={e.id}
                      onClick={() => setSelectedId(e.id)}
                      className={`relative w-full text-left rounded-xl pl-4 pr-4 py-3.5 overflow-hidden transition-all ring-1 ${tile} ${
                        active ? "ring-primary/50 shadow-soft" : "ring-border hover:ring-primary/30"
                      }`}
                    >
                      <span
                        className={`absolute left-0 top-2 bottom-2 w-1 rounded-r ${bar}`}
                      />
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{e.title}</p>
                          {e.attendees && (
                            <div className="flex items-center gap-1 mt-2">
                              {e.attendees.map((a) => (
                                <span
                                  key={a}
                                  className="size-6 rounded-full bg-surface ring-1 ring-border text-[10px] font-semibold text-muted-foreground inline-flex items-center justify-center"
                                >
                                  {a[0]}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <p className="text-[11px] tabular-nums text-muted-foreground whitespace-nowrap">
                          {e.start} – {e.end}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* AI prep panel — auto-selects upcoming event */}
          <aside className="rounded-2xl bg-surface ring-1 ring-border shadow-soft p-5 self-start">
            {selected ? (
              <div className="space-y-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-primary inline-flex items-center gap-1.5">
                    <Sparkles className="size-3" />
                    AI prep · next up
                  </p>
                  <h3 className="text-base font-semibold tracking-tight mt-2">
                    {selected.title}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1.5">
                    <Clock className="size-3" />
                    {selected.start} – {selected.end}
                  </p>
                </div>

                {selected.attendees && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1.5">
                      <Users className="size-3" />
                      Attendees
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {selected.attendees.map((a) => (
                        <span
                          key={a}
                          className="px-2 py-0.5 rounded-md text-[11px] ring-1 ring-border bg-surface"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {selected.notes && (
                  <div className="rounded-xl bg-primary/8 ring-1 ring-primary/20 p-3.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1.5 inline-flex items-center gap-1.5">
                      <Sparkles className="size-3" />
                      Suggested talking points
                    </p>
                    <p className="text-sm text-primary leading-relaxed">{selected.notes}</p>
                  </div>
                )}

                {selected.prep && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1.5">
                      <FileText className="size-3" />
                      Context loaded
                    </p>
                    <ul className="space-y-1.5">
                      {selected.prep.map((p) => (
                        <li
                          key={p}
                          className="text-xs text-foreground/80 px-2.5 py-1.5 rounded-md ring-1 ring-border bg-surface"
                        >
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex flex-col gap-2 pt-1">
                  <button className="h-9 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 inline-flex items-center justify-center gap-1.5">
                    <Sparkles className="size-3.5" />
                    Generate full brief
                  </button>
                  <button className="h-9 rounded-lg ring-1 ring-border bg-surface text-xs font-medium hover:bg-muted">
                    Open in Composer
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-16 text-center text-muted-foreground gap-2 flex flex-col items-center">
                <Sparkles className="size-6" />
                <p className="text-sm">Pick a day with events to see AI prep.</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}
