"use client";

import { useState } from "react";
import type { Machine } from "@/lib/types";
import { API_URL } from "@/lib/api";
import { platformLabel } from "@/lib/platform-label";
import { lastSeenLabel, remainingLabel, untilLabel } from "@/lib/format-time";
import { useNow } from "@/lib/use-now";
import {
  useEndSession,
  useExtendSession,
  useIssueEnrollmentToken,
  useStartSession,
} from "@/lib/use-machines";
import { StartSessionControl } from "./start-session-control";

const BAR_COLOR = {
  active: "bg-amber",
  available: "bg-sage",
  offline: "bg-slate",
} as const;

export function MachineCard({ machine }: { machine: Machine }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [enrollCommand, setEnrollCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const startSession = useStartSession();
  const extendSession = useExtendSession();
  const endSession = useEndSession();
  const issueEnrollmentToken = useIssueEnrollmentToken();

  const session = machine.activeSession;
  const isExpired = session ? new Date(session.expiresAt).getTime() <= now : false;
  const hasActiveSession = !!session && !isExpired;

  const state = hasActiveSession ? "active" : machine.online ? "available" : "offline";

  async function handleExtend(additionalMinutes: number) {
    if (!session) return;
    setBusy(true);
    try {
      await extendSession.mutateAsync({ sessionId: session.id, machineId: machine.id, additionalMinutes });
    } finally {
      setBusy(false);
    }
  }

  async function handleEnd() {
    if (!session) return;
    setBusy(true);
    try {
      await endSession.mutateAsync({ sessionId: session.id, machineId: machine.id });
    } finally {
      setBusy(false);
    }
  }

  async function handleStart(durationMinutes: number) {
    setBusy(true);
    try {
      await startSession.mutateAsync({ machineId: machine.id, durationMinutes });
    } finally {
      setBusy(false);
    }
  }

  async function handleGetInstallCommand() {
    setCopied(false);
    const result = await issueEnrollmentToken.mutateAsync(machine.id);
    setEnrollCommand(`taymna-agent enroll --server ${API_URL} --token ${result.token}`);
  }

  return (
    <article className="flex overflow-hidden rounded-2xl border border-line bg-surface">
      <div className={`w-1.5 shrink-0 ${BAR_COLOR[state]}`} aria-hidden />
      <div className="flex-1 p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">{machine.name}</h2>
          <span className="text-sm text-ink-soft">{platformLabel(machine.platform)}</span>
        </div>

        <p className="mt-1 text-sm text-ink-soft">
          {machine.online ? "Online" : lastSeenLabel(machine.lastSeenAt, now)}
        </p>

        {enrollCommand ? (
          <div className="mt-4 rounded-lg border border-line bg-paper p-3">
            <p className="text-sm text-ink-soft">
              Run this once on {machine.name}. The token expires in 15 minutes and can only be
              used once.
            </p>
            <div className="mt-2 rounded-lg border border-line bg-surface p-3 font-mono text-xs break-all text-ink">
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
              <button
                type="button"
                onClick={() => setEnrollCommand(null)}
                className="text-sm text-ink-soft hover:text-ink"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={issueEnrollmentToken.isPending}
            onClick={handleGetInstallCommand}
            className="mt-1 text-sm text-ink-soft underline decoration-dotted underline-offset-4 transition-colors hover:text-amber disabled:opacity-50"
          >
            {issueEnrollmentToken.isPending ? "Generating…" : "Installation command"}
          </button>
        )}

        {hasActiveSession && session ? (
          <div className="mt-4">
            <p className="font-mono text-3xl font-semibold tabular text-amber">
              {remainingLabel(session.expiresAt, now)}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">{untilLabel(session.expiresAt)}</p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => handleExtend(30)}
                className="rounded-full border border-line px-3.5 py-1.5 text-sm text-ink transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
              >
                +30 min
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleExtend(60)}
                className="rounded-full border border-line px-3.5 py-1.5 text-sm text-ink transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
              >
                +1 hour
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleEnd}
                className="ml-auto rounded-full px-3.5 py-1.5 text-sm text-brick transition-colors hover:bg-brick/10 disabled:opacity-50"
              >
                End session
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-sage">Available</span>
            <StartSessionControl busy={busy} onStart={handleStart} />
          </div>
        )}
      </div>
    </article>
  );
}
