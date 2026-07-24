// Default (node) vitest environment deliberately - no jsdom, so `window` is genuinely undefined,
// exercising api.ts's server-side (Server Component) code path the same way real SSR does.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (name === "noctella_admin_session" ? { value: "server-side-token" } : undefined),
  }),
}));

import { api } from "./api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("admin api client - Server Component context (Sprint 64B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards the incoming request's session cookie manually via next/headers, since the browser is never involved in a server-side fetch", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await api.get("/api/customers");
    const [, init] = mockFetch.mock.calls[0];
    expect((init!.headers as Record<string, string>).Cookie).toBe("noctella_admin_session=server-side-token");
  });

  it("does not set credentials:include server-side (meaningless outside a browser fetch)", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await api.get("/api/customers");
    const [, init] = mockFetch.mock.calls[0];
    expect(init!.credentials).toBeUndefined();
  });
});
