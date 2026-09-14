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

export function useIssueEnrollmentToken() {
  return useMutation({
    mutationFn: (machineId: string) => api.issueEnrollmentToken(machineId),
  });
}

export function useRevokeCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (machineId: string) => api.revokeCredential(machineId),
    onSuccess: (machine) =>
      queryClient.setQueryData<Machine[]>(machinesQueryKey, (current) =>
        current?.map((m) => (m.id === machine.id ? machine : m)),
      ),
  });
}

export function useRenameMachine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ machineId, name }: { machineId: string; name: string }) =>
      api.renameMachine(machineId, name),
    onSuccess: (machine) =>
      queryClient.setQueryData<Machine[]>(machinesQueryKey, (current) =>
        current?.map((m) => (m.id === machine.id ? machine : m)),
      ),
  });
}

export function useDeleteMachine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (machineId: string) => api.deleteMachine(machineId),
    onSuccess: (result, machineId) =>
      queryClient.setQueryData<Machine[]>(machinesQueryKey, (current) => {
        if (!current) return current;
        // No agent to coordinate with: the machine is already gone.
        if (result.outcome === "removed") return current.filter((m) => m.id !== machineId);
        // Otherwise it is now pending decommission -- keep it on screen, marked
        // as removing/waiting, until the agent acknowledges (a `machine_removed`
        // realtime event, or a refetch, drops it then).
        return current.map((m) => (m.id === machineId ? { ...m, decommissioning: true } : m));
      }),
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
