import { describe, expect, it } from "vitest";
import { buildShipmentQuery, canAct, canRetryFulfillment, financialSummary, marketplaceOrderLink, readinessSummary, safeErrorSummary, shipmentOrderLink, trackingTimeline, type ShipmentRow } from "./shipments";

describe("admin shipment helpers", () => {
  const row: ShipmentRow = { id: "s1", orderId: "o1", channel: "ebay", carrierCode: "ups", trackingNumber: "1Z", status: "in_transit", marketplaceFulfillmentStatus: "failed", shippingCost: 8 };
  it("maps list/detail links and filters", () => { expect(shipmentOrderLink(row)).toBe("/orders/o1"); expect(marketplaceOrderLink(row)).toBe("/marketplace-orders?orderId=o1"); expect(buildShipmentQuery({ orderId: "o1", status: "in_transit", channel: undefined })).toBe("orderId=o1&status=in_transit"); });
  it("computes status action and retry eligibility", () => { expect(canAct("draft", "ready")).toBe(true); expect(canAct("delivered", "ship")).toBe(false); expect(canRetryFulfillment(row)).toBe(true); expect(canRetryFulfillment({ ...row, channel: undefined })).toBe(false); });
  it("maps tracking, readiness and financial summaries", () => { expect(trackingTimeline([{ externalStatus: "Delivered", normalizedStatus: "delivered" }])).toEqual([{ externalStatus: "Delivered", status: "delivered" }]); expect(readinessSummary({ ready: false, issues: ["Shipment"] })).toEqual({ ready: false, issues: ["Shipment"] }); expect(financialSummary({ grossRevenue: 100, itemCost: 40, marketplaceFee: null, paymentFee: 3, promotedFee: 2, shippingCost: 8, profit: 47 })).toEqual({ revenue: 100, itemCost: 40, fees: 5, shippingCost: 8, profit: 47 }); });
  it("redacts sensitive error material", () => { expect(safeErrorSummary("bad Bearer secret-token access_token=abc refresh_token=def")).not.toContain("secret-token"); });
});
