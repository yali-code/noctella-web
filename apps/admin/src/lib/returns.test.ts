import { describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import {
  approveReturn,
  authorizeReturn,
  buildReturnQuery,
  cancelRefund,
  cancelReturn,
  canCancelRefund,
  canRetryRefund,
  canSubmitRefund,
  canTransitionReturn,
  completeReturn,
  financialAdjustment,
  getRefund,
  getReturn,
  getReturnEvents,
  getReturnReadiness,
  getSaleReversalReadiness,
  inspectReturnItem,
  isConcurrencyConflict,
  listRefunds,
  listReturns,
  markReturnInTransit,
  receiveReturn,
  refundReturnLink,
  rejectReturn,
  retryRefund,
  returnOrderLink,
  returnShipmentLink,
  safeReturnError,
  stockDispositionLabel,
  submitRefund,
  type RefundRow,
  type ReturnRow,
} from "./returns";
vi.mock("./api", () => ({ api: { get: vi.fn(), post: vi.fn() }, ApiError: class ApiError extends Error { status: number; details?: unknown[]; constructor(message: string, status: number, details?: unknown[]) { super(message); this.status = status; this.details = details; } } }));
const mockedApi = vi.mocked(api);

describe("admin return/refund helpers", () => {
  const ret: ReturnRow = { id:"ret1", orderId:"ord1", shipmentId:"ship1", channel:"ebay", status:"requested", reason:"damaged", requestedResolution:"refund", requestedAt:"now" };
  const refund: RefundRow = { id:"ref1", orderId:"ord1", returnRequestId:"ret1", channel:"etsy", externalRefundId:"ext", type:"partial", status:"failed", currency:"EUR", subtotalAmount:20, shippingAmount:3, taxAmount:2, totalAmount:25 };
  it("maps return list/detail API calls and links", async () => { mockedApi.get.mockResolvedValueOnce([ret]); await listReturns({ orderId:"ord1", status:"requested" }); expect(mockedApi.get).toHaveBeenCalledWith("/returns?orderId=ord1&status=requested"); mockedApi.get.mockResolvedValueOnce(ret); await getReturn("ret1"); expect(mockedApi.get).toHaveBeenCalledWith("/returns/ret1"); mockedApi.get.mockResolvedValueOnce([]); await getReturnEvents("ret1"); expect(mockedApi.get).toHaveBeenCalledWith("/returns/ret1/events"); mockedApi.get.mockResolvedValueOnce({ ready:true, reasons:[], allowedActions:[] }); await getReturnReadiness("ret1"); expect(returnOrderLink(ret)).toBe("/orders/ord1"); expect(returnShipmentLink(ret)).toBe("/shipments/ship1"); });
  it("maps refund list/detail API calls and sale reversal readiness", async () => { mockedApi.get.mockResolvedValueOnce([refund]); await listRefunds({ channel:"etsy", status:"failed" }); expect(mockedApi.get).toHaveBeenCalledWith("/refunds?channel=etsy&status=failed"); mockedApi.get.mockResolvedValueOnce(refund); await getRefund("ref1"); expect(mockedApi.get).toHaveBeenCalledWith("/refunds/ref1"); mockedApi.get.mockResolvedValueOnce({ ready:false, reasons:["Full refund"] }); await getSaleReversalReadiness("ord1"); expect(mockedApi.get).toHaveBeenCalledWith("/orders/ord1/sale-reversal/readiness"); expect(refundReturnLink(refund)).toBe("/returns/ret1"); });
  it("builds filters/query strings", () => { expect(buildReturnQuery({ orderId:"o1", status:"completed", channel:undefined, reason:"damaged" })).toBe("orderId=o1&status=completed&reason=damaged"); });
  it("calculates transition, retry and cancel eligibility", () => { expect(canTransitionReturn("requested","authorize")).toBe(true); expect(canTransitionReturn("completed","cancel")).toBe(false); expect(canRetryRefund(refund)).toBe(true); expect(canCancelRefund({ ...refund, status:"succeeded" })).toBe(false); });
  it("redacts sensitive errors", () => { expect(safeReturnError("Bearer secret access_token=abc refresh_token=def authorization: token")).not.toContain("secret"); });
  it("maps financial adjustments and stock dispositions", () => { expect(financialAdjustment([refund, { ...refund, id:"ref2", totalAmount:5, shippingAmount:0, taxAmount:1 }])).toEqual({ totalRefunded:30, refundedShipping:3, refundedTax:3 }); expect(stockDispositionLabel("return_to_stock")).toBe("Return to stock"); expect(stockDispositionLabel("discard")).toBe("Discard"); expect(stockDispositionLabel()).toBe("Not inspected"); });
  it("recognizes the in-transit transition, which the backend allows from authorized/awaiting_shipment", () => { expect(canTransitionReturn("authorized","in-transit")).toBe(true); expect(canTransitionReturn("awaiting_shipment","in-transit")).toBe(true); expect(canTransitionReturn("requested","in-transit")).toBe(false); });
  it("calculates refund submit eligibility matching submitRefundUseCase's allowed statuses", () => { expect(canSubmitRefund({ ...refund, status:"draft" })).toBe(true); expect(canSubmitRefund({ ...refund, status:"pending" })).toBe(true); expect(canSubmitRefund({ ...refund, status:"failed" })).toBe(true); expect(canSubmitRefund({ ...refund, status:"succeeded" })).toBe(false); });
});

describe("admin return/refund lifecycle mutations (Sprint 56B)", () => {
  it("posts the correct method/path/body for every return transition, with no fabricated fields", async () => {
    mockedApi.post.mockResolvedValue({ id:"ret1", status:"authorized" });
    await authorizeReturn("ret1");
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/authorize", {});
    await rejectReturn("ret1", { internalNote:"damaged in transit" });
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/reject", { internalNote:"damaged in transit" });
    await markReturnInTransit("ret1", { returnCarrierCode:"ups", returnTrackingNumber:"1Z" });
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/in-transit", { returnCarrierCode:"ups", returnTrackingNumber:"1Z" });
    await receiveReturn("ret1");
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/receive", {});
    await inspectReturnItem("ret1", { orderItemId:"oi1", quantityReceived:2, stockDisposition:"return_to_stock" });
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/inspect", { orderItemId:"oi1", quantityReceived:2, stockDisposition:"return_to_stock" });
    await approveReturn("ret1", { partial:true });
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/approve", { partial:true });
    await completeReturn("ret1");
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/complete", {});
    await cancelReturn("ret1");
    expect(mockedApi.post).toHaveBeenCalledWith("/returns/ret1/cancel", {});
  });

  it("posts the correct method/path for every refund action with no body fields, since the backend routes take none", async () => {
    mockedApi.post.mockResolvedValue({ id:"ref1", status:"pending" });
    await submitRefund("ref1");
    expect(mockedApi.post).toHaveBeenCalledWith("/refunds/ref1/submit", {});
    await retryRefund("ref1");
    expect(mockedApi.post).toHaveBeenCalledWith("/refunds/ref1/retry", {});
    await cancelRefund("ref1");
    expect(mockedApi.post).toHaveBeenCalledWith("/refunds/ref1/cancel", {});
  });

  it("propagates structured backend validation errors unchanged", async () => {
    mockedApi.post.mockRejectedValueOnce(new ApiError("Invalid return status transition", 400));
    await expect(authorizeReturn("ret1")).rejects.toMatchObject({ message:"Invalid return status transition", status:400 });
  });

  it("propagates concurrency-conflict errors and isConcurrencyConflict recognizes both backend message shapes", async () => {
    mockedApi.post.mockRejectedValueOnce(new ApiError("Return was updated by another transaction", 400));
    await expect(approveReturn("ret1")).rejects.toMatchObject({ status:400 });
    expect(isConcurrencyConflict("Return was updated by another transaction")).toBe(true);
    expect(isConcurrencyConflict("Stale refund version")).toBe(true);
    expect(isConcurrencyConflict("Invalid return status transition")).toBe(false);
    expect(isConcurrencyConflict(undefined)).toBe(false);
  });
});
