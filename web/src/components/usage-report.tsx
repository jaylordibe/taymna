"use client";

import { useMemo, useState } from "react";
import type { ReportedSession, UsageReport } from "@/lib/types";
import { platformLabel } from "@/lib/platform-label";
import { dailyUsage, dayLabel, sessionWindowLabel } from "@/lib/daily-usage";
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
      {report.data && (
        <UsageTable
          report={report.data}
          label={rangeLabel(range.from, range.to)}
          fromDate={range.from}
          toDate={range.to}
        />
      )}
    </div>
  );
}

/** Beyond about a month a bar-per-day stops being readable on a phone. */
const MAX_DAILY_ROWS = 31;

function UsageTable({
  report,
  label,
  fromDate,
  toDate,
}: {
  report: UsageReport;
  label: string;
  fromDate: string;
  toDate: string;
}) {
  const busiest = Math.max(...report.machines.map((m) => m.usedSeconds), 1);
  const used = report.machines.filter((m) => m.usedSeconds > 0).length;

  const csv = useMemo(() => buildCsv(report), [report]);
  const days = useMemo(
    () => dailyUsage(report.sessions, fromDate, toDate),
    [report.sessions, fromDate, toDate],
  );

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
            <MachineRow
              key={machine.machineId}
              machine={machine}
              busiest={busiest}
              sessions={report.sessions.filter((s) => s.machineId === machine.machineId)}
            />
          ))}
        </ul>
      )}

      {days.length > 1 && days.length <= MAX_DAILY_ROWS && <DailyBreakdown days={days} />}
    </section>
  );
}

function MachineRow({
  machine,
  busiest,
  sessions,
}: {
  machine: UsageReport["machines"][number];
  busiest: number;
  sessions: ReportedSession[];
}) {
  const [open, setOpen] = useState(false);
  const canExpand = sessions.length > 0;

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-medium text-ink">{machine.name}</span>
        <span className="tabular shrink-0 text-sm text-ink">
          {formatUsage(machine.usedSeconds)}
        </span>
      </div>
      {/* A bar rather than a chart library: one relative magnitude is all
          there is to show, and it reads fine on a phone. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-amber"
          style={{ width: `${(machine.usedSeconds / busiest) * 100}%` }}
        />
      </div>
      {canExpand ? (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="self-start text-xs text-ink-soft hover:text-ink"
        >
          {platformLabel(machine.platform)} ·{" "}
          {machine.sessionCount === 1 ? "1 session" : `${machine.sessionCount} sessions`}
          <span aria-hidden="true"> {open ? "▾" : "▸"}</span>
        </button>
      ) : (
        <p className="text-xs text-ink-soft">{platformLabel(machine.platform)} · no sessions</p>
      )}

      {open && (
        <ul className="mt-1 flex flex-col gap-1 border-l border-line pl-3">
          {sessions.map((session) => (
            <li
              key={`${session.machineId}-${session.startedAt}`}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <span className="tabular truncate text-ink-soft">
                {sessionWindowLabel(session.startedAt, session.endedAt)}
              </span>
              <span className="shrink-0 text-ink-soft">
                <span className="tabular text-ink">{formatUsage(session.usedSeconds)}</span>{" "}
                {outcomeLabel(session.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function DailyBreakdown({ days }: { days: { date: string; seconds: number }[] }) {
  const busiest = Math.max(...days.map((day) => day.seconds), 1);

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h2 className="text-xs font-medium tracking-wide text-ink-soft uppercase">By day</h2>
      <ul className="flex flex-col gap-1.5">
        {days.map((day) => (
          <li key={day.date} className="flex items-center gap-3 text-xs">
            <span className="w-24 shrink-0 text-ink-soft">{dayLabel(day.date)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <span
                className="block h-full rounded-full bg-sage"
                style={{ width: `${(day.seconds / busiest) * 100}%` }}
              />
            </span>
            <span className="tabular w-16 shrink-0 text-right text-ink">
              {formatUsage(day.seconds)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How a session finished -- the distinction the totals depend on. */
function outcomeLabel(status: ReportedSession["status"]): string {
  if (status === "ACTIVE") return "· running";
  if (status === "ENDED") return "· ended early";
  return "· ran to the end";
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
