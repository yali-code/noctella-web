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

describe("merge-candidates proxy route (Sprint 61B)", () => {
  it("forwards the JSON body and injects the ERP key server-side", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ candidates: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { payload: { email: "ada@example.com" } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/customers/merge-candidates", { method: "POST", body: JSON.stringify(body) }));
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/customers/merge-candidates",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body), headers: expect.objectContaining({ "X-Noctella-ERP-Key": "test-erp-key" }) }),
    );
    expect(res.status).toBe(200);
  });

  it("forwards non-ok upstream statuses", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/customers/merge-candidates", { method: "POST", body: JSON.stringify({ payload: {} }) }));
    expect(res.status).toBe(500);
  });

  it("fails closed without the ERP key and never calls fetch", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await POST(new Request("http://admin.local/api/erp/commands/customers/merge-candidates", { method: "POST", body: JSON.stringify({ payload: {} }) }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("test-erp-key");
  });
});
