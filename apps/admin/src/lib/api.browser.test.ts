// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("admin api client - Client Component (browser) context (Sprint 64B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends credentials:include on every request, since the admin app and API are cross-origin", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await api.get("/api/customers");
    const [, init] = mockFetch.mock.calls[0];
    expect(init!.credentials).toBe("include");
  });

  it("does not set a manual Cookie header - the browser attaches it itself via credentials:include", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await api.get("/api/customers");
    const [, init] = mockFetch.mock.calls[0];
    expect((init!.headers as Record<string, string>).Cookie).toBeUndefined();
  });

  it("redirects to /login (preserving the current path) via a hard navigation on a 401 response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "Authentication required" }, 401));
    Object.defineProperty(window, "location", { value: { href: "", pathname: "/customers", search: "" }, writable: true });
    await expect(api.get("/api/customers")).rejects.toBeInstanceOf(ApiError);
    expect(window.location.href).toBe("/login?next=%2Fcustomers");
  });

  it("does not redirect on a non-401 error", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "Not found" }, 404));
    Object.defineProperty(window, "location", { value: { href: "/customers", pathname: "/customers", search: "" }, writable: true });
    await expect(api.get("/api/customers")).rejects.toBeInstanceOf(ApiError);
    expect(window.location.href).toBe("/customers");
  });
});
