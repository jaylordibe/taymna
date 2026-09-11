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

export interface Operator {
  id: string;
  email: string;
}
