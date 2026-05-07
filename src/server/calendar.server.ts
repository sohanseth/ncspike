/**
 * Google Calendar helper: proposes free meeting slots from the user's
 * primary calendar using the Free/Busy API. Server-only.
 *
 * Defaults are sensible and conservative:
 *   - Working hours: 09:00–17:00 in the user's timezone
 *   - Days: Mon–Fri
 *   - Slot length: 30 min, on the half-hour
 *   - Lookahead: next 7 calendar days, skipping today's already-past hours
 *   - Buffer: skip the next 2 hours from "now" so the recipient has time to respond
 *   - Returns up to 3 proposed slots
 *
 * If the user hasn't connected Google Calendar, callers should treat this
 * as a no-op and fall back to the existing "let me know your availability"
 * prompt language.
 */
import { getValidGoogleAccessToken } from "@/server/gmail-auth.server";

export type ProposedSlot = {
  /** ISO 8601 with offset, e.g. "2026-05-08T14:00:00+01:00" */
  startIso: string;
  /** ISO 8601 with offset */
  endIso: string;
  /** Human-readable in the user's TZ, e.g. "Thu May 8, 2:00–2:30 PM BST" */
  human: string;
};

type FreeBusyResponse = {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>;
};

type Options = {
  /** IANA timezone, e.g. "Europe/London". Defaults to the calendar's primary TZ. */
  timezone?: string;
  /** 0-23 inclusive */
  workdayStartHour?: number;
  /** 0-23 inclusive (exclusive upper bound for slot start) */
  workdayEndHour?: number;
  /** Length of each slot in minutes */
  slotMinutes?: number;
  /** How many days ahead to scan */
  daysAhead?: number;
  /** Min hours from now before first proposed slot */
  bufferHours?: number;
  /** How many slots to propose */
  maxSlots?: number;
  /**
   * When true, transport / API failures are re-thrown instead of being
   * collapsed to []. Lets callers (e.g. the asking-panel "Use my calendar"
   * chip) distinguish "calendar unreachable" from "no free slots". Defaults
   * to false for backward compatibility with draft generation, which prefers
   * to silently degrade.
   */
  throwOnError?: boolean;
};

const DEFAULTS: Required<Omit<Options, "timezone">> = {
  workdayStartHour: 9,
  workdayEndHour: 17,
  slotMinutes: 30,
  daysAhead: 7,
  bufferHours: 2,
  maxSlots: 3,
  throwOnError: false,
};

/**
 * Fetch the primary calendar's IANA timezone. Falls back to "UTC" on error.
 */
async function fetchCalendarTimezone(token: string): Promise<string> {
  try {
    const r = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return "UTC";
    const j = (await r.json()) as { timeZone?: string };
    return j.timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Format an instant in a target IANA timezone into an offset-bearing ISO string.
 * Returns e.g. "2026-05-08T14:00:00+01:00".
 */
function toZonedIso(instant: Date, timezone: string): string {
  // Use Intl to extract the wall-clock components of `instant` in `timezone`.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  // Compute the offset: difference between the wall clock in TZ and UTC.
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMin = Math.round((asIfUtc - instant.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

function humanizeSlot(start: Date, end: Date, timezone: string): string {
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const tzFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  });
  const tzPart = tzFmt.formatToParts(start).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${dayFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)} ${tzPart}`;
}

/** Get the wall-clock weekday (0=Sun..6=Sat) of an instant in a TZ. */
function weekdayInTz(instant: Date, timezone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(instant);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/** Get the wall-clock hour (0-23) of an instant in a TZ. */
function hourInTz(instant: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "2-digit", hourCycle: "h23",
  }).format(instant));
}

/**
 * Propose up to N free meeting slots over the next `daysAhead` days,
 * within working hours, skipping weekends and existing busy blocks.
 *
 * Returns [] when calendar isn't connected or the API call fails — caller
 * should handle that as "no slots to suggest".
 */
export async function proposeFreeSlots(
  userId: string,
  opts: Options = {},
): Promise<ProposedSlot[]> {
  const o = { ...DEFAULTS, ...opts };

  let token: string;
  try {
    ({ token } = await getValidGoogleAccessToken(userId, "google_calendar"));
  } catch (e) {
    if (o.throwOnError) throw e;
    return []; // not connected → graceful no-op for draft generation
  }

  const rawTz = opts.timezone ?? (await fetchCalendarTimezone(token));
  // Validate the IANA id — Intl throws RangeError on unknown zones, which
  // would otherwise bubble out of every formatter call below.
  let timezone = "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: rawTz });
    timezone = rawTz;
  } catch {
    timezone = "UTC";
  }
  const now = new Date();
  const windowStart = new Date(now.getTime() + o.bufferHours * 3600_000);
  const windowEnd = new Date(now.getTime() + o.daysAhead * 86400_000);

  let busy: Array<{ start: Date; end: Date }> = [];
  try {
    const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        items: [{ id: "primary" }],
      }),
    });
    if (!r.ok) {
      if (o.throwOnError) {
        throw new Error(`freeBusy ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
      return [];
    }
    const j = (await r.json()) as FreeBusyResponse;
    const blocks = j.calendars?.primary?.busy ?? [];
    busy = blocks.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (e) {
    if (o.throwOnError) throw e;
    return [];
  }

  // Walk the window in slotMinutes increments. For each candidate slot,
  // require: in TZ-local working hours, weekday, and not overlapping any busy block.
  const slotMs = o.slotMinutes * 60_000;
  const proposed: ProposedSlot[] = [];

  // Snap windowStart up to the next slot boundary (on the half-hour).
  let cursor = new Date(Math.ceil(windowStart.getTime() / slotMs) * slotMs);

  while (cursor.getTime() < windowEnd.getTime() && proposed.length < o.maxSlots) {
    const slotEnd = new Date(cursor.getTime() + slotMs);
    const wd = weekdayInTz(cursor, timezone);
    const hr = hourInTz(cursor, timezone);
    const endHr = hourInTz(new Date(slotEnd.getTime() - 1), timezone);

    const isWeekday = wd >= 1 && wd <= 5;
    const inHours = hr >= o.workdayStartHour && endHr < o.workdayEndHour;

    if (isWeekday && inHours) {
      const overlaps = busy.some((b) => cursor < b.end && slotEnd > b.start);
      if (!overlaps) {
        proposed.push({
          startIso: toZonedIso(cursor, timezone),
          endIso: toZonedIso(slotEnd, timezone),
          human: humanizeSlot(cursor, slotEnd, timezone),
        });
        // Skip ahead past this slot + 30min so we don't propose back-to-back times.
        cursor = new Date(slotEnd.getTime() + slotMs);
        continue;
      }
    }
    cursor = new Date(cursor.getTime() + slotMs);
  }

  return proposed;
}

/** True if the user has a `google_calendar` connection on file. */
export async function hasCalendarConnection(userId: string): Promise<boolean> {
  try {
    await getValidGoogleAccessToken(userId, "google_calendar");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event creation (used by "Block prep time" after sending an interview reply)
// ---------------------------------------------------------------------------

/**
 * Convert a wall-clock time in a given IANA timezone to an absolute Date.
 * Inverse of `toZonedIso`. Iterates to converge on the correct UTC instant:
 * the TZ offset itself depends on the instant (DST), so we re-derive
 * `utc' = target_as_if_utc - offset(utc)` until it stabilizes. Verified
 * against BST↔GMT and EDT↔EST transitions.
 */
function fromZonedWallClock(
  year: number, month: number, day: number, hour: number, minute: number,
  timezone: string,
): Date {
  // Target wall clock interpreted as if UTC.
  const targetAsIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  // Initial guess: assume the TZ offset is whatever it is at targetAsIfUtc.
  // Iterate to handle DST boundaries (the offset itself depends on the instant).
  let utcMs = targetAsIfUtc;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
    );
    const seenAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute),
    );
    // offset = how this TZ shifts UTC instants → wall clock (positive east of UTC).
    const offset = seenAsUtc - utcMs;
    const next = targetAsIfUtc - offset;
    if (next === utcMs) break;
    utcMs = next;
  }
  return new Date(utcMs);
}

/** YYYY-MM-DD wall-clock date in TZ. */
function ymdInTz(instant: Date, timezone: string): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

export type PrepBlockSlot = ProposedSlot;

/**
 * Compute a 2-hour prep block (09:00–11:00 in the user's TZ) on the working
 * day immediately before the meeting. If the meeting itself is already on a
 * Monday, we walk back to Friday. If the meeting is later today (rare since
 * proposeFreeSlots respects bufferHours), we still try the morning before;
 * the caller decides whether the result is useful.
 *
 * `prepHours` is currently advisory — we always place a single 2-hour block
 * because longer holds tend to cannibalize the user's actual workday. A
 * future iteration can spread multiple blocks across days when prep is large.
 */
export function computePrepBlockSlot(
  meetingStartIso: string,
  timezone: string,
  _prepHours: number,
): PrepBlockSlot {
  const meeting = new Date(meetingStartIso);
  // Walk back day-by-day in the user's TZ until we hit a weekday strictly
  // before the meeting day.
  let candidate = new Date(meeting.getTime() - 24 * 3600_000);
  for (let i = 0; i < 7; i++) {
    const wd = weekdayInTz(candidate, timezone);
    const sameDay = (() => {
      const a = ymdInTz(candidate, timezone);
      const b = ymdInTz(meeting, timezone);
      return a.y === b.y && a.m === b.m && a.d === b.d;
    })();
    if (wd >= 1 && wd <= 5 && !sameDay) break;
    candidate = new Date(candidate.getTime() - 24 * 3600_000);
  }
  const { y, m, d } = ymdInTz(candidate, timezone);
  const start = fromZonedWallClock(y, m, d, 9, 0, timezone);
  const end = fromZonedWallClock(y, m, d, 11, 0, timezone);
  return {
    startIso: toZonedIso(start, timezone),
    endIso: toZonedIso(end, timezone),
    human: humanizeSlot(start, end, timezone),
  };
}

export class CalendarScopeError extends Error {
  constructor() {
    super("Google Calendar connection is read-only. Reconnect to enable event creation.");
    this.name = "CalendarScopeError";
  }
}

export type CreatedCalendarEvent = {
  eventId: string;
  htmlLink: string;
  startIso: string;
  endIso: string;
  human: string;
};

/**
 * Create an event on the user's primary calendar.
 *
 * Throws `CalendarScopeError` when the stored OAuth grant lacks the
 * `calendar.events` scope (i.e. a user who connected before this slice
 * shipped). UI should surface a "Reconnect Google Calendar" CTA in that case.
 */
export async function createCalendarEvent(
  userId: string,
  args: {
    summary: string;
    description?: string;
    startIso: string;
    endIso: string;
    timezone: string;
  },
): Promise<CreatedCalendarEvent> {
  const { token } = await getValidGoogleAccessToken(userId, "google_calendar");
  const r = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: args.summary,
        description: args.description,
        start: { dateTime: args.startIso, timeZone: args.timezone },
        end: { dateTime: args.endIso, timeZone: args.timezone },
        // Don't notify anyone — this is a private hold on the user's calendar.
        // (Google's default already doesn't email since there are no attendees.)
      }),
    },
  );
  if (r.status === 401 || r.status === 403) {
    // Most commonly: insufficient scope on the stored token.
    throw new CalendarScopeError();
  }
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Google Calendar event create failed (${r.status}): ${text.slice(0, 200)}`);
  }
  const j = (await r.json()) as { id?: string; htmlLink?: string };
  if (!j.id) throw new Error("Google Calendar returned no event id");
  const start = new Date(args.startIso);
  const end = new Date(args.endIso);
  return {
    eventId: j.id,
    htmlLink: j.htmlLink ?? "",
    startIso: args.startIso,
    endIso: args.endIso,
    human: humanizeSlot(start, end, args.timezone),
  };
}

/** Resolve the user's primary calendar timezone, with safe fallback. */
export async function getUserCalendarTimezone(userId: string): Promise<string> {
  try {
    const { token } = await getValidGoogleAccessToken(userId, "google_calendar");
    const tz = await fetchCalendarTimezone(token);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      return "UTC";
    }
  } catch {
    return "UTC";
  }
}
