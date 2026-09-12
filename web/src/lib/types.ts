export type Platform = "WINDOWS" | "LINUX" | "MACOS";
export type SessionStatus = "ACTIVE" | "EXPIRED" | "ENDED";

export interface SessionState {
  id: string;
  startedAt: string;
  expiresAt: string;
  status: SessionStatus;
  updatedAt: string;
}

export interface Machine {
  id: string;
  name: string;
  platform: Platform;
  online: boolean;
  lastSeenAt: string | null;
  activeSession: SessionState | null;
  createdAt: string;
  updatedAt: string;
}

export interface MachineUsage {
  machineId: string;
  name: string;
  platform: Platform;
  /** Seconds the machine was actually usable inside the reported window. */
  usedSeconds: number;
  sessionCount: number;
}

export interface UsageReport {
  from: string;
  to: string;
  totalUsedSeconds: number;
  machines: MachineUsage[];
}

export interface Operator {
  id: string;
  email: string;
}
