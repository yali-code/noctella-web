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

describe("packing detail proxy route (Sprint 59B)", () => {
  it("forwards the packing task id and injects the ERP key server-side", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "p1", lines: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await GET(new Request("http://admin.local/api/erp/packing/p1"), { params: { id: "p1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/packing/p1",
      expect.objectContaining({ headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-erp-key" } }),
    );
    expect(res.status).toBe(200);
  });

  it("forwards a 404 from the backend", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Packing task not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    const res = await GET(new Request("http://admin.local/api/erp/packing/missing"), { params: { id: "missing" } });
    expect(res.status).toBe(404);
  });
});
