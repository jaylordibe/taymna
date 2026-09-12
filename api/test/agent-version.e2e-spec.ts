import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * The agent version round trip, over a real WebSocket: an agent reports it on
 * its heartbeat, the dashboard's machine list shows it, and a machine cannot
 * use the field to put arbitrary text in the database.
 */
describe('Agent version reporting (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  let adminToken: string;
  let machineId: string;
  let credential: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // listen() runs init() itself; the WS adapter must be attached to a
    // server that is actually listening before an agent can upgrade.
    await app.listen(0);
    port = app.getHttpServer().address().port;

    prisma = app.get(PrismaService);
    await prisma.session.deleteMany();
    await prisma.enrollmentToken.deleteMany();
    await prisma.machine.deleteMany();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
      .expect(200);
    adminToken = login.body.token;

    const created = await request(app.getHttpServer())
      .post('/machines')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Front desk', platform: 'WINDOWS' })
      .expect(201);
    machineId = created.body.machine.id;

    const enrolled = await request(app.getHttpServer())
      .post('/machines/enroll')
      .send({ token: created.body.enrollmentToken })
      .expect(200);
    credential = `${enrolled.body.machineId}.${enrolled.body.machineSecret}`;
  });

  afterAll(async () => {
    await prisma.session.deleteMany();
    await prisma.machine.deleteMany();
    await app.close();
  });

  /**
   * Connects as the agent, sends one heartbeat, waits for its ack, closes.
   *
   * The heartbeat is sent only after the server's `session_state` push
   * arrives, not on `open`. Nest invokes `handleConnection` a tick after the
   * socket is upgraded, and `ws` buffers nothing -- a message sent before
   * then is silently dropped. `session_state` is the protocol's own proof
   * that the server finished accepting the agent, which makes this
   * deterministic rather than a sleep.
   */
  async function heartbeat(payload: Record<string, unknown>): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Machine ${credential}` },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('error', (err) => reject(new Error(`socket error: ${err.message}`)));
        socket.on('unexpected-response', (_req, res) =>
          reject(new Error(`upgrade refused with HTTP ${res.statusCode}`)),
        );
        socket.on('close', (code, reason) =>
          reject(new Error(`socket closed before ack: ${code} ${reason.toString()}`)),
        );
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === 'session_state') socket.send(JSON.stringify(payload));
          if (message.type === 'heartbeat_ack') resolve();
        });
      });
    } finally {
      socket.removeAllListeners();
      socket.close();
    }
  }

  const reportedVersion = async () => {
    const res = await request(app.getHttpServer())
      .get(`/machines/${machineId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return res.body.agentVersion;
  };

  it('is null before any agent has reported one', async () => {
    expect(await reportedVersion()).toBeNull();
  });

  it('records the version an agent reports on its heartbeat', async () => {
    await heartbeat({ type: 'heartbeat', atMs: Date.now(), version: '0.3.0' });
    expect(await reportedVersion()).toBe('0.3.0');
  });

  it('keeps the last known version when an older agent reports none', async () => {
    // Downgrading to an agent that predates the field must not blank out
    // what the dashboard already knows.
    await heartbeat({ type: 'heartbeat', atMs: Date.now() });
    expect(await reportedVersion()).toBe('0.3.0');
  });

  it('updates the version after an upgrade', async () => {
    await heartbeat({ type: 'heartbeat', atMs: Date.now(), version: '0.4.0' });
    expect(await reportedVersion()).toBe('0.4.0');
  });

  it('refuses text that is not version-shaped, and keeps the known value', async () => {
    await heartbeat({
      type: 'heartbeat',
      atMs: Date.now(),
      version: '<script>alert(1)</script>',
    });
    expect(await reportedVersion()).toBe('0.4.0');
  });

  it('refuses a value too long for the column instead of truncating it', async () => {
    await heartbeat({ type: 'heartbeat', atMs: Date.now(), version: '9'.repeat(64) });
    expect(await reportedVersion()).toBe('0.4.0');
  });

  it('refuses a non-string version without dropping the connection', async () => {
    await heartbeat({ type: 'heartbeat', atMs: Date.now(), version: { evil: true } });
    expect(await reportedVersion()).toBe('0.4.0');
  });

  it('surfaces the version on the machine list the dashboard reads', async () => {
    const res = await request(app.getHttpServer())
      .get('/machines')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body[0]).toMatchObject({ id: machineId, agentVersion: '0.4.0' });
  });
});
