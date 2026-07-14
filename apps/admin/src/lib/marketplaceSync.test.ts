import { describe, expect, it, vi } from "vitest";
import { getMarketplaceOrder, internalOrderHref, listExternalListings, listMarketplaceOrders, listSyncRuns, mapExternalListing, mapMarketplaceOrderDetail, mapMarketplaceOrderListItem, mapSyncRun, queryString, retryEligible, safeError, unmatchedWarnings } from "./marketplaceSync";

const fetchMock = vi.fn();
global.fetch = fetchMock;
function json(data: unknown) { return Promise.resolve({ ok: true, headers: { get: () => "application/json" }, json: () => Promise.resolve(data) } as unknown as Response); }

describe("admin marketplace sync helpers", () => {
  it("maps list and detail rows", () => {
    const item = mapMarketplaceOrderListItem({ id:"m1", externalOrderId:"e1", buyerEmail:"b@example.com", total:10, currency:"EUR", status:"paid", retryable:true });
    expect(item).toMatchObject({ externalLabel:"e1", buyer:"b@example.com", totalLabel:"10 EUR", canRetry:true });
    const detail = mapMarketplaceOrderDetail({ internalOrderId:"o1", lastError:"secret-abcdef123456", items:[{ titleSnapshot:"Lamp" }] });
    expect(detail.internalOrderHref).toBe("/orders/o1"); expect(detail.warnings).toEqual(["Unmatched item: Lamp"]); expect(detail.safeLastError).not.toContain("abcdef123456");
  });
  it("builds filters/query construction", () => { expect(queryString({ channel:"ebay", status:"paid", page:2, empty:"" })).toBe("?channel=ebay&status=paid&page=2"); });
  it("calculates retry eligibility", () => { expect(retryEligible({ status:"paid", retryable:true, attemptCount:1 })).toBe(true); expect(retryEligible({ status:"cancelled", retryable:true })).toBe(false); expect(retryEligible({ status:"paid", internalOrderId:"o1", retryable:true })).toBe(false); expect(retryEligible({ status:"paid", retryable:false })).toBe(false); });
  it("maps sync runs, external listings, safe errors, internal links, and warnings", () => { expect(mapSyncRun({ processedCount:3, successCount:2, failureCount:1, lastError:"token-abcdef123456" }).counts).toBe("3/2/1"); expect(mapExternalListing({ id:"l1", productId:"p1" })).toMatchObject({ productHref:"/products/p1", syncPath:"/api/external-listings/l1/sync" }); expect(safeError("token-abcdef123456")).not.toContain("abcdef123456"); expect(internalOrderHref("o1")).toBe("/orders/o1"); expect(unmatchedWarnings([{ titleSnapshot:"Chair", productId:null }])).toEqual(["Unmatched item: Chair"]); });
  it("wraps API calls", async () => { fetchMock.mockImplementation((url:string) => json({ url })); await listMarketplaceOrders("?channel=ebay"); await getMarketplaceOrder("m1"); await listExternalListings("?status=active"); await listSyncRuns("?status=failed"); expect(fetchMock.mock.calls.map((c)=>String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining("/api/marketplace-orders?channel=ebay"), expect.stringContaining("/api/marketplace-orders/m1"), expect.stringContaining("/api/external-listings?status=active"), expect.stringContaining("/api/marketplace-sync-runs?status=failed")])); });
});
