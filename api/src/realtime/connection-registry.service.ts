import { Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import {
  AgentToServerMessage,
  ServerToAgentMessage,
  ServerToOperatorMessage,
} from './protocol.js';

/**
 * Tracks live WebSocket connections and provides typed send/broadcast
 * helpers. Kept separate from RealtimeGateway (the @WebSocketGateway) so
 * MachinesService/SessionsService can push updates without depending on
 * Nest's gateway decorators or creating a module import cycle.
 */
@Injectable()
export class ConnectionRegistryService {
  private readonly logger = new Logger(ConnectionRegistryService.name);
  private readonly agentSockets = new Map<string, WebSocket>();
  private readonly operatorSockets = new Set<WebSocket>();

  registerAgent(machineId: string, socket: WebSocket): void {
    const existing = this.agentSockets.get(machineId);
    if (existing && existing !== socket && existing.readyState === existing.OPEN) {
      // A second connection for the same machine (e.g. the old process
      // hasn't noticed it died yet) -- close the stale one so there's only
      // ever one authoritative socket per machine.
      existing.close(4000, 'Replaced by newer connection');
    }
    this.agentSockets.set(machineId, socket);
  }

  unregisterAgent(machineId: string, socket: WebSocket): void {
    if (this.agentSockets.get(machineId) === socket) {
      this.agentSockets.delete(machineId);
    }
  }

  registerOperator(socket: WebSocket): void {
    this.operatorSockets.add(socket);
  }

  unregisterOperator(socket: WebSocket): void {
    this.operatorSockets.delete(socket);
  }

  isAgentConnected(machineId: string): boolean {
    const socket = this.agentSockets.get(machineId);
    return !!socket && socket.readyState === socket.OPEN;
  }

  sendToMachine(machineId: string, message: ServerToAgentMessage): void {
    const socket = this.agentSockets.get(machineId);
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  broadcastToOperators(message: ServerToOperatorMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.operatorSockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  /** Kicks a machine's live connection, e.g. after credential revocation. */
  disconnectMachine(machineId: string, code: number, reason: string): void {
    const socket = this.agentSockets.get(machineId);
    if (socket) {
      socket.close(code, reason);
      this.agentSockets.delete(machineId);
    }
  }
}

export type { AgentToServerMessage };
