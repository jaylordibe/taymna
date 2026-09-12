"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { getStoredToken } from "@/lib/auth-storage";
import { UsageReportView } from "@/components/usage-report";

export default function ReportsPage() {
  const { token } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // Same reasoning as the dashboard: read the live value, not the `token`
    // closed over from a render that may predate hydration.
    if (!getStoredToken()) router.replace("/login");
  }, [token, router]);

  if (!token) return null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink">Usage</h1>
        <Link href="/" className="text-sm text-ink-soft hover:text-ink">
          Machines
        </Link>
      </header>

      <UsageReportView />

      <p className="text-xs text-ink-soft">
        Time each machine was actually usable — a session ended early counts only up to when it was
        ended, and a running session only up to now.
      </p>
    </main>
  );
}
