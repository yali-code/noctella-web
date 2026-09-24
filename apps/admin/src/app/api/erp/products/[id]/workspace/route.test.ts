import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
beforeEach(() => {
  vi.stubEnv("ERP_INTEGRATION_KEY", "test-only-key");
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://backend.example.test");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const request = () => new Request("https://admin.example.test/api/erp/products/p/workspace", { headers: { "X-Noctella-ERP-Key": "untrusted", Cookie: "untrusted", Authorization: "Bearer untrusted" } });
describe("product workspace ERP proxy", () => {
  it("uses encoded fixed paths and server-only credentials without forwarding browser headers", async () => {
    const body = { productId: "p", purchaseSource: "Kleinanzeigen" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
    const response = await GET(request(), { params: { id: "p/with space" } });
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("https://backend.example.test/api/erp/products/p%2Fwith%20space/workspace", {
      method: "GET", cache: "no-store", headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-only-key", "X-Noctella-ERP-Client-Version": "0.1.0" },
    });
    expect(await response.json()).toEqual(body);
    expect(response.headers.has("X-Noctella-ERP-Key")).toBe(false);
  });
  it("preserves upstream errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const response = await GET(request(), { params: { id: "p" } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
  it("fails closed without a configured backend URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    expect((await GET(request(), { params: { id: "p" } })).status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("fails closed without a configured key and redacts transport failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("ERP_INTEGRATION_KEY", "");
    expect((await GET(request(), { params: { id: "p" } })).status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.stubEnv("ERP_INTEGRATION_KEY", "test-only-key");
    fetchSpy.mockRejectedValue(new Error("test-only-key"));
    const response = await GET(request(), { params: { id: "p" } });
    expect(await response.text()).not.toContain("test-only-key");
  });
});
