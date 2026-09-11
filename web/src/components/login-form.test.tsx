import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { LoginForm } from "./login-form";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const { MockApiError, login } = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { MockApiError, login: vi.fn() };
});

vi.mock("@/lib/api", () => ({
  api: { login: (...args: unknown[]) => login(...args) },
  ApiError: MockApiError,
  API_URL: "http://localhost:3000",
}));

describe("LoginForm", () => {
  beforeEach(() => {
    replace.mockClear();
    login.mockClear();
    window.localStorage.clear();
  });

  it("signs the operator in and redirects to the dashboard", async () => {
    login.mockResolvedValueOnce({
      token: "a-token",
      operator: { id: "1", email: "admin@example.com" },
    });

    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("Email"), "admin@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(login).toHaveBeenCalledWith("admin@example.com", "correct-password");
    expect(window.localStorage.getItem("taymna_token")).toBe("a-token");
  });

  it("shows the server's error message and does not redirect on failed login", async () => {
    login.mockRejectedValueOnce(new MockApiError(401, "Invalid email or password"));

    renderWithProviders(<LoginForm />);
    await userEvent.type(screen.getByLabelText("Email"), "admin@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
