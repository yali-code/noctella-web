import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CustomersPage from "@/app/customers/page";
import CustomerDetailPage from "@/app/customers/[id]/page";
import CustomerNotesPage from "@/app/customers/[id]/notes/page";
import CustomerTimelinePage from "@/app/customers/[id]/timeline/page";
import CustomerAnalyticsPage from "@/app/customers/[id]/analytics/page";
import CustomerPreferencesPage from "@/app/customers/[id]/preferences/page";
import { executeMerge, searchMergeCandidates } from "../erpCustomerBridge";
import { customerApi } from "./erpCustomerServer";

const base = "https://erp.example.test";
const testKey = "test-only-erp-key";
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", base);
  vi.stubEnv("ERP_INTEGRATION_KEY", testKey);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("customer server rendering through the real ERP client", () => {
  const cases = [
    { name: "list", page: () => CustomersPage(), path: "", body: { items: [{ id: "c1", name: "Ada" }] }, text: "Ada" },
    { name: "detail", page: CustomerDetailPage, path: "/c1", body: { id: "c1", name: "Ada" }, text: "Ada" },
    { name: "notes", page: CustomerNotesPage, path: "/c1/notes", body: { items: [{ id: "n1", version: 1, body: "[REDACTED]" }] }, text: "[REDACTED]" },
    { name: "timeline", page: CustomerTimelinePage, path: "/c1/history", body: { items: [{ type: "Order", entityId: "o1" }] }, text: "Order o1" },
    { name: "analytics", page: CustomerAnalyticsPage, path: "/c1/statistics", body: { orderCount: 2 }, text: "Order count: 2" },
    { name: "preferences", page: CustomerPreferencesPage, path: "/c1/preferences", body: { language: "en" }, text: "Language: en" },
  ];

  it.each(cases)("$name uses an absolute authenticated no-store request", async ({ page, path, body, text }) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      // Node fetch rejects a relative URL. Enforce that same boundary without network I/O.
      const url = new URL(String(input));
      expect(url.origin).toBe(base);
      return json(body);
    });
    const html = renderToStaticMarkup(await page({ params: { id: "c1" } }));
    expect(html).toContain(text);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(testKey);
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(`${base}/api/erp/customers${path}`, {
      method: "GET",
      cache: "no-store",
      headers: expect.objectContaining({ "X-Noctella-ERP-Key": testKey, "X-Noctella-ERP-Client-Version": expect.any(String) }),
    });
  });

  it("preserves query strings and encodes customer identifiers with the existing builders", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({}));
    await customerApi.list("search=Ada&page=2");
    await customerApi.detail("customer/with space");
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      `${base}/api/erp/customers?search=Ada&page=2`,
      `${base}/api/erp/customers/customer%2Fwith%20space`,
    ]);
  });

  it("preserves non-2xx status/details and redacts backend error messages", async () => {
    const details = [{ path: "id", message: "Unknown customer" }];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "Denied token=sensitive", details }, 403));
    await expect(customerApi.detail("c1")).rejects.toMatchObject({ status: 403, details, message: "Denied token=[REDACTED]" });
    const html = renderToStaticMarkup(await CustomersPage());
    expect(html).toContain("Denied token=[REDACTED]");
    expect(html).not.toContain("sensitive");
  });

  it("uses statusText for non-JSON errors without exposing raw response bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private upstream data", { status: 502, statusText: "Bad Gateway" }));
    await expect(customerApi.list()).rejects.toMatchObject({ status: 502, message: "Bad Gateway" });
  });

  it("fails closed when the server key is missing", async () => {
    vi.stubEnv("ERP_INTEGRATION_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(customerApi.list()).rejects.toMatchObject({ status: 500, message: "ERP backend is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not expose transport error details in rendered output", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`transport failure ${testKey}`));
    const html = renderToStaticMarkup(await CustomersPage());
    expect(html).toContain("ERP backend is not configured");
    expect(html).not.toContain(testKey);
  });

  it("keeps merge operations on same-origin proxies with no ERP key in browser requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({}));
    await searchMergeCandidates({ email: "ada@example.test" });
    await executeMerge({ sourceCustomerId: "c1", targetCustomerId: "c2", idempotencyKey: "test-attempt" });
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/api/erp/commands/customers/merge-candidates",
      "/api/erp/commands/customers/merge",
    ]);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.stringify(init)).not.toContain(testKey);
    }
  });
});
