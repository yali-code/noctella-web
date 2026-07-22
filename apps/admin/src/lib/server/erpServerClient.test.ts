import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildErpRequestHeaders,
  cancelInvoicePath,
  createInvoiceDraftPath,
  ErpServerConfigError,
  fetchErpBackend,
  financeOrderPath,
  invoicesPath,
  issueInvoicePath,
  markInvoicePaidPath,
  postErpBackend,
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

describe("createInvoiceDraftPath", () => {
  it("builds the fixed command path for the given order id", () => {
    expect(createInvoiceDraftPath("order-1")).toBe("/api/erp/commands/orders/order-1/invoices/create");
  });
});

describe("postErpBackend", () => {
  it("forwards the JSON body to the configured backend with only the injected ERP header plus Content-Type", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 201 }));
    await postErpBackend(createInvoiceDraftPath("order-1"), { idempotencyKey: "key-1", payload: {} });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/orders/order-1/invoices/create",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Noctella-ERP-Key": "test-erp-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "key-1", payload: {} }),
      }),
    );
  });

  it("preserves the backend response status and body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "inv-1" }), { status: 201, headers: { "Content-Type": "application/json" } }),
    );
    const res = await postErpBackend(createInvoiceDraftPath("order-1"), { idempotencyKey: "key-1", payload: {} });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "inv-1" });
  });

  it("fails closed when the ERP key is missing", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(createInvoiceDraftPath("order-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the backend base URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(createInvoiceDraftPath("order-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("issueInvoicePath", () => {
  it("builds the fixed command path for the given invoice id", () => {
    expect(issueInvoicePath("invoice-1")).toBe("/api/erp/commands/invoices/invoice-1/issue");
  });

  it("encodes the invoice id so it cannot break out of the fixed template", () => {
    expect(issueInvoicePath("../../etc")).toBe("/api/erp/commands/invoices/..%2F..%2Fetc/issue");
  });

  it("is forwarded correctly via the existing postErpBackend with only the injected ERP header plus Content-Type", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await postErpBackend(issueInvoicePath("invoice-1"), { idempotencyKey: "key-1", payload: {} });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/invoices/invoice-1/issue",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Noctella-ERP-Key": "test-erp-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "key-1", payload: {} }),
      }),
    );
  });

  it("fails closed when the ERP key is missing", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(issueInvoicePath("invoice-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the backend base URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(issueInvoicePath("invoice-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("markInvoicePaidPath", () => {
  it("builds the fixed command path for the given invoice id", () => {
    expect(markInvoicePaidPath("invoice-1")).toBe("/api/erp/commands/invoices/invoice-1/mark-paid");
  });

  it("encodes the invoice id so it cannot break out of the fixed template", () => {
    expect(markInvoicePaidPath("../../etc")).toBe("/api/erp/commands/invoices/..%2F..%2Fetc/mark-paid");
  });

  it("is forwarded correctly via the existing postErpBackend with only the injected ERP header plus Content-Type", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await postErpBackend(markInvoicePaidPath("invoice-1"), { idempotencyKey: "key-1", payload: {} });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/invoices/invoice-1/mark-paid",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Noctella-ERP-Key": "test-erp-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "key-1", payload: {} }),
      }),
    );
  });

  it("fails closed when the ERP key is missing", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(markInvoicePaidPath("invoice-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the backend base URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(markInvoicePaidPath("invoice-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("cancelInvoicePath", () => {
  it("builds the fixed command path for the given invoice id", () => {
    expect(cancelInvoicePath("invoice-1")).toBe("/api/erp/commands/invoices/invoice-1/cancel");
  });

  it("encodes the invoice id so it cannot break out of the fixed template", () => {
    expect(cancelInvoicePath("../../etc")).toBe("/api/erp/commands/invoices/..%2F..%2Fetc/cancel");
  });

  it("is forwarded correctly via the existing postErpBackend with only the injected ERP header plus Content-Type", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await postErpBackend(cancelInvoicePath("invoice-1"), { idempotencyKey: "key-1", payload: {} });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://backend.internal:4000/api/erp/commands/invoices/invoice-1/cancel",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Noctella-ERP-Key": "test-erp-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "key-1", payload: {} }),
      }),
    );
  });

  it("fails closed when the ERP key is missing", async () => {
    delete process.env.ERP_INTEGRATION_KEY;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(cancelInvoicePath("invoice-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the backend base URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const mockFetch = vi.spyOn(global, "fetch");
    await expect(postErpBackend(cancelInvoicePath("invoice-1"), {})).rejects.toThrow(ErpServerConfigError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
