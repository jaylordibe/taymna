"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "./api";
import type { Machine, SessionState } from "./types";
import { machinesQueryKey } from "./machines-query";

type ServerToOperatorMessage =
  | { type: "machine_updated"; machineId: string; online: boolean; lastSeenAt: string | null }
  | { type: "session_updated"; machineId: string; session: SessionState | null }
  | { type: "machine_removed"; machineId: string };

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

function toWsUrl(apiUrl: string): string {
  if (apiUrl.startsWith("https://")) return `wss://${apiUrl.slice("https://".length)}/ws`;
  if (apiUrl.startsWith("http://")) return `ws://${apiUrl.slice("http://".length)}/ws`;
  return `wss://${apiUrl}/ws`;
}

/**
 * One WebSocket connection per dashboard session, driving React Query cache
 * updates directly from server pushes -- no polling. Reconnects with
 * backoff on any drop, same shape as the agent's own client (see
 * agent/src/client.rs) since both sides of this protocol should behave
 * predictably the same way.
 */
export function useRealtime(token: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token) return;
    const authToken = token;

    let socket: WebSocket | null = null;
    let backoff = MIN_BACKOFF_MS;
    let closedByEffect = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      socket = new WebSocket(`${toWsUrl(API_URL)}?token=${encodeURIComponent(authToken)}`);

      socket.onopen = () => {
        backoff = MIN_BACKOFF_MS;
      };

      socket.onmessage = (event) => {
        let message: ServerToOperatorMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        queryClient.setQueryData<Machine[]>(machinesQueryKey, (current) => {
          if (!current) return current;
          if (message.type === "machine_updated") {
            return current.map((m) =>
              m.id === message.machineId
                ? { ...m, online: message.online, lastSeenAt: message.lastSeenAt }
                : m,
            );
          }
          if (message.type === "session_updated") {
            return current.map((m) =>
              m.id === message.machineId ? { ...m, activeSession: message.session } : m,
            );
          }
          if (message.type === "machine_removed") {
            return current.filter((m) => m.id !== message.machineId);
          }
          return current;
        });
      };

      socket.onclose = () => {
        if (closedByEffect) return;
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    }

    connect();

    return () => {
      closedByEffect = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [token, queryClient]);
}
