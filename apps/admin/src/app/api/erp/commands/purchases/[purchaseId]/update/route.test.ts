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

describe("purchase update proxy route (PHASE-1B)", () => {
  it("forwards the purchase id in the path and the body, injecting the ERP key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "p1", status: "Draft" }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "k1", payload: { invoiceReferenceNumber: "INV-1", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/purchases/p1/update", { method: "POST", body: JSON.stringify(body) }), { params: { purchaseId: "p1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/purchases/p1/update",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
  });

  it("forwards a stale-update conflict as 409, not a generic 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Purchase has changed since expectedUpdatedAt" }), { status: 409, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/purchases/p1/update", { method: "POST", body: JSON.stringify({ idempotencyKey: "k2", payload: {} }) }), { params: { purchaseId: "p1" } });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("Purchase has changed since expectedUpdatedAt");
  });
});
