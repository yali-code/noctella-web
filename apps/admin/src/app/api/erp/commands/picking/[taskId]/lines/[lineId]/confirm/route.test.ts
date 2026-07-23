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

describe("confirm-picked-line proxy route (Sprint 59B)", () => {
  it("forwards both the task id and line id from the path, and the body", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "Succeeded" }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { idempotencyKey: "k1", payload: { pickedQuantity: 2 } };
    const res = await POST(new Request("http://admin.local/api/erp/commands/picking/t1/lines/l1/confirm", { method: "POST", body: JSON.stringify(body) }), { params: { taskId: "t1", lineId: "l1" } });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/picking/t1/lines/l1/confirm",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    expect(res.status).toBe(200);
  });

  it("forwards a quantity-validation rejection as 400", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "pickedQuantity cannot exceed requestedQuantity" }), { status: 400, headers: { "content-type": "application/json" } }));
    const res = await POST(new Request("http://admin.local/api/erp/commands/picking/t1/lines/l1/confirm", { method: "POST", body: JSON.stringify({ idempotencyKey: "k2", payload: { pickedQuantity: 99 } }) }), { params: { taskId: "t1", lineId: "l1" } });
    expect(res.status).toBe(400);
  });
});
