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
  /** Version the agent last reported; null for one too old to report it. */
  agentVersion: string | null;
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

/**
 * One session behind a report total. `startedAt`/`endedAt` are the session's
 * real bounds; `usedSeconds` is clipped to the reported window.
 */
export interface ReportedSession {
  machineId: string;
  startedAt: string;
  endedAt: string;
  status: SessionStatus;
  usedSeconds: number;
}

export interface UsageReport {
  from: string;
  to: string;
  totalUsedSeconds: number;
  machines: MachineUsage[];
  sessions: ReportedSession[];
}

export interface Operator {
  id: string;
  email: string;
}
