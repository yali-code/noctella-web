import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildErpRequestHeaders,
  ErpServerConfigError,
  fetchErpBackend,
  financeOrderPath,
  invoicesPath,
  salesSummaryPath,
} from "./erpServerClient";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ERP_INTEGRATION_KEY = "test-erp-key";
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://backend.internal:4000";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("path builders", () => {
  it("build the known, fixed backend path for each endpoint", () => {
    expect(salesSummaryPath("order-1")).toBe("/api/erp/orders/order-1/sales-summary");
    expect(invoicesPath("order-1")).toBe("/api/erp/orders/order-1/invoices");
    expect(financeOrderPath("order-1")).toBe("/api/erp/finance/orders/order-1");
  });

  it("encode the order id so it cannot break out of the fixed template", () => {
    expect(salesSummaryPath("../../etc")).toBe("/api/erp/orders/..%2F..%2Fetc/sales-summary");
  });
});

describe("buildErpRequestHeaders", () => {
  it("contains only Accept and the injected ERP key header", () => {
    const headers = buildErpRequestHeaders();
    expect(Object.keys(headers).sort()).toEqual(["Accept", "X-Noctella-ERP-Key"]);
    expect(headers["X-Noctella-ERP-Key"]).toBe("test-erp-key");
  });

  it("fails closed when the ERP key is missing", () => {
    delete process.env.ERP_INTEGRATION_KEY;
    expect(() => buildErpRequestHeaders()).toThrow(ErpServerConfigError);
  });
});

describe("fetchErpBackend", () => {
  it("calls the configured backend base URL with only the injected ERP header", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchErpBackend(salesSummaryPath("order-1"));
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/orders/order-1/sales-summary",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json", "X-Noctella-ERP-Key": "test-erp-key" },
      }),
    );
  });

  it("fails closed when the ERP key is missing", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(fetchErpBackend(salesSummaryPath("order-1"))).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the backend base URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(fetchErpBackend(salesSummaryPath("order-1"))).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
