import { getStoredToken } from "./auth-storage";
import type { Machine, Operator, Platform, SessionState } from "./types";

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
};
