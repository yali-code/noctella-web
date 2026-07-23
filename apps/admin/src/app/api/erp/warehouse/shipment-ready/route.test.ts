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

describe("shipment-ready queue proxy route (Sprint 59B)", () => {
  it("injects the ERP key server-side and forwards the backend response", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await GET();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/warehouse/shipment-ready",
      expect.objectContaining({ headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-erp-key" } }),
    );
    expect(res.status).toBe(200);
  });

  it("fails closed without exposing the key when ERP_INTEGRATION_KEY is unset", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await GET();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("test-erp-key");
  });
});
