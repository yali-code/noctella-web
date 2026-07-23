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

describe("warehouse locations proxy route (Sprint 58B)", () => {
  it("forwards the query string and injects the ERP key server-side", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await GET(new Request("http://admin.local/api/erp/warehouse/locations?warehouseId=w1"));
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/warehouse/locations?warehouseId=w1",
      expect.objectContaining({ headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-erp-key" } }),
    );
    expect(res.status).toBe(200);
  });
});
