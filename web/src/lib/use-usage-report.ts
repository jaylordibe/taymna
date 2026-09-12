"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { toInstantRange } from "./report-range";

/**
 * Usage for two inclusive local dates. Unlike the machine list this is not
 * live: a report is a snapshot of a window you chose, and having the numbers
 * shuffle under you while reading them would be worse, not better.
 */
export function useUsageReport(from: string, to: string, enabled: boolean) {
  const range = toInstantRange(from, to);
  return useQuery({
    queryKey: ["usage-report", range.from, range.to],
    queryFn: () => api.usageReport(range.from, range.to),
    enabled,
    staleTime: 30_000,
  });
}
