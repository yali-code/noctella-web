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

describe("reports export proxy route (Sprint 55B) - completes the export-link flow", () => {
  it("forwards the request to the backend with the injected ERP key and the same query string", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response("id,sku\n1,ABC", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="noctella-sales-2026-01-01.csv"' } }));
    const res = await GET(new Request("http://admin.local/api/erp/reports/sales/export?format=csv&period=Last30Days"), { params: { type: "sales" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/reports/sales/export?format=csv&period=Last30Days",
      expect.objectContaining({ headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-erp-key" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("content-disposition")).toContain("noctella-sales-2026-01-01.csv");
    expect(await res.text()).toBe("id,sku\n1,ABC");
  });

  it("forwards non-ok upstream statuses instead of swallowing them", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Export row limit exceeded" }), { status: 413, headers: { "content-type": "application/json" } }));
    const res = await GET(new Request("http://admin.local/api/erp/reports/sales/export?format=json"), { params: { type: "sales" } });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("Export row limit exceeded");
  });

  it("fails closed with a clear error when the ERP key is not configured", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await GET(new Request("http://admin.local/api/erp/reports/sales/export?format=json"), { params: { type: "sales" } });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
