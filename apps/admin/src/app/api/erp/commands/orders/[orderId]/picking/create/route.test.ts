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

describe("create-picking-task proxy route (Sprint 59B)", () => {
  it("forwards the order id in the path and the JSON body, injecting the ERP key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "Succeeded", pickingTaskId: "t1" }), { status: 201, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "k1", payload: { safeNotes: "note" } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/orders/o1/picking/create", { method: "POST", body: JSON.stringify(body) }), { params: { orderId: "o1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/orders/o1/picking/create",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body), headers: expect.objectContaining({ "X-Noctella-ERP-Key": "test-erp-key" }) }),
    );
    expect(res.status).toBe(201);
  });

  it("forwards a duplicate-task conflict as 409, not a generic 500", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "An active picking task already exists for this order" }), { status: 409, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/orders/o1/picking/create", { method: "POST", body: JSON.stringify({ idempotencyKey: "k2", payload: {} }) }), { params: { orderId: "o1" } });
    expect(res.status).toBe(409);
  });

  it("fails closed without the ERP key and never calls fetch", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await POST(new Request("http://admin.local/api/erp/commands/orders/o1/picking/create", { method: "POST", body: JSON.stringify({ idempotencyKey: "k3", payload: {} }) }), { params: { orderId: "o1" } });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
