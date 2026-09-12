import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MachineUsage, summarizeUsage } from './usage.js';

export interface UsageReport {
  from: string;
  to: string;
  totalUsedSeconds: number;
  machines: MachineUsage[];
}

/** A year and a day: long enough for "the whole of last year", short enough
 *  that a malformed range can't ask for an unbounded scan. */
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async usage(fromIso: string, toIso: string): Promise<UsageReport> {
    const from = new Date(fromIso);
    const to = new Date(toIso);

    if (to <= from) throw new BadRequestException('`to` must be after `from`');
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new BadRequestException('Range must be 366 days or less');
    }

    const now = new Date();
    const [machines, sessions] = await Promise.all([
      this.prisma.machine.findMany({
        select: { id: true, name: true, platform: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.session.findMany({
        // A superset of the sessions that overlap the window: a session can
        // only have made the machine usable up to `expiresAt`, so anything
        // whose deadline predates the window contributed nothing to it.
        // summarizeUsage() does the exact clipping, including for sessions
        // ended early or still running.
        where: { startedAt: { lt: to }, expiresAt: { gt: from } },
        select: {
          machineId: true,
          startedAt: true,
          expiresAt: true,
          endedAt: true,
          status: true,
        },
      }),
    ]);

    const rows = summarizeUsage(machines, sessions, from, to, now);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalUsedSeconds: rows.reduce((total, row) => total + row.usedSeconds, 0),
      machines: rows,
    };
  }
}
