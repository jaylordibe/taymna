import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConnectionRegistryService } from '../realtime/connection-registry.service.js';
import { Prisma, Session, $Enums } from '../generated/prisma/client.js';
import { SessionStateDto } from '../realtime/protocol.js';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistryService,
  ) {}

  static toDto(session: Session): SessionStateDto {
    return {
      id: session.id,
      startedAt: session.startedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      status: session.status,
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  /**
   * Transitions any stale ACTIVE session for this machine to EXPIRED. Called
   * inline before reads/writes so callers never see (or are blocked by) a
   * session that's logically expired but hasn't been swept yet by the cron
   * (see SessionsSweeper). Idempotent.
   */
  private async expireStaleActiveSession(machineId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { machineId, status: $Enums.SessionStatus.ACTIVE, expiresAt: { lt: new Date() } },
      data: { status: $Enums.SessionStatus.EXPIRED },
    });
  }

  async getActiveSession(machineId: string): Promise<Session | null> {
    await this.expireStaleActiveSession(machineId);
    return this.prisma.session.findFirst({
      where: { machineId, status: $Enums.SessionStatus.ACTIVE },
    });
  }

  async start(machineId: string, durationMinutes: number): Promise<Session> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw new NotFoundException('Machine not found');

    await this.expireStaleActiveSession(machineId);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMinutes * 60_000);

    let session: Session;
    try {
      session = await this.prisma.session.create({
        data: { machineId, startedAt: now, expiresAt },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Machine already has an active session');
      }
      throw err;
    }

    this.pushSessionUpdate(machineId, session);
    return session;
  }

  async extend(sessionId: string, additionalMinutes: number): Promise<Session> {
    const session = await this.requireActiveSession(sessionId);
    const updated = await this.prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(session.expiresAt.getTime() + additionalMinutes * 60_000) },
    });
    this.pushSessionUpdate(updated.machineId, updated);
    return updated;
  }

  async end(sessionId: string): Promise<Session> {
    const session = await this.requireActiveSession(sessionId);
    const updated = await this.prisma.session.update({
      where: { id: session.id },
      data: { status: $Enums.SessionStatus.ENDED, endedAt: new Date() },
    });
    this.pushSessionUpdate(updated.machineId, updated);
    return updated;
  }

  private async requireActiveSession(sessionId: string): Promise<Session> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.status !== $Enums.SessionStatus.ACTIVE || session.expiresAt <= new Date()) {
      throw new ConflictException('Session is not active');
    }
    return session;
  }

  private pushSessionUpdate(machineId: string, session: Session): void {
    const dto = SessionsService.toDto(session);
    this.registry.sendToMachine(machineId, {
      type: 'session_state',
      session: dto,
      serverTime: new Date().toISOString(),
    });
    this.registry.broadcastToOperators({
      type: 'session_updated',
      machineId,
      session: dto,
    });
  }
}
