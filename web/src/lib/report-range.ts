/**
 * Date-range handling for the usage report.
 *
 * The browser is the only place that reliably knows the operator's timezone,
 * so it is where a calendar date becomes an instant: "12 September" means
 * local midnight to the next local midnight, and the API is handed those two
 * instants. `new Date(y, m, d)` and `setDate()` are local-time operations, so
 * month ends and daylight-saving shifts are the platform's problem, not ours.
 */

export type PresetId = "today" | "yesterday" | "last7" | "last30" | "thisMonth";

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "thisMonth", label: "This month" },
];

/** A `<input type="date">` value (YYYY-MM-DD) for a local calendar date. */
export function toDateInput(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Midnight local time on a `<input type="date">` value. */
export function localMidnight(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** The two local calendar dates a preset covers, both inclusive. */
export function presetRange(preset: PresetId, today: Date): { from: string; to: string } {
  const start = new Date(today);
  switch (preset) {
    case "today":
      break;
    case "yesterday":
      start.setDate(start.getDate() - 1);
      return { from: toDateInput(start), to: toDateInput(start) };
    case "last7":
      start.setDate(start.getDate() - 6);
      break;
    case "last30":
      start.setDate(start.getDate() - 29);
      break;
    case "thisMonth":
      start.setDate(1);
      break;
  }
  return { from: toDateInput(start), to: toDateInput(today) };
}

/**
 * The half-open instant range `[from, to)` for two inclusive local dates --
 * `to` is pushed to the *next* midnight so the last day is counted in full.
 */
export function toInstantRange(from: string, to: string): { from: string; to: string } {
  const start = localMidnight(from);
  const endExclusive = localMidnight(to);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { from: start.toISOString(), to: endExclusive.toISOString() };
}

/** "3h 25m" -- the unit an operator actually thinks in. */
export function formatUsage(seconds: number): string {
  if (seconds <= 0) return "—";
  const totalMinutes = Math.round(seconds / 60);
  // A machine used for twenty seconds is not the same as one never used at
  // all, and rounding would otherwise make both read as nothing.
  if (totalMinutes === 0) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Decimal hours, for the CSV -- a spreadsheet can sum these, "3h 25m" it can't. */
export function decimalHours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

export function rangeLabel(from: string, to: string): string {
  const format = (value: string) =>
    localMidnight(value).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  return from === to ? format(from) : `${format(from)} – ${format(to)}`;
}
