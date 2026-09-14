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
  // Sent (in place of session_state) to a machine an operator has asked to
  // remove: an authenticated instruction to relinquish Taymna control. Like
  // every other server->agent message it is a fact, not a command -- it
  // carries no payload the agent could execute. The agent durably records
  // that it is no longer enrolled BEFORE acknowledging, then stops enforcing.
  // See docs/protocol.md and docs/enrollment.md "Decommissioning a machine".
  | { type: 'decommission'; serverTime: string }
  | { type: 'error'; code: string; message: string };

/**
 * `version` is optional and always will be: agents upgrade one machine at a
 * time, so a server must keep working with one that predates the field.
 * It is untrusted text from the machine's credential holder -- validated
 * and capped by `sanitizeAgentVersion` before it is stored or shown.
 */
export type AgentToServerMessage =
  | { type: 'heartbeat'; atMs: number; version?: unknown }
  // The agent confirming it has durably un-enrolled and stopped enforcing, so
  // the server may finalize removal (delete the row, invalidating the old
  // credential). Idempotent: a duplicate ack for an already-finalized machine
  // is a no-op. Carries nothing -- the machine is identified by its
  // authenticated socket, not by anything in the payload.
  | { type: 'decommission_ack' };

export type ServerToOperatorMessage =
  | {
      type: 'machine_updated';
      machineId: string;
      online: boolean;
      lastSeenAt: string | null;
      agentVersion: string | null;
    }
  | { type: 'session_updated'; machineId: string; session: SessionStateDto | null }
  // A removal has been requested but is not yet complete: the machine is now
  // "pending decommission" (waiting for the agent to relinquish control). The
  // dashboard shows it as removing/waiting rather than dropping it -- only
  // `machine_removed`, sent once the agent acknowledges, removes it.
  | { type: 'machine_decommissioning'; machineId: string }
  | { type: 'machine_removed'; machineId: string };
