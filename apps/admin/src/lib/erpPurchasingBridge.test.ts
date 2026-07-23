import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allocationMethodLabels,
  allocatePurchaseCosts,
  buildPurchaseQuery,
  cancelPurchase,
  commandStatusLabel,
  costCompleteness,
  createPurchase,
  createSupplier,
  mapLandedCostSummary,
  mapPurchase,
  mapSupplier,
  markPurchaseOrdered,
  productHref,
  productLinkWarning,
  purchaseHref,
  purchasingApi,
  receiptStatus,
  receivePurchase,
  redactSafeError,
  supplierHref,
  updateSupplier,
} from "./erpPurchasingBridge";

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

describe("erp purchasing bridge network behavior (Sprint 57B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no source reference to the plain unauthenticated api client remains (only the shared ApiError class is imported)", () => {
    const source = readFileSync(new URL("./erpPurchasingBridge.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import \{ ApiError \} from ["']\.\/api["']/);
    expect(source).not.toMatch(/\bapi\.get\(/);
    expect(source).not.toMatch(/\bapi\.post\(/);
  });

  it("reads hit the same-origin proxy paths, not the direct backend", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await purchasingApi.suppliers("status=Active");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/suppliers?status=Active");
    await purchasingApi.supplier("s1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/suppliers/s1");
    await purchasingApi.purchases("status=Draft");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/purchases?status=Draft");
    await purchasingApi.purchase("p1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/purchases/p1");
    await purchasingApi.landed("p1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/erp/purchases/p1/landed-cost");
  });

  it("createSupplier posts a command envelope to the same-origin proxy with a generated idempotency key", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "s1" }), { status: 201, headers: { "content-type": "application/json" } }));
    await createSupplier({ name: "Acme" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [path, init] = fetchSpy.mock.calls[0];
    expect(path).toBe("/api/erp/commands/suppliers/create");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.payload).toEqual({ name: "Acme" });
    expect(typeof sent.idempotencyKey).toBe("string");
    expect(sent.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("updateSupplier forwards the actual current expectedUpdatedAt value, not a fabricated version field", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "s1" }), { status: 200, headers: { "content-type": "application/json" } }));
    await updateSupplier("s1", { name: "Renamed" }, "2026-01-01T00:00:00.000Z");
    const [path, init] = fetchSpy.mock.calls[0];
    expect(path).toBe("/api/erp/commands/suppliers/s1/update");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.payload.expectedUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(sent.payload.expectedVersion).toBeUndefined();
  });

  it("createPurchase posts a complete purchase with lines in one call", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "p1" }), { status: 201, headers: { "content-type": "application/json" } }));
    await createPurchase({ supplierId: "s1", lines: [{ titleSnapshot: "Lot", quantity: 1, unitPurchaseCost: 10 }] });
    const [path, init] = fetchSpy.mock.calls[0];
    expect(path).toBe("/api/erp/commands/purchases/create");
    expect(JSON.parse((init as RequestInit).body as string).payload.lines).toHaveLength(1);
  });

  it("receivePurchase forwards the exact caller-supplied idempotency key, never generating its own", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "PartiallyReceived" }), { status: 200, headers: { "content-type": "application/json" } }));
    await receivePurchase("p1", { idempotencyKey: "stable-attempt-key", lines: [{ purchaseLineId: "l1", quantityReceived: 1 }] });
    const [path, init] = fetchSpy.mock.calls[0];
    expect(path).toBe("/api/erp/commands/purchases/p1/receive");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.idempotencyKey).toBe("stable-attempt-key");
    expect(sent.payload.idempotencyKey).toBe("stable-attempt-key");
    expect(sent.payload.lines).toEqual([{ purchaseLineId: "l1", quantityReceived: 1 }]);

    // A retry of the same attempt must reuse the identical key.
    await receivePurchase("p1", { idempotencyKey: "stable-attempt-key", lines: [{ purchaseLineId: "l1", quantityReceived: 1 }] });
    const secondSent = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
    expect(secondSent.idempotencyKey).toBe("stable-attempt-key");
  });

  it("allocatePurchaseCosts, markPurchaseOrdered, cancelPurchase post to their respective proxy paths", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await allocatePurchaseCosts("p1", { allocationMethod: "ByItemCost" });
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/erp/commands/purchases/p1/allocate");
    await markPurchaseOrdered("p1");
    expect(fetchSpy.mock.calls[1][0]).toBe("/api/erp/commands/purchases/p1/mark-ordered");
    await cancelPurchase("p1");
    expect(fetchSpy.mock.calls[2][0]).toBe("/api/erp/commands/purchases/p1/cancel");
  });

  it("propagates structured backend errors (status, message, details) unchanged", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "Purchase cannot be cancelled in current status" }), { status: 400, headers: { "content-type": "application/json" } }));
    await expect(cancelPurchase("p1")).rejects.toMatchObject({ message: "Purchase cannot be cancelled in current status", status: 400 });
  });
});
