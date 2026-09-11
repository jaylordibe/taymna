"use client";

import { useState } from "react";
import { API_URL } from "@/lib/api";
import type { Platform } from "@/lib/types";
import { useCreateMachine } from "@/lib/use-machines";

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "WINDOWS", label: "Windows" },
  { value: "LINUX", label: "Linux" },
  { value: "MACOS", label: "macOS" },
];

export function AddMachinePanel() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<Platform>("WINDOWS");
  const [enrollCommand, setEnrollCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const createMachine = useCreateMachine();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-line px-4 py-1.5 text-sm text-ink transition-colors hover:border-amber hover:text-amber"
      >
        Add machine
      </button>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const result = await createMachine.mutateAsync({ name: name.trim(), platform });
    setEnrollCommand(
      `taymna-agent enroll --server ${API_URL} --token ${result.enrollmentToken}`,
    );
  }

  function close() {
    setOpen(false);
    setName("");
    setEnrollCommand(null);
    setCopied(false);
  }

  return (
    <div className="w-full rounded-2xl border border-line bg-surface p-5 sm:w-96">
      {enrollCommand ? (
        <div>
          <h2 className="text-base font-semibold text-ink">Install the agent on {name}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Run this once on the machine. The token expires in 15 minutes and can only be
            used once.
          </p>
          <div className="mt-3 rounded-lg border border-line bg-paper p-3 font-mono text-xs break-all text-ink">
            {enrollCommand}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(enrollCommand);
                setCopied(true);
              }}
              className="rounded-full bg-amber px-3.5 py-1.5 text-sm font-medium text-ink"
            >
              {copied ? "Copied" : "Copy command"}
            </button>
            <button type="button" onClick={close} className="text-sm text-ink-soft hover:text-ink">
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <h2 className="text-base font-semibold text-ink">Add a machine</h2>
          <div className="mt-3 flex flex-col gap-3">
            <input
              autoFocus
              type="text"
              placeholder="Machine name, e.g. PC-01"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-amber"
            />
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
              className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-amber"
            >
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {createMachine.isError && (
            <p className="mt-2 text-sm text-brick">Couldn&apos;t add that machine. Try again.</p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={!name.trim() || createMachine.isPending}
              className="rounded-full bg-amber px-4 py-1.5 text-sm font-medium text-ink disabled:opacity-50"
            >
              {createMachine.isPending ? "Adding…" : "Add machine"}
            </button>
            <button type="button" onClick={close} className="text-sm text-ink-soft hover:text-ink">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
