import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { getCurrentAdmin, login, logout, safeNextPath } from "./auth";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const mockedApi = vi.mocked(api);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("admin auth lib (Sprint 64B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("login posts credentials directly with credentials:include, bypassing the shared api client", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ id: "1", email: "a@b.com", role: "owner", status: "active" }));
    const result = await login("a@b.com", "password");
    expect(result.email).toBe("a@b.com");
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/auth/login");
    expect(init!.credentials).toBe("include");
    expect(JSON.parse(init!.body as string)).toEqual({ email: "a@b.com", password: "password" });
  });

  it("login throws a structured ApiError on failure with the backend's message", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "Invalid email or password" }, 401));
    await expect(login("a@b.com", "wrong")).rejects.toMatchObject({ status: 401, message: "Invalid email or password" });
  });

  it("logout calls the shared api client", async () => {
    mockedApi.post.mockResolvedValueOnce({ ok: true });
    await logout();
    expect(mockedApi.post).toHaveBeenCalledWith("/api/auth/logout", {});
  });

  it("getCurrentAdmin returns the identity on success", async () => {
    mockedApi.get.mockResolvedValueOnce({ id: "1", email: "a@b.com", role: "owner", status: "active" });
    const result = await getCurrentAdmin();
    expect(result?.email).toBe("a@b.com");
  });

  it("getCurrentAdmin returns null (not a throw) when unauthenticated", async () => {
    mockedApi.get.mockRejectedValueOnce(new Error("401"));
    expect(await getCurrentAdmin()).toBeNull();
  });

  it("safeNextPath allows a relative path", () => {
    expect(safeNextPath("/customers/c1")).toBe("/customers/c1");
  });

  it("safeNextPath rejects an absolute external URL", () => {
    expect(safeNextPath("https://evil.example.com")).toBe("/");
  });

  it("safeNextPath rejects a protocol-relative URL", () => {
    expect(safeNextPath("//evil.example.com")).toBe("/");
  });

  it("safeNextPath defaults to / for null/empty/non-relative input", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("relative-no-slash")).toBe("/");
  });
});
