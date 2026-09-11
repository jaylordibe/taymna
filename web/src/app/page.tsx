"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getStoredToken } from "@/lib/auth-storage";
import { useMachines } from "@/lib/use-machines";
import { useRealtime } from "@/lib/use-realtime";
import { MachineCard } from "@/components/machine-card";
import { AddMachinePanel } from "@/components/add-machine-panel";

export default function DashboardPage() {
  const { token, logout } = useAuth();
  const router = useRouter();
  const machinesQuery = useMachines(!!token);
  useRealtime(token);

  useEffect(() => {
    // Read the real, current value here rather than trusting the `token`
    // closed over from render: on the hydration commit, `token` is still
    // the server snapshot (always null, see auth-storage.ts) even for an
    // already-authenticated operator, and this effect can fire with that
    // stale value before useSyncExternalStore's post-hydration correction
    // lands -- redirecting a logged-in operator to /login on every refresh.
    if (!getStoredToken()) router.replace("/login");
  }, [token, router]);

  if (!token) return null;

  const machines = machinesQuery.data ?? [];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink">Taymna</h1>
        <button type="button" onClick={logout} className="text-sm text-ink-soft hover:text-ink">
          Sign out
        </button>
      </header>

      {machinesQuery.isLoading && <p className="text-sm text-ink-soft">Loading machines…</p>}

      {machinesQuery.isError && (
        <p className="text-sm text-brick">Couldn&apos;t load machines. Refresh to try again.</p>
      )}

      {!machinesQuery.isLoading && machines.length === 0 && (
        <p className="text-sm text-ink-soft">
          No machines yet. Add one below and install the agent on it to get started.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {machines.map((machine) => (
          <MachineCard key={machine.id} machine={machine} />
        ))}
      </div>

      <AddMachinePanel />
    </main>
  );
}
