"use client";

import { useEffect, useState } from "react";

/** Re-renders every `intervalMs` so remaining-time labels stay fresh -- pure
 * client-side display math, never a server request. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
