import { describe, expect, it } from 'vitest';
import { $Enums } from '../../generated/prisma/client.js';
import {
  overlapSeconds,
  reportSessions,
  summarizeUsage,
  usableUntil,
  type UsageSession,
} from './usage.js';

const at = (iso: string) => new Date(iso);
const HOUR = 3600;

function session(overrides: Partial<UsageSession> = {}): UsageSession {
  return {
    machineId: 'm1',
    startedAt: at('2026-09-12T09:00:00Z'),
    expiresAt: at('2026-09-12T11:00:00Z'),
    endedAt: null,
    status: $Enums.SessionStatus.EXPIRED,
    ...overrides,
  };
}

const machines = [
  { id: 'm1', name: 'Front desk', platform: $Enums.Platform.WINDOWS },
  { id: 'm2', name: 'Back office', platform: $Enums.Platform.LINUX },
];

describe('usableUntil', () => {
  it('uses the deadline for an expired session', () => {
    expect(usableUntil(session(), at('2026-09-12T20:00:00Z'))).toEqual(at('2026-09-12T11:00:00Z'));
  });

  it('uses endedAt when an operator ended the session early', () => {
    const ended = session({
      status: $Enums.SessionStatus.ENDED,
      endedAt: at('2026-09-12T09:20:00Z'),
    });
    expect(usableUntil(ended, at('2026-09-12T20:00:00Z'))).toEqual(at('2026-09-12T09:20:00Z'));
  });

  it('counts a running session only up to now, not to its deadline', () => {
    const running = session({ status: $Enums.SessionStatus.ACTIVE });
    expect(usableUntil(running, at('2026-09-12T09:30:00Z'))).toEqual(at('2026-09-12T09:30:00Z'));
  });

  it('caps a running session at its deadline once the sweeper is late', () => {
    const running = session({ status: $Enums.SessionStatus.ACTIVE });
    expect(usableUntil(running, at('2026-09-12T11:45:00Z'))).toEqual(at('2026-09-12T11:00:00Z'));
  });

  it('never lets a stray endedAt past the deadline invent time', () => {
    const odd = session({
      status: $Enums.SessionStatus.ENDED,
      endedAt: at('2026-09-12T18:00:00Z'),
    });
    expect(usableUntil(odd, at('2026-09-12T20:00:00Z'))).toEqual(at('2026-09-12T11:00:00Z'));
  });
});

describe('overlapSeconds', () => {
  const from = at('2026-09-12T00:00:00Z');
  const to = at('2026-09-13T00:00:00Z');

  it('counts a session fully inside the range', () => {
    expect(overlapSeconds(at('2026-09-12T09:00:00Z'), at('2026-09-12T11:00:00Z'), from, to)).toBe(
      2 * HOUR,
    );
  });

  it('counts only the part inside when a session starts before the range', () => {
    expect(overlapSeconds(at('2026-09-11T23:00:00Z'), at('2026-09-12T01:00:00Z'), from, to)).toBe(
      HOUR,
    );
  });

  it('counts only the part inside when a session runs past the range', () => {
    expect(overlapSeconds(at('2026-09-12T23:00:00Z'), at('2026-09-13T01:00:00Z'), from, to)).toBe(
      HOUR,
    );
  });

  it('splits a session across a boundary without losing or duplicating time', () => {
    const start = at('2026-09-12T23:00:00Z');
    const end = at('2026-09-13T01:00:00Z');
    const dayOne = overlapSeconds(start, end, from, to);
    const dayTwo = overlapSeconds(start, end, to, at('2026-09-14T00:00:00Z'));
    expect(dayOne).toBe(HOUR);
    expect(dayTwo).toBe(HOUR);
    expect(dayOne + dayTwo).toBe(2 * HOUR);
  });

  it('is zero for a session entirely outside the range', () => {
    expect(overlapSeconds(at('2026-09-10T09:00:00Z'), at('2026-09-10T11:00:00Z'), from, to)).toBe(0);
  });

  it('is zero for a session that merely touches the end of the range', () => {
    expect(overlapSeconds(to, at('2026-09-13T01:00:00Z'), from, to)).toBe(0);
  });
});

describe('summarizeUsage', () => {
  const from = at('2026-09-12T00:00:00Z');
  const to = at('2026-09-13T00:00:00Z');
  const now = at('2026-09-12T23:00:00Z');

  it('totals several sessions per machine and counts them', () => {
    const rows = summarizeUsage(
      machines,
      [
        session({ startedAt: at('2026-09-12T09:00:00Z'), expiresAt: at('2026-09-12T11:00:00Z') }),
        session({ startedAt: at('2026-09-12T13:00:00Z'), expiresAt: at('2026-09-12T14:00:00Z') }),
        session({
          machineId: 'm2',
          startedAt: at('2026-09-12T10:00:00Z'),
          expiresAt: at('2026-09-12T10:30:00Z'),
        }),
      ],
      from,
      to,
      now,
    );

    expect(rows).toEqual([
      expect.objectContaining({ machineId: 'm1', usedSeconds: 3 * HOUR, sessionCount: 2 }),
      expect.objectContaining({ machineId: 'm2', usedSeconds: 1800, sessionCount: 1 }),
    ]);
  });

  it('reports a machine that was never used rather than omitting it', () => {
    const rows = summarizeUsage(machines, [], from, to, now);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.usedSeconds === 0 && r.sessionCount === 0)).toBe(true);
  });

  it('counts an ended session only up to when it was ended', () => {
    const rows = summarizeUsage(
      machines,
      [
        session({
          startedAt: at('2026-09-12T09:00:00Z'),
          expiresAt: at('2026-09-12T17:00:00Z'),
          endedAt: at('2026-09-12T09:30:00Z'),
          status: $Enums.SessionStatus.ENDED,
        }),
      ],
      from,
      to,
      now,
    );
    expect(rows[0]).toMatchObject({ machineId: 'm1', usedSeconds: 1800 });
  });

  it('counts a still-running session only up to now', () => {
    const rows = summarizeUsage(
      machines,
      [
        session({
          startedAt: at('2026-09-12T22:00:00Z'),
          expiresAt: at('2026-09-13T06:00:00Z'),
          status: $Enums.SessionStatus.ACTIVE,
        }),
      ],
      from,
      to,
      now,
    );
    expect(rows[0]).toMatchObject({ machineId: 'm1', usedSeconds: HOUR });
  });

  it('does not count a session that falls entirely outside the range', () => {
    const rows = summarizeUsage(
      machines,
      [
        session({ startedAt: at('2026-09-01T09:00:00Z'), expiresAt: at('2026-09-01T11:00:00Z') }),
      ],
      from,
      to,
      now,
    );
    expect(rows.every((r) => r.usedSeconds === 0 && r.sessionCount === 0)).toBe(true);
  });

  it('sorts by usage, then by name, so the busiest machine is first', () => {
    const rows = summarizeUsage(
      machines,
      [
        session({
          machineId: 'm2',
          startedAt: at('2026-09-12T08:00:00Z'),
          expiresAt: at('2026-09-12T16:00:00Z'),
        }),
        session({ startedAt: at('2026-09-12T09:00:00Z'), expiresAt: at('2026-09-12T10:00:00Z') }),
      ],
      from,
      to,
      now,
    );
    expect(rows.map((r) => r.machineId)).toEqual(['m2', 'm1']);
  });

  it('ignores sessions belonging to a machine that is not in the report', () => {
    const rows = summarizeUsage(
      [machines[0]],
      [
        session({
          machineId: 'deleted',
          startedAt: at('2026-09-12T09:00:00Z'),
          expiresAt: at('2026-09-12T11:00:00Z'),
        }),
      ],
      from,
      to,
      now,
    );
    expect(rows).toEqual([expect.objectContaining({ machineId: 'm1', usedSeconds: 0 })]);
  });
});

describe('reportSessions', () => {
  const from = at('2026-09-12T00:00:00Z');
  const to = at('2026-09-13T00:00:00Z');
  const now = at('2026-09-12T23:00:00Z');

  it('reports a session with its real bounds but window-clipped usage', () => {
    // Started the evening before; only the part inside the window counts,
    // but the row still says when it actually began.
    const [row] = reportSessions(
      [session({ startedAt: at('2026-09-11T23:00:00Z'), expiresAt: at('2026-09-12T01:00:00Z') })],
      from,
      to,
      now,
    );

    expect(row).toEqual({
      machineId: 'm1',
      startedAt: '2026-09-11T23:00:00.000Z',
      endedAt: '2026-09-12T01:00:00.000Z',
      status: $Enums.SessionStatus.EXPIRED,
      usedSeconds: HOUR,
    });
  });

  it('reports the moment an ended session really stopped, not its deadline', () => {
    const [row] = reportSessions(
      [
        session({
          startedAt: at('2026-09-12T09:00:00Z'),
          expiresAt: at('2026-09-12T17:00:00Z'),
          endedAt: at('2026-09-12T09:30:00Z'),
          status: $Enums.SessionStatus.ENDED,
        }),
      ],
      from,
      to,
      now,
    );

    expect(row.endedAt).toBe('2026-09-12T09:30:00.000Z');
    expect(row.usedSeconds).toBe(1800);
  });

  it('drops sessions that contributed nothing to the window', () => {
    expect(
      reportSessions(
        [session({ startedAt: at('2026-09-01T09:00:00Z'), expiresAt: at('2026-09-01T11:00:00Z') })],
        from,
        to,
        now,
      ),
    ).toEqual([]);
  });

  it('returns the newest session first', () => {
    const rows = reportSessions(
      [
        session({ startedAt: at('2026-09-12T09:00:00Z'), expiresAt: at('2026-09-12T10:00:00Z') }),
        session({ startedAt: at('2026-09-12T14:00:00Z'), expiresAt: at('2026-09-12T15:00:00Z') }),
      ],
      from,
      to,
      now,
    );
    expect(rows.map((r) => r.startedAt)).toEqual([
      '2026-09-12T14:00:00.000Z',
      '2026-09-12T09:00:00.000Z',
    ]);
  });

  it('adds up to the same total the machine summary reports', () => {
    const sessions = [
      session({ startedAt: at('2026-09-12T09:00:00Z'), expiresAt: at('2026-09-12T11:00:00Z') }),
      session({ startedAt: at('2026-09-11T23:00:00Z'), expiresAt: at('2026-09-12T01:00:00Z') }),
    ];
    const detail = reportSessions(sessions, from, to, now).reduce((n, r) => n + r.usedSeconds, 0);
    const summary = summarizeUsage(machines, sessions, from, to, now)[0].usedSeconds;
    expect(detail).toBe(summary);
  });
});
