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

/**
 * `version` is optional and always will be: agents upgrade one machine at a
 * time, so a server must keep working with one that predates the field.
 * It is untrusted text from the machine's credential holder -- validated
 * and capped by `sanitizeAgentVersion` before it is stored or shown.
 */
export type AgentToServerMessage = { type: 'heartbeat'; atMs: number; version?: unknown };

export type ServerToOperatorMessage =
  | {
      type: 'machine_updated';
      machineId: string;
      online: boolean;
      lastSeenAt: string | null;
      agentVersion: string | null;
    }
  | { type: 'session_updated'; machineId: string; session: SessionStateDto | null }
  | { type: 'machine_removed'; machineId: string };
