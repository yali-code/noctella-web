import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { assignTracking, buildShipmentQuery, canAct, cancelShipment, canRetryFulfillment, createShipment, deliverShipment, failShipment, financialSummary, listShipments, markReady, marketplaceOrderLink, readinessSummary, retryMarketplaceFulfillment, returnShipment, safeErrorSummary, shipmentOrderLink, shipShipment, trackingTimeline, type ShipmentRow } from "./shipments";

describe("admin shipment helpers", () => {
  const row: ShipmentRow = { id: "s1", orderId: "o1", channel: "ebay", carrierCode: "ups", trackingNumber: "1Z", status: "in_transit", marketplaceFulfillmentStatus: "failed", shippingCost: 8 };
  it("maps list/detail links and filters", () => { expect(shipmentOrderLink(row)).toBe("/orders/o1"); expect(marketplaceOrderLink(row)).toBe("/marketplace-orders?orderId=o1"); expect(buildShipmentQuery({ orderId: "o1", status: "in_transit", channel: undefined })).toBe("orderId=o1&status=in_transit"); });
  it("computes status action and retry eligibility", () => { expect(canAct("draft", "ready")).toBe(true); expect(canAct("delivered", "ship")).toBe(false); expect(canRetryFulfillment(row)).toBe(true); expect(canRetryFulfillment({ ...row, channel: undefined })).toBe(false); });
  it("maps tracking, readiness and financial summaries", () => { expect(trackingTimeline([{ externalStatus: "Delivered", normalizedStatus: "delivered" }])).toEqual([{ externalStatus: "Delivered", status: "delivered" }]); expect(readinessSummary({ ready: false, issues: ["Shipment"] })).toEqual({ ready: false, issues: ["Shipment"] }); expect(financialSummary({ grossRevenue: 100, itemCost: 40, marketplaceFee: null, paymentFee: 3, promotedFee: 2, shippingCost: 8, profit: 47 })).toEqual({ revenue: 100, itemCost: 40, fees: 5, shippingCost: 8, profit: 47 }); });
  it("redacts sensitive error material", () => { expect(safeErrorSummary("bad Bearer secret-token access_token=abc refresh_token=def")).not.toContain("secret-token"); });
});

describe("financialSummary profit completeness", () => {
  it("preserves a known non-zero profit as a number", () => {
    expect(financialSummary({ grossRevenue: 100, itemCost: 40, marketplaceFee: 1, paymentFee: 3, promotedFee: 2, shippingCost: 8, profit: 47 }).profit).toBe(47);
  });

  it("preserves a known profit of exactly 0 as numeric zero, not null", () => {
    const profit = financialSummary({ grossRevenue: 100, itemCost: 100, marketplaceFee: 0, paymentFee: 0, promotedFee: 0, shippingCost: 0, profit: 0 }).profit;
    expect(profit).toBe(0);
    expect(profit).not.toBeNull();
  });

  it("preserves a null profit (incomplete financial data) as null, not 0", () => {
    const profit = financialSummary({ grossRevenue: 100, itemCost: null, marketplaceFee: null, paymentFee: null, promotedFee: null, shippingCost: null, profit: null }).profit;
    expect(profit).toBeNull();
  });

  it("returns null profit when finance data is entirely missing", () => {
    expect(financialSummary(undefined).profit).toBeNull();
    expect(financialSummary(null).profit).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("shipment mutation functions (Sprint 60B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("listShipments/getShipment/etc. call the backend under the /api prefix (fixed Sprint 60B - previously missing)", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse([]));
    await listShipments({ orderId: "o1" });
    expect(mockFetch.mock.calls[0][0]).toContain("/api/shipments?orderId=o1");
  });

  it("createShipment posts to /api/orders/:orderId/shipments with the given payload", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ id: "s1" }));
    await createShipment("order-1", { carrierCode: "ups" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/orders/order-1/shipments");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ carrierCode: "ups" });
  });

  it("assignTracking posts to /api/shipments/:id/tracking with the given payload", async () => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ id: "s1" }));
    await assignTracking("s1", { trackingNumber: "1Z" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/shipments/s1/tracking");
    expect(JSON.parse(init!.body as string)).toEqual({ trackingNumber: "1Z" });
  });

  it.each([
    ["markReady", markReady, "ready"],
    ["shipShipment", shipShipment, "ship"],
    ["deliverShipment", deliverShipment, "deliver"],
    ["failShipment", failShipment, "delivery-failed"],
    ["cancelShipment", cancelShipment, "cancel"],
    ["returnShipment", returnShipment, "return"],
  ] as const)("%s posts to /api/shipments/:id/%s", async (_name, fn, segment) => {
    const mockFetch = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ id: "s1" }));
    await fn("s1");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain(`/api/shipments/s1/${segment}`);
    expect(init!.method).toBe("POST");
  });

  it("retryMarketplaceFulfillment finds the matching background job by payload shipmentId, then retries it", async () => {
    const mockFetch = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ items: [
        { id: "job-1", payloadSnapshot: JSON.stringify({ shipmentId: "other-shipment" }) },
        { id: "job-2", payloadSnapshot: JSON.stringify({ shipmentId: "s1" }) },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await retryMarketplaceFulfillment("s1", "ebay");
    expect(mockFetch.mock.calls[0][0]).toContain("/api/background-jobs?type=submit_marketplace_shipment&channel=ebay");
    expect(mockFetch.mock.calls[1][0]).toContain("/api/background-jobs/job-2/retry");
  });

  it("retryMarketplaceFulfillment throws a structured ApiError when no matching job exists", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await expect(retryMarketplaceFulfillment("s1")).rejects.toBeInstanceOf(ApiError);
  });

  it("propagates structured backend errors (status + details) from a mutation call", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ error: "An active shipment already exists for this order" }, 409)
    );
    await expect(createShipment("order-1", { carrierCode: "ups" })).rejects.toMatchObject({
      status: 409,
      message: "An active shipment already exists for this order",
    });
  });
});
