import { describe, expect, it } from "vitest";
import { allocationMethodLabels, buildPurchaseQuery, commandStatusLabel, costCompleteness, mapLandedCostSummary, mapPurchase, mapSupplier, productHref, productLinkWarning, purchaseHref, receiptStatus, redactSafeError, supplierHref } from "./erpPurchasingBridge";
describe("erp purchasing bridge admin mapping", () => {
  it("maps suppliers, purchases, links, labels, warnings and safe errors", () => {
    expect(mapSupplier({id:"s1",name:"Auction",status:"Active",supplierType:"AuctionHouse",countryCode:"BE",city:"Brussels",erpReferenceId:"erp"}).href).toBe("/suppliers/s1");
    expect(mapPurchase({id:"p1",status:"Draft",sourceType:"Auction",totalCost:null}).total).toBe("Incomplete");
    expect(mapLandedCostSummary({allocationMethod:"ByQuantity", complete:true, reconciled:true}).method).toBe(allocationMethodLabels.ByQuantity);
    expect(receiptStatus({lines:[{quantity:2,receivedQuantity:1}]})).toBe("1/2 received");
    expect(productLinkWarning({})).toContain("Unlinked");
    expect(costCompleteness({complete:false})).toContain("Incomplete");
    expect(commandStatusLabel("Conflict")).toContain("review");
    expect(redactSafeError({ email:"a@b.com", phone:"+32 123456789" })).not.toContain("a@b.com");
    expect([supplierHref("s"), purchaseHref("p"), productHref("x")]).toEqual(["/suppliers/s","/purchases/p","/products/x"]);
    expect(buildPurchaseQuery({status:"Draft", empty:""})).toBe("status=Draft");
  });
});
