import { describe, expect, it } from "vitest";
import {
  decimalHours,
  formatUsage,
  presetRange,
  rangeLabel,
  toDateInput,
  toInstantRange,
} from "./report-range";

// Local noon, so a test never straddles midnight in the runner's timezone.
const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

describe("presetRange", () => {
  const today = on(2026, 9, 12);

  it("covers a single day for today and yesterday", () => {
    expect(presetRange("today", today)).toEqual({ from: "2026-09-12", to: "2026-09-12" });
    expect(presetRange("yesterday", today)).toEqual({ from: "2026-09-11", to: "2026-09-11" });
  });

  it("counts today as one of the last 7 days", () => {
    expect(presetRange("last7", today)).toEqual({ from: "2026-09-06", to: "2026-09-12" });
  });

  it("counts today as one of the last 30 days", () => {
    expect(presetRange("last30", today)).toEqual({ from: "2026-08-14", to: "2026-09-12" });
  });

  it("starts this month on the 1st", () => {
    expect(presetRange("thisMonth", today)).toEqual({ from: "2026-09-01", to: "2026-09-12" });
  });

  it("crosses a month boundary backwards correctly", () => {
    expect(presetRange("last7", on(2026, 3, 2))).toEqual({ from: "2026-02-24", to: "2026-03-02" });
  });

  it("does not mutate the date it is given", () => {
    const today = on(2026, 9, 12);
    presetRange("last30", today);
    expect(toDateInput(today)).toBe("2026-09-12");
  });
});

describe("toInstantRange", () => {
  it("spans one whole local day for a single date", () => {
    const { from, to } = toInstantRange("2026-09-12", "2026-09-12");
    expect(new Date(from)).toEqual(new Date(2026, 8, 12));
    expect(new Date(to)).toEqual(new Date(2026, 8, 13));
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 3600 * 1000);
  });

  it("includes the whole of the final day of a range", () => {
    const { from, to } = toInstantRange("2026-09-01", "2026-09-30");
    expect(new Date(from)).toEqual(new Date(2026, 8, 1));
    expect(new Date(to)).toEqual(new Date(2026, 9, 1));
  });

  it("produces instants, so the API never has to guess a timezone", () => {
    const { from } = toInstantRange("2026-09-12", "2026-09-12");
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("formatUsage", () => {
  it("reads in the units an operator thinks in", () => {
    expect(formatUsage(0)).toBe("—");
    expect(formatUsage(1800)).toBe("30m");
    expect(formatUsage(3600)).toBe("1h");
    expect(formatUsage(12300)).toBe("3h 25m");
    expect(formatUsage(86_400)).toBe("24h");
  });

  it("rounds to the nearest minute rather than truncating", () => {
    expect(formatUsage(59)).toBe("1m");
  });

  it("distinguishes a machine barely used from one never used", () => {
    expect(formatUsage(29)).toBe("<1m");
    expect(formatUsage(1)).toBe("<1m");
    expect(formatUsage(0)).toBe("—");
  });
});

describe("decimalHours", () => {
  it("gives a spreadsheet something it can sum", () => {
    expect(decimalHours(12300)).toBe("3.42");
    expect(decimalHours(3600)).toBe("1.00");
    expect(decimalHours(0)).toBe("0.00");
  });
});

describe("rangeLabel", () => {
  it("collapses a single-day range to one date", () => {
    expect(rangeLabel("2026-09-12", "2026-09-12")).not.toContain("–");
  });

  it("shows both ends of a multi-day range", () => {
    expect(rangeLabel("2026-09-01", "2026-09-12")).toContain("–");
  });
});
