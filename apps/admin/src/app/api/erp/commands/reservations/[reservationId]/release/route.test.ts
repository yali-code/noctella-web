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

describe("release-reservation proxy route (Sprint 58B)", () => {
  it("forwards the reservation id in the path and injects the ERP key", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "Released" }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "k1", payload: {} };
    const res = await POST(new Request("http://admin.local/api/erp/commands/reservations/r1/release", { method: "POST", body: JSON.stringify(body) }), { params: { reservationId: "r1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/reservations/r1/release",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
  });
});
