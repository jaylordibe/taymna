import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { AuthProvider } from "@/lib/auth-context";
import DashboardPage from "./page";
import type { Machine } from "@/lib/types";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const listMachines = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { listMachines: () => listMachines() },
  API_URL: "http://localhost:3000",
  ApiError: class extends Error {},
}));

// jsdom has no real WebSocket server to connect to; the hook degrades to
// "never connects", which is fine for these page-composition tests.
class NoopWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
}
vi.stubGlobal("WebSocket", NoopWebSocket);

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    replace.mockClear();
    listMachines.mockClear();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("redirects to /login when there is no stored session", async () => {
    renderPage();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(listMachines).not.toHaveBeenCalled();
  });

  it("renders the machine list for an already-authenticated operator", async () => {
    window.localStorage.setItem("taymna_token", "a-token");
    const machines: Machine[] = [
      {
        id: "m1",
        name: "PC-01",
        platform: "WINDOWS",
        online: true,
        lastSeenAt: new Date().toISOString(),
        activeSession: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    listMachines.mockResolvedValueOnce(machines);

    renderPage();

    expect(await screen.findByText("PC-01")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the empty state when the operator has no machines yet", async () => {
    window.localStorage.setItem("taymna_token", "a-token");
    listMachines.mockResolvedValueOnce([]);

    renderPage();

    expect(await screen.findByText(/No machines yet/)).toBeInTheDocument();
  });
});
