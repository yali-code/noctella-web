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

describe("create-reservation proxy route (Sprint 58B)", () => {
  it("forwards the JSON body (including idempotencyKey) and injects the ERP key server-side", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "Succeeded", reservationId: "r1" }), { status: 201, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "stable-key", payload: { productId: "p1", quantity: 2, reservationReference: "REF", reason: "hold" } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/reservations/create", { method: "POST", body: JSON.stringify(body) }));
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/reservations/create",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body), headers: expect.objectContaining({ "X-Noctella-ERP-Key": "test-erp-key" }) }),
    );
    expect(res.status).toBe(201);
  });

  it("forwards a conflict (reservation exceeds availability) as 409, not a generic error", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Reservation exceeds available quantity" }), { status: 409, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/reservations/create", { method: "POST", body: JSON.stringify({ idempotencyKey: "k2", payload: {} }) }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("Reservation exceeds available quantity");
  });

  it("fails closed without the ERP key and never calls fetch", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    const res = await POST(new Request("http://admin.local/api/erp/commands/reservations/create", { method: "POST", body: JSON.stringify({ idempotencyKey: "k3", payload: {} }) }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});
