"use client";

import { useState } from "react";

const PRESETS = [
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "4 hours", minutes: 240 },
  { label: "8 hours", minutes: 480 },
];

export function StartSessionControl({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: (durationMinutes: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-sage px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        Start session
      </button>
    );
  }

  function start(minutes: number) {
    if (minutes > 0) {
      onStart(minutes);
      setOpen(false);
      setCustomMinutes("");
    }
  }

  return (
    <div className="w-full rounded-xl border border-line bg-paper p-3">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.minutes}
            type="button"
            disabled={busy}
            onClick={() => start(preset.minutes)}
            className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink transition-colors hover:border-sage hover:text-sage disabled:opacity-50"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          start(Number(customMinutes));
        }}
        className="mt-3 flex items-center gap-2"
      >
        <input
          type="number"
          min={1}
          max={10080}
          inputMode="numeric"
          placeholder="Custom minutes"
          value={customMinutes}
          onChange={(e) => setCustomMinutes(e.target.value)}
          className="w-32 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sage"
        />
        <button
          type="submit"
          disabled={busy || !customMinutes}
          className="rounded-full bg-sage px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Start
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-auto text-sm text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
