import { $Enums } from '../../generated/prisma/client.js';

/**
 * The full WebSocket protocol, documented again for humans in
 * docs/protocol.md. Deliberately tiny: the agent never receives anything
 * resembling a generic command, only session-state facts.
 */

export interface SessionStateDto {
  id: string;
  startedAt: string;
  expiresAt: string;
  status: $Enums.SessionStatus;
  updatedAt: string;
}

export type ServerToAgentMessage =
  | { type: 'session_state'; session: SessionStateDto | null; serverTime: string }
  | { type: 'heartbeat_ack'; serverTime: string }
  | { type: 'error'; code: string; message: string };

export type AgentToServerMessage = { type: 'heartbeat'; atMs: number };

export type ServerToOperatorMessage =
  | {
      type: 'machine_updated';
      machineId: string;
      online: boolean;
      lastSeenAt: string | null;
    }
  | { type: 'session_updated'; machineId: string; session: SessionStateDto | null }
  | { type: 'machine_removed'; machineId: string };
