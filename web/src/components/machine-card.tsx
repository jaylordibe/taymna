"use client";

import { useState } from "react";
import type { Machine } from "@/lib/types";
import { installCommand, installHint } from "@/lib/install-command";
import { platformLabel } from "@/lib/platform-label";
import { lastSeenLabel, remainingLabel, untilLabel } from "@/lib/format-time";
import { useNow } from "@/lib/use-now";
import {
  useDeleteMachine,
  useEndSession,
  useExtendSession,
  useIssueEnrollmentToken,
  useRenameMachine,
  useRevokeCredential,
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
  // `null` while not renaming; a string (possibly empty) while editing.
  const [draftName, setDraftName] = useState<string | null>(null);
  // Every destructive action (end session, revoke, remove) goes through
  // this one two-step confirm; only one can be pending at a time.
  const [confirm, setConfirm] = useState<"end" | "revoke" | "remove" | null>(null);
  const startSession = useStartSession();
  const extendSession = useExtendSession();
  const endSession = useEndSession();
  const issueEnrollmentToken = useIssueEnrollmentToken();
  const revokeCredential = useRevokeCredential();
  const deleteMachine = useDeleteMachine();
  const renameMachine = useRenameMachine();

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
      setConfirm(null);
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

  async function handleRename(event: React.FormEvent) {
    event.preventDefault();
    const name = draftName?.trim();
    // An unchanged name is a cancel, not a request -- no point spending a
    // round trip to write what is already there.
    if (!name || name === machine.name) {
      setDraftName(null);
      return;
    }
    try {
      await renameMachine.mutateAsync({ machineId: machine.id, name });
      setDraftName(null);
    } catch {
      // Leave the field open with what they typed so it can be retried;
      // the name on screen is still the one the server has.
    }
  }

  async function handleGetInstallCommand() {
    setCopied(false);
    const result = await issueEnrollmentToken.mutateAsync(machine.id);
    setEnrollCommand(installCommand(machine.platform, result.token));
  }

  async function handleRevoke() {
    setBusy(true);
    try {
      await revokeCredential.mutateAsync(machine.id);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      await deleteMachine.mutateAsync(machine.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex overflow-hidden rounded-2xl border border-line bg-surface">
      <div className={`w-1.5 shrink-0 ${BAR_COLOR[state]}`} aria-hidden />
      <div className="flex-1 p-5">
        <div className="flex items-baseline justify-between gap-3">
          {draftName === null ? (
            <h2 className="flex items-baseline gap-2 text-lg font-semibold text-ink">
              {machine.name}
              <button
                type="button"
                onClick={() => setDraftName(machine.name)}
                aria-label={`Rename ${machine.name}`}
                className="text-xs font-normal text-ink-soft hover:text-ink"
              >
                Rename
              </button>
            </h2>
          ) : (
            <form onSubmit={handleRename} className="flex flex-1 items-center gap-2">
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                aria-label="Machine name"
                maxLength={100}
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-2 py-1 text-lg font-semibold text-ink"
              />
              <button
                type="submit"
                disabled={!draftName.trim() || renameMachine.isPending}
                className="shrink-0 rounded-full bg-amber px-3 py-1 text-sm font-medium text-ink disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setDraftName(null)}
                className="shrink-0 text-sm text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
            </form>
          )}
          {draftName === null && (
            <span className="text-sm text-ink-soft">{platformLabel(machine.platform)}</span>
          )}
        </div>

        <p className="mt-1 text-sm text-ink-soft">
          {machine.online ? "Online" : lastSeenLabel(machine.lastSeenAt, now)}
        </p>

        {enrollCommand ? (
          <div className="mt-4 rounded-lg border border-line bg-paper p-3">
            <p className="text-sm text-ink-soft">
              {installHint(machine.platform)} It installs (or updates) the agent and enrolls{" "}
              {machine.name}. The token expires in 15 minutes and can only be used once.
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

            {confirm === "end" ? (
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span className="text-ink-soft">End the session now? {machine.name} locks immediately.</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleEnd}
                  className="rounded-full bg-brick px-3.5 py-1.5 font-medium text-paper transition-colors hover:bg-brick/90 disabled:opacity-50"
                >
                  End
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm(null)}
                  className="text-ink-soft hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            ) : (
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
                  onClick={() => setConfirm("end")}
                  className="ml-auto rounded-full px-3.5 py-1.5 text-sm text-brick transition-colors hover:bg-brick/10 disabled:opacity-50"
                >
                  End session
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-sage">Available</span>
            <StartSessionControl busy={busy} onStart={handleStart} />
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-xs">
          {confirm === "revoke" ? (
            <>
              <span className="text-ink-soft">
                Revoke its credential? The agent disconnects and needs a fresh enrollment.
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={handleRevoke}
                className="font-medium text-brick hover:underline disabled:opacity-50"
              >
                Revoke
              </button>
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : confirm === "remove" ? (
            <>
              <span className="text-ink-soft">
                Remove {machine.name}? Its sessions and tokens are deleted too.
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={handleRemove}
                className="font-medium text-brick hover:underline disabled:opacity-50"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="text-ink-soft hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirm("revoke")}
                className="text-ink-soft transition-colors hover:text-ink"
              >
                Revoke credential
              </button>
              <button
                type="button"
                onClick={() => setConfirm("remove")}
                className="ml-auto text-ink-soft transition-colors hover:text-brick"
              >
                Remove machine
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
