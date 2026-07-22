import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { buildSalesFinanceQuery, createInvoiceDraft, invoiceActionEligibility, invoiceCommand, mapFinanceSummary, mapInvoice, mapRefundSummary, mapReversalSummary, mapSale, maskCustomer, redactSafeError } from "./erpSalesFinanceBridge";

describe("erpSalesFinanceBridge admin mappings", () => {
  it("maps sales list and sale detail with masked customers and adjusted completeness", () => { const sale=mapSale({centralOrderId:"o1",orderNumber:"N1",channel:"Internal",customer:{email:"a@example.com"},financials:{grossRevenue:10,adjustedProfit:null,adjustedCompleteness:"Incomplete"},invoiceStatus:"Draft"}); expect(sale.customer.email).toBe("[redacted]"); expect(sale.href).toBe("/orders/o1"); expect(sale.completeness).toBe("Incomplete"); expect(maskCustomer({maskedEmail:"a***@x"}).email).toBe("a***@x"); });
  it("maps invoice list/detail and order/customer/invoice links", () => { const inv=mapInvoice({id:"i1",orderId:"o1",customerId:"c1",status:"Draft",invoiceType:"SalesInvoice",totalAmount:12,issuedAt:"2026-01-01"}); expect(inv.href).toBe("/invoices/i1"); expect(inv.orderHref).toBe("/orders/o1"); expect(inv.customerId).toBe("c1"); expect(inv.total).toBe("€12.00"); });
  it("computes action eligibility by status", () => { expect(invoiceActionEligibility({status:"Draft"})).toMatchObject({update:true,issue:true,cancel:true,markPaid:false}); expect(invoiceActionEligibility({status:"Issued"})).toMatchObject({update:false,issue:false,cancel:true,void:true,markPaid:true}); expect(invoiceActionEligibility({status:"Paid"}).cancel).toBe(false); });
  it("builds draft/update/issue/cancel/paid command wrappers", () => { expect(invoiceCommand("draft",{notes:"x"})).toEqual({idempotencyKey:"draft",payload:{notes:"x"}}); expect(invoiceCommand("issue",{invoiceNumber:"N"}).payload.invoiceNumber).toBe("N"); expect(invoiceCommand("cancel").payload).toEqual({}); expect(invoiceCommand("paid",{paidAt:"now"}).payload.paidAt).toBe("now"); });
  it("maps financial summary and adjusted-profit completeness", () => { const mapped=mapFinanceSummary({grossRevenue:1,totalRefunds:2,netRevenue:3,itemCost:4,fees:null,shippingCost:null,profit:null,adjustedProfit:null,completeness:"Incomplete"}); expect(mapped).toMatchObject({fees:null,adjustedProfit:null,completeness:"Incomplete"}); });
  it("maps refund/reversal links", () => { expect(mapRefundSummary({orderId:"o1",totalRefunded:2}).href).toBe("/refunds?orderId=o1"); expect(mapReversalSummary({orderId:"o1",reversed:true}).href).toBe("/returns?orderId=o1"); });
  it("constructs filters", () => { expect(buildSalesFinanceQuery({channel:"Internal",status:"Draft",empty:""})).toBe("channel=Internal&status=Draft"); });
  it("redacts safe errors and avoids raw payload/secret rendering", () => { const text=redactSafeError({email:"a@example.com", token:"secret", invoices:[{customerSnapshot:{line1:"private"}}]}); expect(text).not.toContain("a@example.com"); expect(text).not.toContain("line1"); });
});

describe("createInvoiceDraft", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the same-origin Admin proxy path with a fresh idempotencyKey and empty payload", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "inv-1", status: "Draft" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await createInvoiceDraft("order-1");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/erp/commands/orders/order-1/invoices/create");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
    expect(body.payload).toEqual({});
    expect(result).toEqual({ id: "inv-1", status: "Draft" });
  });

  it("generates a different idempotencyKey on each call", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } }),
    );
    await createInvoiceDraft("order-1");
    await createInvoiceDraft("order-1");
    const mockFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const key1 = JSON.parse(mockFetch.mock.calls[0][1].body).idempotencyKey;
    const key2 = JSON.parse(mockFetch.mock.calls[1][1].body).idempotencyKey;
    expect(key1).not.toBe(key2);
  });

  it("throws an ApiError with the backend status on failure", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: "ERP authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(createInvoiceDraft("order-1")).rejects.toMatchObject({ status: 401 });
    await expect(createInvoiceDraft("order-1")).rejects.toBeInstanceOf(ApiError);
  });
});
