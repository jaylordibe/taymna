import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
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
        agentVersion: "0.2.0",
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

  it("does not redirect an authenticated operator on a real browser hard refresh", async () => {
    // `renderPage()`'s render() mounts via createRoot, which never sees a
    // server snapshot -- it can't exercise the hydration path at all, so it
    // can't catch a bug that only exists during hydration. A real page
    // refresh does: Next.js serves prerendered HTML built with the *server*
    // snapshot (auth-storage's getStoredTokenServerSnapshot(), always null),
    // then React hydrates it. Reproduce that exact sequence here.
    window.localStorage.setItem("taymna_token", "a-token");
    listMachines.mockResolvedValueOnce([]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const app = (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </QueryClientProvider>
    );

    // Server-side render: token is unavailable server-side, so this markup
    // is what a logged-out visitor would see -- exactly what's prerendered
    // and shipped as the static HTML for "/".
    const serverHtml = renderToString(app);
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    // Client hydration of that same markup, now with a real token already
    // sitting in localStorage (the normal "already logged in" case).
    render(app, { container, hydrate: true });

    expect(await screen.findByText(/No machines yet/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();

    document.body.removeChild(container);
  });
});
