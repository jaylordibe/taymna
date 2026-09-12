import { describe, expect, it } from "vitest";
import { dailyUsage, overlapSeconds, sessionWindowLabel } from "./daily-usage";
import type { ReportedSession } from "./types";

const HOUR = 3600;

/** A session expressed in local time, which is how the day buckets are cut. */
function session(
  start: [number, number, number, number, number],
  end: [number, number, number, number, number],
): ReportedSession {
  const [ys, ms, ds, hs, mins] = start;
  const [ye, me, de, he, mine] = end;
  return {
    machineId: "m1",
    startedAt: new Date(ys, ms - 1, ds, hs, mins).toISOString(),
    endedAt: new Date(ye, me - 1, de, he, mine).toISOString(),
    status: "EXPIRED",
    usedSeconds: 0,
  };
}

describe("overlapSeconds", () => {
  it("counts only the part inside the day", () => {
    const start = new Date(2026, 8, 12, 23, 0);
    const end = new Date(2026, 8, 13, 1, 0);
    expect(overlapSeconds(start, end, new Date(2026, 8, 12), new Date(2026, 8, 13))).toBe(HOUR);
  });

  it("is zero outside the day", () => {
    const start = new Date(2026, 8, 10, 9, 0);
    const end = new Date(2026, 8, 10, 11, 0);
    expect(overlapSeconds(start, end, new Date(2026, 8, 12), new Date(2026, 8, 13))).toBe(0);
  });
});

describe("dailyUsage", () => {
  it("totals a day's sessions", () => {
    const days = dailyUsage(
      [
        session([2026, 9, 12, 9, 0], [2026, 9, 12, 11, 0]),
        session([2026, 9, 12, 14, 0], [2026, 9, 12, 14, 30]),
      ],
      "2026-09-12",
      "2026-09-12",
    );
    expect(days).toEqual([{ date: "2026-09-12", seconds: 2 * HOUR + 1800 }]);
  });

  it("splits a session that crosses local midnight across both days", () => {
    const days = dailyUsage(
      [session([2026, 9, 12, 23, 0], [2026, 9, 13, 1, 0])],
      "2026-09-12",
      "2026-09-13",
    );
    expect(days).toEqual([
      { date: "2026-09-12", seconds: HOUR },
      { date: "2026-09-13", seconds: HOUR },
    ]);
  });

  it("includes days with no usage rather than skipping them", () => {
    const days = dailyUsage(
      [session([2026, 9, 14, 9, 0], [2026, 9, 14, 10, 0])],
      "2026-09-12",
      "2026-09-14",
    );
    expect(days.map((d) => d.date)).toEqual(["2026-09-12", "2026-09-13", "2026-09-14"]);
    expect(days.map((d) => d.seconds)).toEqual([0, 0, HOUR]);
  });

  it("adds up to the same total however the range is cut", () => {
    const sessions = [
      session([2026, 9, 12, 23, 0], [2026, 9, 13, 1, 0]),
      session([2026, 9, 13, 9, 0], [2026, 9, 13, 12, 0]),
    ];
    const total = dailyUsage(sessions, "2026-09-12", "2026-09-13").reduce(
      (sum, day) => sum + day.seconds,
      0,
    );
    expect(total).toBe(5 * HOUR);
  });

  it("walks across a month boundary", () => {
    const days = dailyUsage([], "2026-09-29", "2026-10-02");
    expect(days.map((d) => d.date)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
  });

  it("gives one bucket per calendar day, not per 24 hours", () => {
    // A month with a daylight-saving shift in it still yields exactly one
    // entry per date, because every boundary is a local midnight.
    const days = dailyUsage([], "2026-03-01", "2026-03-31");
    expect(days).toHaveLength(31);
    expect(new Set(days.map((d) => d.date)).size).toBe(31);
  });
});

describe("sessionWindowLabel", () => {
  it("shows one date for a session inside a single day", () => {
    const label = sessionWindowLabel(
      new Date(2026, 8, 12, 9, 0).toISOString(),
      new Date(2026, 8, 12, 11, 0).toISOString(),
    );
    expect(label.match(/Sep/g)).toHaveLength(1);
  });

  it("shows both dates for a session that crosses midnight", () => {
    const label = sessionWindowLabel(
      new Date(2026, 8, 12, 23, 0).toISOString(),
      new Date(2026, 8, 13, 1, 0).toISOString(),
    );
    expect(label.match(/Sep/g)).toHaveLength(2);
  });
});
