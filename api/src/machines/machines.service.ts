import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ConnectionRegistryService } from '../realtime/connection-registry.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { generateSecret, hashSecret, verifySecret } from '../common/security/secret.util.js';
import { Machine, $Enums } from '../generated/prisma/client.js';
import { MachineDto } from './machine.dto.js';

const ENROLLMENT_TOKEN_TTL_MS = 15 * 60_000;

export interface IssuedEnrollmentToken {
  token: string;
  expiresAt: Date;
}

export interface EnrollResult {
  machineId: string;
  machineSecret: string;
}

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly registry: ConnectionRegistryService,
    private readonly config: AppConfigService,
  ) {}

  async create(
    name: string,
    platform: $Enums.Platform,
  ): Promise<{ machine: MachineDto; enrollmentToken: string; expiresAt: string }> {
    const machine = await this.prisma.machine.create({ data: { name, platform } });
    const issued = await this.issueEnrollmentToken(machine.id);
    return {
      machine: await this.toDto(machine),
      enrollmentToken: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  async list(): Promise<MachineDto[]> {
    const machines = await this.prisma.machine.findMany({ orderBy: { createdAt: 'asc' } });
    return Promise.all(machines.map((m) => this.toDto(m)));
  }

  async get(id: string): Promise<MachineDto> {
    const machine = await this.requireMachine(id);
    return this.toDto(machine);
  }

  async issueEnrollmentToken(machineId: string): Promise<IssuedEnrollmentToken> {
    await this.requireMachine(machineId);
    const secret = generateSecret();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS);
    const record = await this.prisma.enrollmentToken.create({
      data: { machineId, tokenHash: await hashSecret(secret), expiresAt },
    });
    return { token: `${record.id}.${secret}`, expiresAt };
  }

  async revokeCredential(machineId: string): Promise<MachineDto> {
    const machine = await this.prisma.machine.update({
      where: { id: machineId },
      data: { credentialHash: null, credentialRevokedAt: new Date() },
    });
    this.registry.disconnectMachine(machineId, 4001, 'Credential revoked');
    return this.toDto(machine);
  }

  /**
   * Completes enrollment for a one-time token shaped `<enrollmentTokenId>.<secret>`
   * (same `id.secret` shape as a machine credential -- see docs/enrollment.md).
   * Never accepts a shared/global secret: each token is single-use and scoped
   * to exactly the machine it was issued for.
   */
  async enroll(token: string): Promise<EnrollResult> {
    const [tokenId, secret] = splitCredential(token);
    if (!tokenId || !secret || !isUUID(tokenId)) {
      // isUUID is checked explicitly rather than letting a malformed id
      // reach Prisma: the `id` column is `@db.Uuid`, so Postgres itself
      // rejects a non-UUID value with a driver-level error that Prisma
      // surfaces as an uncaught PrismaClientKnownRequestError (500) instead
      // of the clean 400 a bad/mistyped token should produce.
      throw new BadRequestException('Malformed enrollment token');
    }

    const record = await this.prisma.enrollmentToken.findUnique({ where: { id: tokenId } });
    if (
      !record ||
      record.usedAt ||
      record.expiresAt <= new Date() ||
      !(await verifySecret(record.tokenHash, secret))
    ) {
      throw new BadRequestException('Enrollment token is invalid, used, or expired');
    }

    const machineSecret = generateSecret();
    const [, machine] = await this.prisma.$transaction([
      this.prisma.enrollmentToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.machine.update({
        where: { id: record.machineId },
        data: {
          credentialHash: await hashSecret(machineSecret),
          credentialRevokedAt: null,
        },
      }),
    ]);

    return { machineId: machine.id, machineSecret };
  }

  /** Used by the WS gateway to authenticate `Authorization: Machine <id>.<secret>`. */
  async verifyMachineCredential(machineId: string, secret: string): Promise<boolean> {
    if (!isUUID(machineId)) return false;
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine || machine.credentialRevokedAt) return false;
    return verifySecret(machine.credentialHash, secret);
  }

  async recordHeartbeat(machineId: string): Promise<void> {
    const machine = await this.prisma.machine.update({
      where: { id: machineId },
      data: { lastSeenAt: new Date() },
    });
    this.registry.broadcastToOperators({
      type: 'machine_updated',
      machineId,
      online: true,
      lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
    });
  }

  private async requireMachine(id: string): Promise<Machine> {
    const machine = await this.prisma.machine.findUnique({ where: { id } });
    if (!machine) throw new NotFoundException('Machine not found');
    return machine;
  }

  private async toDto(machine: Machine): Promise<MachineDto> {
    const activeSession = await this.sessions.getActiveSession(machine.id);
    return {
      id: machine.id,
      name: machine.name,
      platform: machine.platform,
      online: this.isOnline(machine.lastSeenAt),
      lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
      activeSession: activeSession ? SessionsService.toDto(activeSession) : null,
      createdAt: machine.createdAt.toISOString(),
      updatedAt: machine.updatedAt.toISOString(),
    };
  }

  private isOnline(lastSeenAt: Date | null): boolean {
    if (!lastSeenAt) return false;
    const ageSeconds = (Date.now() - lastSeenAt.getTime()) / 1000;
    return ageSeconds <= this.config.heartbeatTimeoutSeconds;
  }
}

export function splitCredential(value: string): [string, string] | [null, null] {
  const idx = value.indexOf('.');
  if (idx <= 0 || idx === value.length - 1) return [null, null];
  return [value.slice(0, idx), value.slice(idx + 1)];
}
