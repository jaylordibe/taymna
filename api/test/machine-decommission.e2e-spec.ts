import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * The machine-decommission lifecycle, over a real WebSocket and Postgres.
 *
 * The invariant under test: removing an enrolled machine is an acknowledged
 * hand-off, never a bare delete. The row (and its credential) survive until the
 * agent confirms it has relinquished control; only then is the machine deleted.
 * A machine with no agent to coordinate with is removed directly, and nothing
 * short of an authenticated acknowledgement ever deletes an enrolled machine.
 */
describe('Machine decommission lifecycle (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  let adminToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
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
  });

  afterAll(async () => {
    await prisma.session.deleteMany();
    await prisma.enrollmentToken.deleteMany();
    await prisma.machine.deleteMany();
    await app.close();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  /** Creates a machine and returns its id plus the one-time enrollment token. */
  async function createMachine(name: string): Promise<{ id: string; enrollmentToken: string }> {
    const res = await request(app.getHttpServer())
      .post('/machines')
      .set(auth())
      .send({ name, platform: 'WINDOWS' })
      .expect(201);
    return { id: res.body.machine.id, enrollmentToken: res.body.enrollmentToken };
  }

  /** Creates and enrolls a machine, returning its id and live credential. */
  async function enrolledMachine(name: string): Promise<{ id: string; credential: string }> {
    const { id, enrollmentToken } = await createMachine(name);
    const enrolled = await request(app.getHttpServer())
      .post('/machines/enroll')
      .send({ token: enrollmentToken })
      .expect(200);
    return { id, credential: `${enrolled.body.machineId}.${enrolled.body.machineSecret}` };
  }

  const getMachine = (id: string) =>
    request(app.getHttpServer()).get(`/machines/${id}`).set(auth());

  interface AgentConn {
    messages: Array<{ type: string; [k: string]: unknown }>;
    waitFor: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
    send: (obj: unknown) => void;
    waitClose: (timeoutMs?: number) => Promise<{ code: number }>;
    close: () => void;
  }

  /**
   * Opens an agent WebSocket with a machine credential and returns a small
   * controller: `waitFor(type)` resolves on (or with an already-seen) message
   * of that type, `send` writes a message, `waitClose` resolves with the close
   * code. Deterministic -- no sleeps. Rejects if the upgrade is refused.
   */
  function connectAgent(credential: string): Promise<AgentConn> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Machine ${credential}` },
      });
      const messages: AgentConn['messages'] = [];
      const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
      let closeInfo: { code: number } | null = null;
      const closeWaiters: Array<(c: { code: number }) => void> = [];

      const conn: AgentConn = {
        messages,
        waitFor: (type, timeoutMs = 3000) =>
          new Promise((res, rej) => {
            const seen = messages.find((m) => m.type === type);
            if (seen) return res(seen);
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    `timed out waiting for ${type}; saw [${messages.map((m) => m.type).join(', ')}]`,
                  ),
                ),
              timeoutMs,
            );
            waiters.push({
              type,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          }),
        send: (obj) => socket.send(JSON.stringify(obj)),
        waitClose: (timeoutMs = 3000) =>
          new Promise((res, rej) => {
            if (closeInfo) return res(closeInfo);
            const timer = setTimeout(() => rej(new Error('timed out waiting for close')), timeoutMs);
            closeWaiters.push((c) => {
              clearTimeout(timer);
              res(c);
            });
          }),
        close: () => {
          socket.removeAllListeners();
          socket.close();
        },
      };

      socket.on('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade refused with HTTP ${res.statusCode}`)),
      );
      // A rejected upgrade also surfaces as an error; ignore errors after the
      // socket has served its purpose.
      socket.on('error', () => {});
      socket.on('open', () => resolve(conn));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        const idx = waiters.findIndex((w) => w.type === message.type);
        if (idx >= 0) waiters.splice(idx, 1)[0].resolve(message);
      });
      socket.on('close', (code) => {
        closeInfo = { code };
        closeWaiters.splice(0).forEach((r) => r({ code }));
      });
    });
  }

  it('online: tells the agent to decommission, keeps the row until it acks, then deletes it', async () => {
    const { id, credential } = await enrolledMachine('online-remove');
    const agent = await connectAgent(credential);
    await agent.waitFor('session_state'); // managed connect

    const removed = await request(app.getHttpServer())
      .delete(`/machines/${id}`)
      .set(auth())
      .expect(200);
    expect(removed.body).toEqual({ outcome: 'decommissioning', machine: expect.any(Object) });
    expect(removed.body.machine.decommissioning).toBe(true);

    // The live agent is instructed to relinquish control...
    await agent.waitFor('decommission');
    // ...and until it acks, the row is NOT deleted.
    const stillThere = await getMachine(id).expect(200);
    expect(stillThere.body.decommissioning).toBe(true);

    // Acknowledge -> the server finalizes: closes 4003 and deletes the row.
    agent.send({ type: 'decommission_ack' });
    const { code } = await agent.waitClose();
    expect(code).toBe(4003);
    await getMachine(id).expect(404);
    agent.close();
  });

  it('offline: stays pending and is decommissioned when the agent reconnects', async () => {
    const { id, credential } = await enrolledMachine('offline-remove');

    // Removal requested while the agent is not connected.
    const removed = await request(app.getHttpServer())
      .delete(`/machines/${id}`)
      .set(auth())
      .expect(200);
    expect(removed.body.outcome).toBe('decommissioning');

    // Not deleted -- it waits. The pending fact is persisted in the row.
    await getMachine(id).expect(200);
    const row = await prisma.machine.findUnique({ where: { id } });
    expect(row?.decommissionRequestedAt).not.toBeNull();

    // On reconnect the agent is told to decommission *first*, in place of
    // session state, so it never resumes enforcement on the way out.
    const agent = await connectAgent(credential);
    await agent.waitFor('decommission');
    expect(agent.messages.some((m) => m.type === 'session_state')).toBe(false);

    agent.send({ type: 'decommission_ack' });
    expect((await agent.waitClose()).code).toBe(4003);
    await getMachine(id).expect(404);
    agent.close();
  });

  it('decommission takes precedence over an active session', async () => {
    const { id, credential } = await enrolledMachine('active-session-remove');
    await request(app.getHttpServer())
      .post(`/machines/${id}/sessions`)
      .set(auth())
      .send({ durationMinutes: 120 })
      .expect(201);

    const agent = await connectAgent(credential);
    await agent.waitFor('session_state');

    await request(app.getHttpServer()).delete(`/machines/${id}`).set(auth()).expect(200);
    await agent.waitFor('decommission');
    agent.send({ type: 'decommission_ack' });
    expect((await agent.waitClose()).code).toBe(4003);

    // The machine (and its active session, by cascade) are gone.
    await getMachine(id).expect(404);
    const sessions = await prisma.session.findMany({ where: { machineId: id } });
    expect(sessions).toHaveLength(0);
    agent.close();
  });

  it('a duplicate removal request is idempotent and does not reset the pending time', async () => {
    const { id } = await enrolledMachine('double-remove');

    await request(app.getHttpServer()).delete(`/machines/${id}`).set(auth()).expect(200);
    const first = await prisma.machine.findUnique({ where: { id } });

    await request(app.getHttpServer()).delete(`/machines/${id}`).set(auth()).expect(200);
    const second = await prisma.machine.findUnique({ where: { id } });

    expect(second?.decommissionRequestedAt?.toISOString()).toBe(
      first?.decommissionRequestedAt?.toISOString(),
    );
    // Still exactly one row -- neither request deleted anything.
    expect(await prisma.machine.count({ where: { id } })).toBe(1);
  });

  it('a duplicate ack does not error and leaves the machine correctly removed', async () => {
    const { id, credential } = await enrolledMachine('double-ack');
    const agent = await connectAgent(credential);
    await agent.waitFor('session_state');
    await request(app.getHttpServer()).delete(`/machines/${id}`).set(auth()).expect(200);
    await agent.waitFor('decommission');

    // Two acks back to back: the first finalizes, the second is a no-op.
    agent.send({ type: 'decommission_ack' });
    agent.send({ type: 'decommission_ack' });
    expect((await agent.waitClose()).code).toBe(4003);
    await getMachine(id).expect(404);
    agent.close();
  });

  it('finalization permanently invalidates the old credential', async () => {
    const { id, credential } = await enrolledMachine('credential-dead');
    const agent = await connectAgent(credential);
    await agent.waitFor('session_state');
    await request(app.getHttpServer()).delete(`/machines/${id}`).set(auth()).expect(200);
    await agent.waitFor('decommission');
    agent.send({ type: 'decommission_ack' });
    await agent.waitClose();
    agent.close();

    // The old credential no longer authenticates: the server accepts the
    // upgrade but immediately closes with 4001 (invalid credential), because
    // the row is gone. (Auth failure is a post-upgrade close, not an HTTP 401.)
    const reconnect = await connectAgent(credential);
    expect((await reconnect.waitClose()).code).toBe(4001);
    reconnect.close();
  });

  it('removes a never-enrolled machine directly (no agent to coordinate with)', async () => {
    const { id } = await createMachine('never-enrolled');
    const removed = await request(app.getHttpServer())
      .delete(`/machines/${id}`)
      .set(auth())
      .expect(200);
    expect(removed.body).toEqual({ outcome: 'removed' });
    await getMachine(id).expect(404);
  });

  it('a normal disconnect does not decommission a managed machine', async () => {
    const { id, credential } = await enrolledMachine('just-disconnect');
    const agent = await connectAgent(credential);
    const first = await agent.waitFor('session_state');
    // A managed connect is handed session state, never a decommission.
    expect(first.type).toBe('session_state');
    agent.close();

    // Dropping the connection must not remove or mark the machine.
    const res = await getMachine(id).expect(200);
    expect(res.body.decommissioning).toBe(false);
  });

  it('rejects an unauthenticated removal request', async () => {
    const { id } = await enrolledMachine('needs-auth');
    await request(app.getHttpServer()).delete(`/machines/${id}`).expect(401);
    await request(app.getHttpServer())
      .delete(`/machines/${id}`)
      .set({ Authorization: 'Bearer not-a-real-token' })
      .expect(401);
    // Untouched by the rejected attempts.
    await getMachine(id).expect(200);
  });
});
