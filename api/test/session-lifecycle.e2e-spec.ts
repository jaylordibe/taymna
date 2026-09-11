import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Taymna session lifecycle (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let machineId: string;
  let machineSecret: string;

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
    // Isolate this run from any previous one; Operator (the bootstrapped
    // admin) is left alone since AuthService only creates it when empty.
    await prisma.session.deleteMany();
    await prisma.enrollmentToken.deleteMany();
    await prisma.machine.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects login with the wrong password', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: process.env.ADMIN_EMAIL, password: 'definitely-wrong' })
      .expect(401);
  });

  it('logs the bootstrapped admin in and issues a bearer token', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
      .expect(200);

    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.operator.email).toBe(process.env.ADMIN_EMAIL);
    adminToken = res.body.token;
  });

  it('rejects protected routes without a bearer token', async () => {
    await request(app.getHttpServer()).get('/machines').expect(401);
  });

  it('creates a machine and issues a one-time enrollment token', async () => {
    const res = await request(app.getHttpServer())
      .post('/machines')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'PC-01', platform: 'WINDOWS' })
      .expect(201);

    expect(res.body.machine.name).toBe('PC-01');
    expect(res.body.machine.online).toBe(false);
    expect(res.body.machine.activeSession).toBeNull();
    expect(res.body.enrollmentToken).toEqual(expect.any(String));

    machineId = res.body.machine.id;
    (globalThis as Record<string, unknown>).__enrollmentToken = res.body.enrollmentToken;
  });

  it('rejects a malformed or already-used enrollment token', async () => {
    await request(app.getHttpServer())
      .post('/machines/enroll')
      .send({ token: 'not-a-real-token' })
      .expect(400);
  });

  it('rejects a token whose id half is not a UUID with 400, not 500', async () => {
    // Regression test: the token id is looked up via a `@db.Uuid` column,
    // so a non-UUID id must be rejected before it ever reaches Prisma/
    // Postgres -- a raw "invalid input syntax for type uuid" driver error
    // must never surface as an uncaught 500.
    await request(app.getHttpServer())
      .post('/machines/enroll')
      .send({ token: 'not-a-uuid.some-secret' })
      .expect(400);
  });

  it('rejects a non-UUID machine id in a path param with 400, not 500', async () => {
    await request(app.getHttpServer())
      .get('/machines/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('completes enrollment and returns a one-time machine credential', async () => {
    const token = (globalThis as Record<string, unknown>).__enrollmentToken as string;
    const res = await request(app.getHttpServer())
      .post('/machines/enroll')
      .send({ token })
      .expect(200);

    expect(res.body.machineId).toBe(machineId);
    expect(res.body.machineSecret).toEqual(expect.any(String));
    machineSecret = res.body.machineSecret;

    // Single-use: the same token cannot be redeemed twice.
    await request(app.getHttpServer()).post('/machines/enroll').send({ token }).expect(400);
  });

  it('starts a session for the enrolled machine', async () => {
    const res = await request(app.getHttpServer())
      .post(`/machines/${machineId}/sessions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ durationMinutes: 30 })
      .expect(201);

    expect(res.body.status).toBe('ACTIVE');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to start a second conflicting active session (partial unique index)', async () => {
    await request(app.getHttpServer())
      .post(`/machines/${machineId}/sessions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ durationMinutes: 30 })
      .expect(409);
  });

  it('reports the active session and its remaining time', async () => {
    const res = await request(app.getHttpServer())
      .get(`/machines/${machineId}/sessions/active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.session.status).toBe('ACTIVE');
  });

  it('extends the active session', async () => {
    const before = await request(app.getHttpServer())
      .get(`/machines/${machineId}/sessions/active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/sessions/${before.body.session.id}/extend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ additionalMinutes: 15 })
      .expect(201);

    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(
      new Date(before.body.session.expiresAt).getTime(),
    );
  });

  it('treats a session past its expiresAt as no longer active (lazy expiry)', async () => {
    const active = await request(app.getHttpServer())
      .get(`/machines/${machineId}/sessions/active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Simulate time passing without a real wait -- push expiresAt into the
    // past directly, the same effect as the 30s sweeper catching up.
    await prisma.session.update({
      where: { id: active.body.session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app.getHttpServer())
      .get(`/machines/${machineId}/sessions/active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.session).toBeNull();

    const stored = await prisma.session.findUnique({ where: { id: active.body.session.id } });
    expect(stored?.status).toBe('EXPIRED');
  });

  it('allows starting a new session once the previous one has expired', async () => {
    await request(app.getHttpServer())
      .post(`/machines/${machineId}/sessions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ durationMinutes: 30 })
      .expect(201);
  });

  it('ends the active session immediately', async () => {
    const active = await request(app.getHttpServer())
      .get(`/machines/${machineId}/sessions/active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/sessions/${active.body.session.id}/end`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe('ENDED');

    const after = await request(app.getHttpServer())
      .get(`/machines/${machineId}/sessions/active`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(after.body.session).toBeNull();
  });

  it('revokes the machine credential and kicks its live connection eligibility', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/machines/${machineId}/credential`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.id).toBe(machineId);

    const stillValid = await prisma.machine.findUnique({ where: { id: machineId } });
    expect(stillValid?.credentialHash).toBeNull();
    void machineSecret; // credential above is now revoked regardless of the value
  });

  it('removes a machine along with its sessions and tokens', async () => {
    await request(app.getHttpServer())
      .delete(`/machines/${machineId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/machines/${machineId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    // Removing it again is a clean 404, not a 500 from a missing row.
    await request(app.getHttpServer())
      .delete(`/machines/${machineId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);

    expect(await prisma.session.count({ where: { machineId } })).toBe(0);
    expect(await prisma.enrollmentToken.count({ where: { machineId } })).toBe(0);
  });
});
