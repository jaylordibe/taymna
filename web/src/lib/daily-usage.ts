import type { ReportedSession } from "./types";
import { localMidnight, toDateInput } from "./report-range";

/**
 * Splitting usage into local days.
 *
 * This happens in the browser for the same reason the range does: local
 * midnights are a timezone question, and the browser is the only place that
 * knows the answer -- including on the two days a year that are 23 or 25
 * hours long, since every boundary here comes from local-time `Date` maths
 * rather than from adding 24 hours.
 */

export interface DayUsage {
  /** YYYY-MM-DD, local. */
  date: string;
  seconds: number;
}

/** Seconds of `[start, end)` that fall inside `[from, to)`. */
export function overlapSeconds(start: Date, end: Date, from: Date, to: Date): number {
  const overlapMs =
    Math.min(end.getTime(), to.getTime()) - Math.max(start.getTime(), from.getTime());
  return overlapMs > 0 ? overlapMs / 1000 : 0;
}

/**
 * One entry per local day from `fromDate` to `toDate` inclusive, including
 * days with no usage -- a gap in a bar chart is information, a missing bar is
 * a mystery.
 */
export function dailyUsage(
  sessions: ReportedSession[],
  fromDate: string,
  toDate: string,
): DayUsage[] {
  const bounds = sessions.map((session) => ({
    start: new Date(session.startedAt),
    end: new Date(session.endedAt),
  }));

  const days: DayUsage[] = [];
  const cursor = localMidnight(fromDate);
  const last = localMidnight(toDate);

  while (cursor <= last) {
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor);
    dayEnd.setDate(dayEnd.getDate() + 1);

    let seconds = 0;
    for (const { start, end } of bounds) {
      seconds += overlapSeconds(start, end, dayStart, dayEnd);
    }

    days.push({ date: toDateInput(dayStart), seconds: Math.round(seconds) });
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

/** "Sat 12 Sep" -- short enough for a row label, unambiguous across months. */
export function dayLabel(date: string): string {
  return localMidnight(date).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** "12 Sep, 9:00 AM – 11:00 AM", with both dates when it crosses midnight. */
export function sessionWindowLabel(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const time = (value: Date) =>
    value.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const date = (value: Date) =>
    value.toLocaleDateString(undefined, { day: "numeric", month: "short" });

  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${date(start)}, ${time(start)} – ${time(end)}`
    : `${date(start)}, ${time(start)} – ${date(end)}, ${time(end)}`;
}
