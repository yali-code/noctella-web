import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.ERP_INTEGRATION_KEY = "test-erp-key";
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.internal:4000";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("execute-merge proxy route (Sprint 61B)", () => {
  it("forwards the JSON body (including the idempotency key) and injects the ERP key server-side", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "Completed", idempotent: false }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "merge-1", payload: { sourceCustomerId: "a", targetCustomerId: "b" } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/customers/merge", { method: "POST", body: JSON.stringify(body) }));
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/customers/merge",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body), headers: expect.objectContaining({ "X-Noctella-ERP-Key": "test-erp-key" }) }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).idempotent).toBe(false);
  });

  it("forwards a conflict from the backend", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Idempotency key was already used with a different payload" }), { status: 409, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/customers/merge", { method: "POST", body: JSON.stringify({ idempotencyKey: "k", payload: {} }) }));
    expect(res.status).toBe(409);
  });

  it("fails closed without the ERP key and never calls fetch", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await POST(new Request("http://admin.local/api/erp/commands/customers/merge", { method: "POST", body: JSON.stringify({ idempotencyKey: "k", payload: {} }) }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("test-erp-key");
  });
});
