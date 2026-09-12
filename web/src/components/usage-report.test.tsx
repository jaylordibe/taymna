import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { UsageReportView } from "./usage-report";
import type { UsageReport } from "@/lib/types";

const usageReport = vi.fn();

vi.mock("@/lib/api", () => ({
  api: { usageReport: (...args: unknown[]) => usageReport(...args) },
  API_URL: "http://localhost:3000",
  ApiError: class extends Error {},
}));

const report: UsageReport = {
  from: "2026-09-06T00:00:00.000Z",
  to: "2026-09-13T00:00:00.000Z",
  totalUsedSeconds: 14_400,
  machines: [
    {
      machineId: "m1",
      name: "Front desk",
      platform: "WINDOWS",
      usedSeconds: 12_600,
      sessionCount: 3,
    },
    { machineId: "m2", name: "Back office", platform: "LINUX", usedSeconds: 1_800, sessionCount: 1 },
    { machineId: "m3", name: "Storeroom", platform: "MACOS", usedSeconds: 0, sessionCount: 0 },
  ],
};

beforeEach(() => {
  usageReport.mockReset();
  usageReport.mockResolvedValue(report);
});

describe("UsageReportView", () => {
  it("shows hours per machine and the total for the range", async () => {
    renderWithProviders(<UsageReportView />);

    expect(await screen.findByText("3h 30m")).toBeInTheDocument();
    expect(screen.getByText("Front desk")).toBeInTheDocument();
    expect(screen.getByText(/3 sessions/)).toBeInTheDocument();
    // The headline total, which is the sum and not any one machine.
    expect(screen.getByText("4h")).toBeInTheDocument();
  });

  it("still lists a machine that was not used at all", async () => {
    renderWithProviders(<UsageReportView />);

    expect(await screen.findByText("Storeroom")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/across 2 of 3 machines/)).toBeInTheDocument();
  });

  it("asks for a half-open instant range, not calendar dates", async () => {
    renderWithProviders(<UsageReportView />);

    await waitFor(() => expect(usageReport).toHaveBeenCalled());
    const [from, to] = usageReport.mock.calls[0] as [string, string];
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Last 7 days, counted inclusively, is exactly seven local days wide.
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("re-queries a narrower window when a preset is chosen", async () => {
    renderWithProviders(<UsageReportView />);
    await waitFor(() => expect(usageReport).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Today" }));

    await waitFor(() => expect(usageReport.mock.calls.length).toBeGreaterThan(1));
    const [from, to] = usageReport.mock.calls.at(-1) as [string, string];
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 3600 * 1000);
  });

  it("surfaces a failed report instead of showing zeroes", async () => {
    usageReport.mockRejectedValue(new Error("nope"));
    renderWithProviders(<UsageReportView />);

    expect(await screen.findByText(/Couldn't load the report/)).toBeInTheDocument();
  });
});
