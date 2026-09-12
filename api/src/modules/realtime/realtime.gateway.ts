import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import { MachinesService, splitCredential } from '../machines/machines.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ConnectionRegistryService } from './connection-registry.service.js';
import { AgentToServerMessage, ServerToAgentMessage } from './protocol.js';

const MACHINE_AUTH_PREFIX = 'Machine ';

@WebSocketGateway({ path: '/ws' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly agentIdBySocket = new WeakMap<WebSocket, string>();

  constructor(
    private readonly machines: MachinesService,
    private readonly sessions: SessionsService,
    private readonly registry: ConnectionRegistryService,
    private readonly jwt: JwtService,
  ) {}

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    const authHeader = request.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith(MACHINE_AUTH_PREFIX)) {
      await this.authenticateAgent(client, authHeader.slice(MACHINE_AUTH_PREFIX.length));
      return;
    }

    const token = this.extractOperatorToken(request.url);
    if (token) {
      this.authenticateOperator(client, token);
      return;
    }

    client.close(4001, 'Unauthorized');
  }

  handleDisconnect(client: WebSocket): void {
    const machineId = this.agentIdBySocket.get(client);
    if (machineId) {
      this.registry.unregisterAgent(machineId, client);
      this.agentIdBySocket.delete(client);
    } else {
      this.registry.unregisterOperator(client);
    }
  }

  private extractOperatorToken(url: string | undefined): string | null {
    if (!url) return null;
    // Base is irrelevant, only used so a relative `url` parses.
    return new URL(url, 'http://internal').searchParams.get('token');
  }

  private async authenticateAgent(client: WebSocket, credential: string): Promise<void> {
    const [machineId, secret] = splitCredential(credential);
    if (!machineId || !secret || !(await this.machines.verifyMachineCredential(machineId, secret))) {
      client.close(4001, 'Invalid machine credential');
      return;
    }

    this.agentIdBySocket.set(client, machineId);
    this.registry.registerAgent(machineId, client);

    // Attached before anything is awaited, because `ws` buffers nothing: a
    // message arriving with no listener is dropped outright. This closes the
    // window across the two awaits below. It cannot close the earlier one --
    // Nest invokes handleConnection a tick after the upgrade, so an agent
    // that sends the instant the socket opens can still lose that first
    // message. Harmless: the agent heartbeats every ~20s, and the connect
    // path below already records the heartbeat itself. The only thing that
    // waits is the reported version, until the next heartbeat.
    client.on('message', (raw: RawData) => {
      void this.handleAgentMessage(machineId, client, raw);
    });

    await this.machines.recordHeartbeat(machineId);

    const activeSession = await this.sessions.getActiveSession(machineId);
    this.send(client, {
      type: 'session_state',
      session: activeSession ? SessionsService.toDto(activeSession) : null,
      serverTime: new Date().toISOString(),
    });
  }

  private authenticateOperator(client: WebSocket, token: string): void {
    try {
      this.jwt.verify(token);
    } catch {
      client.close(4001, 'Invalid or expired token');
      return;
    }
    this.registry.registerOperator(client);
  }

  private async handleAgentMessage(machineId: string, client: WebSocket, raw: RawData): Promise<void> {
    let message: AgentToServerMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'heartbeat') {
      await this.machines.recordHeartbeat(machineId, message.version);
      this.send(client, { type: 'heartbeat_ack', serverTime: new Date().toISOString() });
    }
  }

  private send(client: WebSocket, message: ServerToAgentMessage): void {
    client.send(JSON.stringify(message));
  }
}
