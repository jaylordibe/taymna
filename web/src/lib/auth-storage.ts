// Bearer token kept in localStorage (not an httpOnly cookie) so this
// LAN-facing PWA never carries ambient credentials -- no cookies means no
// CSRF surface, at the cost of XSS being the residual risk, which Next.js's
// default output escaping mitigates (see docs/security.md).
const STORAGE_KEY = "taymna_token";
const listeners = new Set<() => void>();

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

/** Matches the server-rendered value so useSyncExternalStore never sees a
 * hydration mismatch -- the client re-syncs to the real value right after. */
export function getStoredTokenServerSnapshot(): null {
  return null;
}

export function setStoredToken(token: string): void {
  window.localStorage.setItem(STORAGE_KEY, token);
  notify();
}

export function clearStoredToken(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Powers useSyncExternalStore in auth-context: notifies on our own writes
 * (localStorage's own "storage" event only fires in *other* tabs) and also
 * forwards cross-tab "storage" events, so signing out in one tab signs out
 * every open tab. */
export function subscribeToStoredToken(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
