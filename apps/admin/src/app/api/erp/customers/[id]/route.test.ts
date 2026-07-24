import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.ERP_INTEGRATION_KEY = "test-erp-key";
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.internal:4000";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("customer detail proxy route (Sprint 61B)", () => {
  it("forwards the customer id and injects the ERP key server-side", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "c1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await GET(new Request("http://admin.local/api/erp/customers/c1"), { params: { id: "c1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/customers/c1",
      expect.objectContaining({ headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-erp-key" } }),
    );
    expect(res.status).toBe(200);
  });

  it("forwards a 404 from the backend", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    const res = await GET(new Request("http://admin.local/api/erp/customers/missing"), { params: { id: "missing" } });
    expect(res.status).toBe(404);
  });

  it("fails closed without exposing the key when ERP_INTEGRATION_KEY is unset", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await GET(new Request("http://admin.local/api/erp/customers/c1"), { params: { id: "c1" } });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("test-erp-key");
  });
});
