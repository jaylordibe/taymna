import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { getStoredToken, setStoredToken } from "./auth-storage";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api request auth handling", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("clears an expired token when an authenticated request 401s", async () => {
    setStoredToken("dead-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(401, { message: "Unauthorized" }),
    );

    await expect(api.listMachines()).rejects.toBeInstanceOf(ApiError);
    // The dead token is dropped so the auth store subscription fires and the
    // pages fall back to /login.
    expect(getStoredToken()).toBeNull();
  });

  it("does not clear the token on a non-401 error", async () => {
    setStoredToken("good-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(500, { message: "Server error" }),
    );

    await expect(api.listMachines()).rejects.toBeInstanceOf(ApiError);
    expect(getStoredToken()).toBe("good-token");
  });

  it("does not touch storage on a login 401 (no token was sent)", async () => {
    // A wrong-credentials 401 during login carries no stored token; it must
    // not be misread as an expired session.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(401, { message: "Invalid email or password" }),
    );

    await expect(api.login("a@b.com", "nope")).rejects.toBeInstanceOf(ApiError);
    expect(getStoredToken()).toBeNull();
  });
});
