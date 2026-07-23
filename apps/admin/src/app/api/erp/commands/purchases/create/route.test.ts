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

describe("create-purchase proxy route (Sprint 57B)", () => {
  it("forwards the JSON body and injects the ERP key server-side", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "p1", status: "Draft" }), { status: 201, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "k1", payload: { supplierId: "s1", lines: [{ titleSnapshot: "Lot", quantity: 1, unitPurchaseCost: 10 }] } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/purchases/create", { method: "POST", body: JSON.stringify(body) }));
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/purchases/create",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body), headers: expect.objectContaining({ "X-Noctella-ERP-Key": "test-erp-key" }) }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe("p1");
  });

  it("forwards a validation failure from the backend", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Purchase requires at least one line" }), { status: 400, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/purchases/create", { method: "POST", body: JSON.stringify({ idempotencyKey: "k2", payload: {} }) }));
    expect(res.status).toBe(400);
  });

  it("fails closed without the ERP key and never calls fetch", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await POST(new Request("http://admin.local/api/erp/commands/purchases/create", { method: "POST", body: JSON.stringify({ idempotencyKey: "k3", payload: {} }) }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
