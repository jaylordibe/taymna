import { getStoredToken } from "./auth-storage";
import type { Machine, Operator, Platform, SessionState, UsageReport } from "./types";

/**
 * The result of requesting removal. `removed` means the machine had no enrolled
 * agent to coordinate with and is already gone; `decommissioning` means the
 * agent is being asked to relinquish control and the machine is now pending.
 */
export type RemoveMachineResult =
  | { outcome: "removed" }
  | { outcome: "decommissioning"; machine: Machine };

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = Array.isArray(body?.message)
      ? body.message.join(", ")
      : (body?.message ?? res.statusText);
    throw new ApiError(res.status, message);
  }

  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; operator: Operator }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  listMachines: () => request<Machine[]>("/machines"),

  createMachine: (name: string, platform: Platform) =>
    request<{ machine: Machine; enrollmentToken: string; expiresAt: string }>("/machines", {
      method: "POST",
      body: JSON.stringify({ name, platform }),
    }),

  issueEnrollmentToken: (machineId: string) =>
    request<{ token: string; expiresAt: string }>(`/machines/${machineId}/enrollment-tokens`, {
      method: "POST",
    }),

  renameMachine: (machineId: string, name: string) =>
    request<Machine>(`/machines/${machineId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  revokeCredential: (machineId: string) =>
    request<Machine>(`/machines/${machineId}/credential`, { method: "DELETE" }),

  deleteMachine: (machineId: string) =>
    request<RemoveMachineResult>(`/machines/${machineId}`, { method: "DELETE" }),

  startSession: (machineId: string, durationMinutes: number) =>
    request<SessionState>(`/machines/${machineId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ durationMinutes }),
    }),

  extendSession: (sessionId: string, additionalMinutes: number) =>
    request<SessionState>(`/sessions/${sessionId}/extend`, {
      method: "POST",
      body: JSON.stringify({ additionalMinutes }),
    }),

  endSession: (sessionId: string) =>
    request<SessionState>(`/sessions/${sessionId}/end`, { method: "POST" }),

  usageReport: (from: string, to: string) =>
    request<UsageReport>(
      `/reports/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
};
