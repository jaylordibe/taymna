"use client";

import { useEffect } from "react";

/** App-shell caching only -- this dashboard is inherently live/online data,
 * not an offline-first app. Registered client-side so it never blocks
 * first paint or SSR. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Installability is a nice-to-have, not a requirement -- fail silently.
      });
    }
  }, []);

  return null;
}
