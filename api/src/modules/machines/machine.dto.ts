import { $Enums } from '../../generated/prisma/client.js';
import { SessionStateDto } from '../realtime/protocol.js';

export interface MachineDto {
  id: string;
  name: string;
  platform: $Enums.Platform;
  online: boolean;
  /**
   * True once an operator has requested removal and the machine is waiting for
   * its agent to relinquish control and acknowledge. The row still exists (and
   * still authenticates) until that handshake completes; the dashboard shows
   * such a machine as removing/waiting rather than managed.
   */
  decommissioning: boolean;
  lastSeenAt: string | null;
  /** Version the agent last reported; null for one too old to report it. */
  agentVersion: string | null;
  activeSession: SessionStateDto | null;
  createdAt: string;
  updatedAt: string;
}
