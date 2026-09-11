"use client";

import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import {
  clearStoredToken,
  getStoredToken,
  getStoredTokenServerSnapshot,
  setStoredToken,
  subscribeToStoredToken,
} from "./auth-storage";
import type { Operator } from "./types";

interface AuthState {
  token: string | null;
  operator: Operator | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Reads localStorage without a render/hydration mismatch: the server
  // snapshot is always null, and React re-renders with the real client
  // value right after hydrating -- no effect/setState dance needed.
  const token = useSyncExternalStore(
    subscribeToStoredToken,
    getStoredToken,
    getStoredTokenServerSnapshot,
  );
  const [operator, setOperator] = useState<Operator | null>(null);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setStoredToken(result.token);
    setOperator(result.operator);
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setOperator(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, operator, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
