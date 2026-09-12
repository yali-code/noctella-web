import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  MarketplaceConnectionStatus,
  OrderStatus,
  PaymentStatus,
  ProductStatus,
  ProductType,
  PublishChannel,
  ReturnReason,
  ReturnResolution,
  ReturnStatus,
  ReturnStockDisposition,
  StockMovementType,
} from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { encryptCredential } from "../src/services/credentialEncryption";
import {
  approveReturn,
  authorizeReturn,
  cancelReturn,
  completeReturn,
  createReturnRequest,
  getReturnEvents,
  inspectReturnItem,
  markReturnInTransit,
  receiveReturn,
  rejectReturn,
  updateReturnRequest,
} from "../src/services/returns";
import { updateReturnUseCase } from "../src/use-cases/return/useCases";

const at = "2026-09-12T00:00:00.000Z";
const address = JSON.stringify({ fullName: "Jane", line1: "1 Main", city: "Paris", postalCode: "75001", country: "FR" });
const encryptionKey = Buffer.alloc(32, 17).toString("base64");

function database() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);
  return drizzle(sqlite, { schema });
}

async function fixture() {
  process.env.MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY = encryptionKey;
  const db = database();
  await db.insert(schema.products).values({ id:"p1", sku:"SKU-174", title:"Vase", slug:"vase-174", type:ProductType.UniqueItem, status:ProductStatus.Sold, stockQuantity:0, priceEur:100, createdAt:at, updatedAt:at });
  await db.insert(schema.orders).values({ id:"o1", orderNumber:"NOC-174", guestEmail:"buyer@example.com", status:OrderStatus.Completed, paymentStatus:PaymentStatus.Paid, subtotalAmount:100, shippingAmount:0, taxAmount:0, totalAmount:100, currency:"EUR", billingAddress:address, shippingAddress:address, createdAt:at, updatedAt:at });
  await db.insert(schema.orderItems).values({ id:"oi1", orderId:"o1", productId:"p1", productSku:"SKU-174", productTitle:"Vase", productSlug:"vase-174", productType:ProductType.UniqueItem, quantity:1, unitPrice:100, totalPrice:100, currency:"EUR", createdAt:at, updatedAt:at });
  const ret:any = await createReturnRequest(db,{ orderId:"o1", channel:PublishChannel.Ebay, externalReturnId:"external-174", reason:ReturnReason.Damaged, reasonDetails:"original reason", requestedResolution:ReturnResolution.Refund, internalNote:"original note", items:[{orderItemId:"oi1",quantityRequested:1}] });
  return { db, ret };
}

const forbiddenFields = [
  "status", "completedAt", "authorizedAt", "receivedAt", "inspectedAt", "cancelledAt", "requestedAt",
  "approvedResolution", "returnCarrierCode", "returnTrackingNumber", "returnTrackingUrl", "buyerShippedAt",
  "id", "orderId", "marketplaceOrderId", "shipmentId", "channel", "externalReturnId", "externalReturnNumber",
  "externalReference", "idempotencyKey", "reason", "requestedResolution", "buyerMessage",
  "version", "createdAt", "updatedAt", "lastError",
] as const;

describe("Sprint 174 return lifecycle mutation boundaries", () => {
  it("sets and clears reasonDetails while preserving absent internalNote", async () => {
    const {db,ret}=await fixture();
    const set:any=await updateReturnRequest(db,ret.id,{reasonDetails:"updated reason"});
    expect(set).toMatchObject({reasonDetails:"updated reason",internalNote:"original note",version:1});
    const cleared:any=await updateReturnRequest(db,ret.id,{reasonDetails:null});
    expect(cleared).toMatchObject({reasonDetails:null,internalNote:"original note",version:2});
  });

  it("sets and clears internalNote while preserving absent reasonDetails", async () => {
    const {db,ret}=await fixture();
    const set:any=await updateReturnRequest(db,ret.id,{internalNote:"updated note"});
    expect(set).toMatchObject({reasonDetails:"original reason",internalNote:"updated note",version:1});
    const cleared:any=await updateReturnRequest(db,ret.id,{internalNote:null});
    expect(cleared).toMatchObject({reasonDetails:"original reason",internalNote:null,version:2});
  });

  it("updates both metadata fields and increments version exactly once", async () => {
    const {db,ret}=await fixture();
    const updated:any=await updateReturnRequest(db,ret.id,{reasonDetails:null,internalNote:"replacement"});
    expect(updated).toMatchObject({reasonDetails:null,internalNote:"replacement",version:1});
  });

  it("rejects an empty object before opening the unit of work", async () => {
    const run=vi.fn();
    expect(()=>updateReturnUseCase({unitOfWork:{run},ports:{} as any},"r1",{})).toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects unknown fields before opening the unit of work", async () => {
    const run=vi.fn();
    expect(()=>updateReturnUseCase({unitOfWork:{run},ports:{} as any},"r1",{unknown:"value"} as any)).toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(forbiddenFields)("rejects forbidden field %s without mutation or version increment", async (field) => {
    const {db,ret}=await fixture();
    const before=(await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id,ret.id)))[0];
    expect(()=>updateReturnRequest(db,ret.id,{[field]:field==="version"?99:"forbidden"} as any)).toThrow();
    const after=(await db.select().from(schema.returnRequests).where(eq(schema.returnRequests.id,ret.id)))[0];
    expect(after).toEqual(before);
  });

  it("preserves the existing optimistic-conflict behavior", async () => {
    const current={id:"r1",version:4};
    const repositories:any={returnRepositories:{returns:{read:{getById:()=>current,getReturnDetailProjection:()=>current},write:{updateWithExpectedVersion:()=>({ok:false})}}}};
    const ctx:any={unitOfWork:{run:async(fn:any)=>fn({repositories})},ports:{}};
    await expect(updateReturnUseCase(ctx,"r1",{internalNote:"note"})).rejects.toThrow("Return was updated by another transaction");
  });

  it("keeps all dedicated lifecycle commands compatible", async () => {
    const authorizeFixture=await fixture();
    await expect(authorizeReturn(authorizeFixture.db,authorizeFixture.ret.id,{})).resolves.toMatchObject({status:ReturnStatus.Authorized});
    await expect(markReturnInTransit(authorizeFixture.db,authorizeFixture.ret.id,{})).resolves.toMatchObject({status:ReturnStatus.InTransit});
    await expect(receiveReturn(authorizeFixture.db,authorizeFixture.ret.id,{})).resolves.toMatchObject({status:ReturnStatus.Received});
    await expect(inspectReturnItem(authorizeFixture.db,authorizeFixture.ret.id,{orderItemId:"oi1",quantityReceived:1,condition:"used",stockDisposition:ReturnStockDisposition.NoStockChange})).resolves.toMatchObject({status:ReturnStatus.Inspecting});
    await expect(approveReturn(authorizeFixture.db,authorizeFixture.ret.id,{})).resolves.toMatchObject({status:ReturnStatus.Approved});

    const rejectFixture=await fixture();
    await expect(rejectReturn(rejectFixture.db,rejectFixture.ret.id,{})).resolves.toMatchObject({status:ReturnStatus.Rejected});
    const cancelFixture=await fixture();
    await expect(cancelReturn(cancelFixture.db,cancelFixture.ret.id,{})).resolves.toMatchObject({status:ReturnStatus.Cancelled});
  });

  it("preserves atomic, eventful, synchronized, idempotent completion", async () => {
    const {db,ret}=await fixture();
    await db.insert(schema.marketplaceConnections).values({id:"conn-174",channel:PublishChannel.Ebay,accountLabel:"Default",encryptedAccessToken:encryptCredential("token"),status:MarketplaceConnectionStatus.Connected,createdAt:at,updatedAt:at});
    await db.insert(schema.externalListings).values({id:"listing-174",productId:"p1",channel:PublishChannel.Ebay,connectionId:"conn-174",externalListingId:"listing-external-174",externalStatus:"active",payloadSnapshot:"{}",publishedAt:at,updatedAt:at});
    await authorizeReturn(db,ret.id,{}); await receiveReturn(db,ret.id,{}); await inspectReturnItem(db,ret.id,{orderItemId:"oi1",quantityReceived:1,condition:"used",stockDisposition:ReturnStockDisposition.ReturnToStock}); await approveReturn(db,ret.id,{});
    await completeReturn(db,ret.id); await completeReturn(db,ret.id);
    const [item]=await db.select().from(schema.returnItems).where(eq(schema.returnItems.returnRequestId,ret.id));
    const [product]=await db.select().from(schema.products).where(eq(schema.products.id,"p1"));
    const movements=(await db.select().from(schema.stockMovements)).filter(m=>m.type===StockMovementType.ReturnIn||m.type==="return_in");
    const events=await getReturnEvents(db,ret.id);
    expect(item).toMatchObject({quantityCompleted:1,completedAt:expect.any(String)});
    expect(product.stockQuantity).toBe(1);
    expect(movements).toHaveLength(1);
    expect(events.filter(e=>e.eventType==="completed")).toHaveLength(1);
    expect(await db.select().from(schema.backgroundJobs)).toHaveLength(1);
  });
});
