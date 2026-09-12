import { $Enums } from '../../generated/prisma/client.js';

/**
 * Usage reporting maths, kept pure (no Prisma, no clock) so every boundary
 * case below can be unit-tested without a database.
 *
 * The question this answers is "how long was this machine actually usable",
 * not "how much time was granted". Those differ whenever an operator ends a
 * session early, and the granted number would quietly flatter every report.
 */

export interface UsageSession {
  machineId: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  status: $Enums.SessionStatus;
}

export interface ReportedMachine {
  id: string;
  name: string;
  platform: $Enums.Platform;
}

export interface MachineUsage {
  machineId: string;
  name: string;
  platform: $Enums.Platform;
  usedSeconds: number;
  sessionCount: number;
}

/**
 * The instant a session stopped -- or, while it is still running, will stop
 * -- making the machine usable.
 *
 * - ENDED: `endedAt`, the moment the operator cut it short.
 * - EXPIRED: `expiresAt`. The sweeper does not write `endedAt`, so the
 *   deadline is the end.
 * - ACTIVE: now, capped at the deadline. Without the cap, an 8-hour session
 *   started a minute ago would report 8 hours of use.
 */
export function usableUntil(session: UsageSession, now: Date): Date {
  const deadline = session.expiresAt.getTime();
  // `endedAt` should never be past the deadline (ending requires an active,
  // unexpired session), but clamping costs nothing and keeps a bad row from
  // inventing time.
  let end = Math.min(session.endedAt?.getTime() ?? deadline, deadline);
  if (session.status === $Enums.SessionStatus.ACTIVE) {
    end = Math.min(end, now.getTime());
  }
  return new Date(end);
}

/**
 * Seconds of `[start, end)` that fall inside `[from, to)`.
 *
 * Clipping rather than attributing a whole session to the day it started on
 * is what makes a report add up: a session running 23:00-01:00 puts one hour
 * in each day, and a range boundary never double-counts or loses time.
 */
export function overlapSeconds(start: Date, end: Date, from: Date, to: Date): number {
  const overlapMs =
    Math.min(end.getTime(), to.getTime()) - Math.max(start.getTime(), from.getTime());
  return overlapMs > 0 ? overlapMs / 1000 : 0;
}

/**
 * Per-machine usage across `[from, to)`. Every machine is returned, including
 * ones with no usage at all -- "this PC was not used" is a real answer, and
 * one that silently missing rows would hide.
 */
export function summarizeUsage(
  machines: ReportedMachine[],
  sessions: UsageSession[],
  from: Date,
  to: Date,
  now: Date,
): MachineUsage[] {
  const rows = new Map<string, MachineUsage>(
    machines.map((m) => [
      m.id,
      { machineId: m.id, name: m.name, platform: m.platform, usedSeconds: 0, sessionCount: 0 },
    ]),
  );

  for (const session of sessions) {
    const row = rows.get(session.machineId);
    if (!row) continue;
    const seconds = overlapSeconds(session.startedAt, usableUntil(session, now), from, to);
    if (seconds <= 0) continue;
    row.usedSeconds += seconds;
    row.sessionCount += 1;
  }

  return [...rows.values()]
    .map((row) => ({ ...row, usedSeconds: Math.round(row.usedSeconds) }))
    .sort((a, b) => b.usedSeconds - a.usedSeconds || a.name.localeCompare(b.name));
}
