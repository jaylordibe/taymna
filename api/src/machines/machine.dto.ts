import { $Enums } from '../generated/prisma/client.js';
import { SessionStateDto } from '../realtime/protocol.js';

export interface MachineDto {
  id: string;
  name: string;
  platform: $Enums.Platform;
  online: boolean;
  lastSeenAt: string | null;
  activeSession: SessionStateDto | null;
  createdAt: string;
  updatedAt: string;
}
