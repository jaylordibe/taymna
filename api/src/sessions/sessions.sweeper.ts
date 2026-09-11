import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { $Enums } from '../generated/prisma/client.js';

/**
 * Sweeps ACTIVE sessions whose expiresAt has passed to EXPIRED. This is the
 * only background job in the system -- a single in-process cron, not a
 * queue -- and exists purely so the partial unique index frees up promptly
 * even if nobody touches the machine again. SessionsService also transitions
 * inline on every read/write, so this sweep is a backstop, not the only path.
 */
@Injectable()
export class SessionsSweeper {
  private readonly logger = new Logger(SessionsSweeper.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('*/30 * * * * *')
  async sweep(): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: { status: $Enums.SessionStatus.ACTIVE, expiresAt: { lt: new Date() } },
      data: { status: $Enums.SessionStatus.EXPIRED },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} stale session(s)`);
    }
  }
}
