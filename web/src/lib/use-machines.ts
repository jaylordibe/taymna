"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { machinesQueryKey } from "./machines-query";
import type { Machine, Platform, SessionState } from "./types";

export function useMachines(enabled: boolean) {
  return useQuery({ queryKey: machinesQueryKey, queryFn: api.listMachines, enabled });
}

function patchMachineSession(
  queryClient: ReturnType<typeof useQueryClient>,
  machineId: string,
  session: SessionState | null,
) {
  queryClient.setQueryData<Machine[]>(machinesQueryKey, (current) =>
    current?.map((m) => (m.id === machineId ? { ...m, activeSession: session } : m)),
  );
}

export function useStartSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ machineId, durationMinutes }: { machineId: string; durationMinutes: number }) =>
      api.startSession(machineId, durationMinutes),
    onSuccess: (session, { machineId }) => patchMachineSession(queryClient, machineId, session),
  });
}

export function useExtendSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      additionalMinutes,
    }: {
      sessionId: string;
      machineId: string;
      additionalMinutes: number;
    }) => api.extendSession(sessionId, additionalMinutes),
    onSuccess: (session, { machineId }) => patchMachineSession(queryClient, machineId, session),
  });
}

export function useEndSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; machineId: string }) =>
      api.endSession(sessionId),
    onSuccess: (session, { machineId }) => patchMachineSession(queryClient, machineId, session),
  });
}

export function useCreateMachine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, platform }: { name: string; platform: Platform }) =>
      api.createMachine(name, platform),
    onSuccess: (result) => {
      queryClient.setQueryData<Machine[]>(machinesQueryKey, (current) => [
        ...(current ?? []),
        result.machine,
      ]);
    },
  });
}
