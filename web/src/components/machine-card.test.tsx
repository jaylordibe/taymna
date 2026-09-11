import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { MachineCard } from "./machine-card";
import type { Machine } from "@/lib/types";

const startSession = vi.fn();
const extendSession = vi.fn();
const endSession = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    startSession: (...args: unknown[]) => startSession(...args),
    extendSession: (...args: unknown[]) => extendSession(...args),
    endSession: (...args: unknown[]) => endSession(...args),
  },
  API_URL: "http://localhost:3000",
  ApiError: class extends Error {},
}));

const availableMachine: Machine = {
  id: "machine-1",
  name: "PC-01",
  platform: "WINDOWS",
  online: true,
  lastSeenAt: new Date().toISOString(),
  activeSession: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const activeMachine: Machine = {
  ...availableMachine,
  id: "machine-2",
  name: "PC-02",
  activeSession: {
    id: "session-1",
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    status: "ACTIVE",
    updatedAt: new Date().toISOString(),
  },
};

describe("MachineCard", () => {
  beforeEach(() => {
    startSession.mockClear();
    extendSession.mockClear();
    endSession.mockClear();
  });

  it("shows Available and starts a session with a preset duration", async () => {
    startSession.mockResolvedValueOnce({
      id: "session-new",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      status: "ACTIVE",
      updatedAt: new Date().toISOString(),
    });

    renderWithProviders(<MachineCard machine={availableMachine} />);
    expect(screen.getByText("Available")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Start session" }));
    await userEvent.click(screen.getByRole("button", { name: "1 hour" }));

    await waitFor(() => expect(startSession).toHaveBeenCalledWith("machine-1", 60));
  });

  it("shows the remaining time and extends the session by a preset amount", async () => {
    extendSession.mockResolvedValueOnce({
      id: "session-1",
      startedAt: activeMachine.activeSession!.startedAt,
      expiresAt: new Date(Date.now() + 75 * 60_000).toISOString(),
      status: "ACTIVE",
      updatedAt: new Date().toISOString(),
    });

    renderWithProviders(<MachineCard machine={activeMachine} />);
    expect(screen.getByText(/remaining/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "+30 min" }));

    await waitFor(() => expect(extendSession).toHaveBeenCalledWith("session-1", 30));
  });

  it("ends the active session immediately", async () => {
    endSession.mockResolvedValueOnce({
      id: "session-1",
      startedAt: activeMachine.activeSession!.startedAt,
      expiresAt: activeMachine.activeSession!.expiresAt,
      status: "ENDED",
      updatedAt: new Date().toISOString(),
    });

    renderWithProviders(<MachineCard machine={activeMachine} />);
    await userEvent.click(screen.getByRole("button", { name: "End session" }));

    await waitFor(() => expect(endSession).toHaveBeenCalledWith("session-1"));
  });
});
