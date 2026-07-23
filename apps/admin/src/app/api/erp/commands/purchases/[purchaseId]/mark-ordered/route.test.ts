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

describe("mark-ordered proxy route (Sprint 57B)", () => {
  it("forwards the purchase id in the path and the body, injecting the ERP key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "p1", status: "Ordered" }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "k1", payload: {} };
    const res = await POST(new Request("http://admin.local/api/erp/commands/purchases/p1/mark-ordered", { method: "POST", body: JSON.stringify(body) }), { params: { purchaseId: "p1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/purchases/p1/mark-ordered",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
  });

  it("forwards an invalid-transition rejection as 400, not a generic 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Invalid purchase status transition" }), { status: 400, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/purchases/p1/mark-ordered", { method: "POST", body: JSON.stringify({ idempotencyKey: "k2", payload: {} }) }), { params: { purchaseId: "p1" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid purchase status transition");
  });
});
