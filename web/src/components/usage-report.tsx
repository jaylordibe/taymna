"use client";

import { useMemo, useState } from "react";
import type { UsageReport } from "@/lib/types";
import { platformLabel } from "@/lib/platform-label";
import {
  PRESETS,
  type PresetId,
  decimalHours,
  formatUsage,
  presetRange,
  rangeLabel,
  toDateInput,
} from "@/lib/report-range";
import { useUsageReport } from "@/lib/use-usage-report";

export function UsageReportView() {
  // `today` is read once per mount rather than per render: a preset must not
  // silently mean a different window just because the component re-rendered.
  const [today] = useState(() => new Date());
  const [preset, setPreset] = useState<PresetId | "custom">("last7");
  const [range, setRange] = useState(() => presetRange("last7", today));

  const report = useUsageReport(range.from, range.to, true);

  function choosePreset(id: PresetId) {
    setPreset(id);
    setRange(presetRange(id, today));
  }

  function setCustom(edge: "from" | "to", value: string) {
    if (!value) return;
    setPreset("custom");
    setRange((current) => {
      const next = { ...current, [edge]: value };
      // Whichever edge was dragged past the other, collapse to that single
      // day rather than leaving an inverted range the API would reject.
      return next.from > next.to ? { from: value, to: value } : next;
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => choosePreset(option.id)}
            aria-pressed={preset === option.id}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              preset === option.id
                ? "border-ink bg-ink text-paper"
                : "border-line bg-surface text-ink-soft hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-soft">
          From
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(event) => setCustom("from", event.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-soft">
          To
          <input
            type="date"
            value={range.to}
            min={range.from}
            max={toDateInput(today)}
            onChange={(event) => setCustom("to", event.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink"
          />
        </label>
      </div>

      {report.isPending && <p className="text-sm text-ink-soft">Loading usage…</p>}
      {report.isError && (
        <p className="text-sm text-brick">Couldn&apos;t load the report. Refresh to try again.</p>
      )}
      {report.data && <UsageTable report={report.data} label={rangeLabel(range.from, range.to)} />}
    </div>
  );
}

function UsageTable({ report, label }: { report: UsageReport; label: string }) {
  const busiest = Math.max(...report.machines.map((m) => m.usedSeconds), 1);
  const used = report.machines.filter((m) => m.usedSeconds > 0).length;

  const csv = useMemo(() => buildCsv(report), [report]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3">
        <div>
          <p className="text-sm text-ink-soft">{label}</p>
          <p className="tabular text-2xl font-semibold text-ink">
            {formatUsage(report.totalUsedSeconds)}
          </p>
          <p className="text-xs text-ink-soft">
            across {used} of {report.machines.length}{" "}
            {report.machines.length === 1 ? "machine" : "machines"}
          </p>
        </div>
        <DownloadCsv csv={csv} filename={`taymna-usage-${report.from.slice(0, 10)}.csv`} />
      </header>

      {report.machines.length === 0 ? (
        <p className="text-sm text-ink-soft">No machines yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {report.machines.map((machine) => (
            <li key={machine.machineId} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-medium text-ink">{machine.name}</span>
                <span className="tabular shrink-0 text-sm text-ink">
                  {formatUsage(machine.usedSeconds)}
                </span>
              </div>
              {/* A bar rather than a chart library: one relative magnitude is
                  all there is to show, and it reads fine on a phone. */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-amber"
                  style={{ width: `${(machine.usedSeconds / busiest) * 100}%` }}
                />
              </div>
              <p className="text-xs text-ink-soft">
                {platformLabel(machine.platform)} ·{" "}
                {machine.sessionCount === 1 ? "1 session" : `${machine.sessionCount} sessions`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DownloadCsv({ csv, filename }: { csv: string; filename: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
    >
      Export CSV
    </button>
  );
}

/** Decimal hours, so the numbers can be summed in a spreadsheet. */
function buildCsv(report: UsageReport): string {
  const rows = [
    ["Machine", "Platform", "Hours", "Sessions", "From", "To"],
    ...report.machines.map((machine) => [
      machine.name,
      machine.platform,
      decimalHours(machine.usedSeconds),
      String(machine.sessionCount),
      report.from,
      report.to,
    ]),
  ];
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
