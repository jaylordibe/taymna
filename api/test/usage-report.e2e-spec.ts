import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { $Enums } from '../src/generated/prisma/client.js';

/**
 * The usage report against a real Postgres: the Prisma filter really is a
 * superset of the overlapping sessions, the auth guard really is on, and the
 * numbers really do add up end to end.
 */
describe('Usage report (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let deskId: string;
  let officeId: string;

  const HOUR = 3600;
  const day = (iso: string) => new Date(iso);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    await prisma.session.deleteMany();
    await prisma.enrollmentToken.deleteMany();
    await prisma.machine.deleteMany();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
      .expect(200);
    adminToken = login.body.token;

    const desk = await prisma.machine.create({
      data: { name: 'Front desk', platform: $Enums.Platform.WINDOWS },
    });
    const office = await prisma.machine.create({
      data: { name: 'Back office', platform: $Enums.Platform.LINUX },
    });
    deskId = desk.id;
    officeId = office.id;

    await prisma.session.createMany({
      data: [
        // Two hours, wholly inside 12 Sep.
        {
          machineId: deskId,
          startedAt: day('2026-09-12T09:00:00Z'),
          expiresAt: day('2026-09-12T11:00:00Z'),
          status: $Enums.SessionStatus.EXPIRED,
        },
        // Granted four hours, ended after thirty minutes: 30m of use.
        {
          machineId: deskId,
          startedAt: day('2026-09-12T13:00:00Z'),
          expiresAt: day('2026-09-12T17:00:00Z'),
          endedAt: day('2026-09-12T13:30:00Z'),
          status: $Enums.SessionStatus.ENDED,
        },
        // Straddles midnight: one hour on the 12th, one on the 13th.
        {
          machineId: officeId,
          startedAt: day('2026-09-12T23:00:00Z'),
          expiresAt: day('2026-09-13T01:00:00Z'),
          status: $Enums.SessionStatus.EXPIRED,
        },
        // Entirely before the window.
        {
          machineId: deskId,
          startedAt: day('2026-09-01T09:00:00Z'),
          expiresAt: day('2026-09-01T18:00:00Z'),
          status: $Enums.SessionStatus.EXPIRED,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany();
    await prisma.machine.deleteMany();
    await app.close();
  });

  const report = (from: string, to: string) =>
    request(app.getHttpServer())
      .get('/reports/usage')
      .query({ from, to })
      .set('Authorization', `Bearer ${adminToken}`);

  it('requires an operator token', async () => {
    await request(app.getHttpServer())
      .get('/reports/usage')
      .query({ from: '2026-09-12T00:00:00Z', to: '2026-09-13T00:00:00Z' })
      .expect(401);
  });

  it('reports usage per machine for one day, counting ended sessions only to their end', async () => {
    const res = await report('2026-09-12T00:00:00Z', '2026-09-13T00:00:00Z').expect(200);

    expect(res.body.machines).toEqual([
      expect.objectContaining({
        machineId: deskId,
        name: 'Front desk',
        usedSeconds: 2 * HOUR + 1800,
        sessionCount: 2,
      }),
      expect.objectContaining({ machineId: officeId, usedSeconds: HOUR, sessionCount: 1 }),
    ]);
    expect(res.body.totalUsedSeconds).toBe(3 * HOUR + 1800);
  });

  it('splits a session that straddles midnight across both days', async () => {
    const nextDay = await report('2026-09-13T00:00:00Z', '2026-09-14T00:00:00Z').expect(200);

    expect(nextDay.body.machines).toEqual([
      expect.objectContaining({ machineId: officeId, usedSeconds: HOUR, sessionCount: 1 }),
      expect.objectContaining({ machineId: deskId, usedSeconds: 0, sessionCount: 0 }),
    ]);
  });

  it('totals a multi-day range without double-counting the boundary', async () => {
    const res = await report('2026-09-12T00:00:00Z', '2026-09-14T00:00:00Z').expect(200);
    expect(res.body.totalUsedSeconds).toBe(4 * HOUR + 1800);
  });

  it('reports every machine, including ones never used in the window', async () => {
    const res = await report('2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z').expect(200);
    expect(res.body.machines).toHaveLength(2);
    expect(res.body.totalUsedSeconds).toBe(0);
  });

  it('rejects a backwards range', async () => {
    await report('2026-09-13T00:00:00Z', '2026-09-12T00:00:00Z').expect(400);
  });

  it('rejects a range longer than a year', async () => {
    await report('2020-01-01T00:00:00Z', '2026-09-12T00:00:00Z').expect(400);
  });

  it('rejects a malformed date', async () => {
    await report('not-a-date', '2026-09-12T00:00:00Z').expect(400);
  });
});
