import {
  AlertTriangle,
  CalendarClock,
  CalendarPlus,
  Clock,
  FileClock,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import type { InsightCard } from "@/lib/insight-card";
import { Button } from "@/components/ui/button";

export const KIND_ICON: Record<InsightCard["kind"], LucideIcon> = {
  clash: AlertTriangle,
  free_slot: Clock,
  overdue: FileClock,
  missing_from_calendar: CalendarPlus,
  prep: Lightbulb,
  reminder: CalendarClock,
};

export function InsightCardView({
  card,
  first = false,
  onAction,
  onNotNow,
  footnote,
}: {
  card: InsightCard;
  first?: boolean;
  onAction?: (card: InsightCard) => void;
  onNotNow: (card: InsightCard) => void;
  /** A quiet line under the "why" — used for Mac cards. */
  footnote?: string;
}) {
  const Icon = KIND_ICON[card.kind];
  const isPrivate = !!card.private;
  const action = !isPrivate ? card.actions[0] : undefined;

  return (
    <li
      className={`min-w-0 rounded-xl border p-4 flex flex-col gap-3 ${
        isPrivate
          ? "bg-private-card text-private-card-foreground border-border"
          : first
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-card border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <Icon className="size-5 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{isPrivate ? "Something private needs your attention." : card.text}</p>
          <p className={`mt-1 text-xs ${isPrivate ? "text-private-card-foreground" : first ? "opacity-75" : "text-muted-foreground"}`}>
            {isPrivate ? "The details stay on your Mac." : card.why}
          </p>
          {footnote && !isPrivate && <p className="mt-1 text-[11px] text-muted-foreground">{footnote}</p>}
        </div>
      </div>
      <div className="mt-auto flex items-center gap-3">
        {action && onAction && (
          <Button
            size="sm"
            onClick={() => onAction(card)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              first ? "bg-foreground text-background hover:bg-foreground/90" : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
          >
            {action.label}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onNotNow(card)}
          className={`text-xs font-medium hover:underline ${first && !isPrivate ? "opacity-80" : "text-muted-foreground"}`}
        >
          Not now
        </Button>
      </div>
    </li>
  );
}
