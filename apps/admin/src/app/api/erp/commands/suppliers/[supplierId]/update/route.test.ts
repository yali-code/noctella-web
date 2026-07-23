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

describe("update-supplier proxy route (Sprint 57B)", () => {
  it("forwards the supplier id in the path and the expectedUpdatedAt field in the body", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "s1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "k1", payload: { name: "Renamed", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/suppliers/s1/update", { method: "POST", body: JSON.stringify(body) }), { params: { supplierId: "s1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/suppliers/s1/update",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
  });

  it("forwards a conflict when the supplier changed since load", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Supplier has changed since expectedUpdatedAt" }), { status: 409, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/suppliers/s1/update", { method: "POST", body: JSON.stringify({ idempotencyKey: "k2", payload: {} }) }), { params: { supplierId: "s1" } });
    expect(res.status).toBe(409);
  });
});
