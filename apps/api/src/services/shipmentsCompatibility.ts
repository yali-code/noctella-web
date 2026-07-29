import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { CarrierCode, ErpInvoiceStatus, ErpInvoiceType, MarketplaceFulfillmentStatus, PaymentStatus, PriceCurrency, roundMoney, ShipmentStatus, ShippingError, type Shipment } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { invoiceLines, invoices, marketplaceConnections, marketplaceOrders, orderItems, orders, products, saleFinancials, shipmentEvents, shipmentItems, shipments, shipmentTrackingUpdates } from "../db/schema";
import { BadRequestError, NotFoundError } from "./errors";
import { enqueueJob } from "./backgroundJobs";
import { decryptCredential } from "./credentialEncryption";
import { getMarketplaceAdapter, type MarketplaceAdapter } from "./marketplaceAdapters";
import { CompleteSaleApplicationAdapter, type LegacySaleFinancials } from "../application/sales";
import { createSalesApplicationContextForDb } from "./salesApplicationContextForDb";

const terminal = [ShipmentStatus.Cancelled, ShipmentStatus.Returned];
const allowed: Record<string, string[]> = { [ShipmentStatus.Draft]: [ShipmentStatus.Ready, ShipmentStatus.Cancelled], [ShipmentStatus.Ready]: [ShipmentStatus.LabelPending, ShipmentStatus.LabelCreated, ShipmentStatus.InTransit, ShipmentStatus.Cancelled], [ShipmentStatus.LabelPending]: [ShipmentStatus.LabelCreated, ShipmentStatus.Cancelled], [ShipmentStatus.LabelCreated]: [ShipmentStatus.InTransit, ShipmentStatus.Cancelled], [ShipmentStatus.InTransit]: [ShipmentStatus.Delivered, ShipmentStatus.DeliveryFailed, ShipmentStatus.Returned], [ShipmentStatus.DeliveryFailed]: [ShipmentStatus.InTransit, ShipmentStatus.Returned], [ShipmentStatus.Delivered]: [ShipmentStatus.Returned] };
let adapterResolver = (channel: string): MarketplaceAdapter => getMarketplaceAdapter(channel as any);
export function setShipmentMarketplaceAdapterResolver(resolver: typeof adapterResolver) { adapterResolver = resolver; }
const clean = (v: unknown) => String(v instanceof Error ? v.message : v ?? "").replace(/Bearer\s+\S+|access_token\S*|refresh_token\S*/gi, "[redacted]").slice(0, 500);
function parse<T>(v: string | null | undefined, fallback: T): T { try { return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } }
async function hydrate(db: DbClient, row: typeof shipments.$inferSelect): Promise<Shipment> { const items = await db.select().from(shipmentItems).where(eq(shipmentItems.shipmentId, row.id)); return { id: row.id, orderId: row.orderId, marketplaceOrderId: row.marketplaceOrderId ?? undefined, channel: row.channel ?? undefined, carrierCode: row.carrierCode, customCarrierName: row.customCarrierName ?? undefined, trackingNumber: row.trackingNumber ?? undefined, trackingUrl: row.trackingUrl ?? undefined, status: row.status, shippingCost: row.shippingCost, currency: "EUR", shippedAt: row.shippedAt ?? undefined, deliveredAt: row.deliveredAt ?? undefined, cancelledAt: row.cancelledAt ?? undefined, returnedAt: row.returnedAt ?? undefined, externalFulfillmentId: row.externalFulfillmentId ?? undefined, marketplaceFulfillmentStatus: row.marketplaceFulfillmentStatus ?? undefined, lastError: row.lastError ?? undefined, createdAt: row.createdAt, updatedAt: row.updatedAt, items }; }
async function event(db: DbClient, shipmentId: string, type: string, prev?: string | null, next?: string | null, payload?: unknown, error?: unknown) { await db.insert(shipmentEvents).values({ id: randomUUID(), shipmentId, eventType: type, previousStatus: prev, newStatus: next, payloadSnapshot: JSON.stringify(payload ?? {}), errorCode: error ? ShippingError.Unknown : undefined, errorMessage: error ? clean(error) : undefined, createdAt: new Date().toISOString() }).run(); }
async function getOrderRow(db: DbClient, orderId: string) { const [o] = await db.select().from(orders).where(eq(orders.id, orderId)); if (!o) throw new NotFoundError("Order not found"); return o; }
export async function getShipment(db: DbClient, id: string) { const [row] = await db.select().from(shipments).where(eq(shipments.id, id)); if (!row) throw new NotFoundError("Shipment not found"); return hydrate(db, row); }
export async function listShipments(db: DbClient, q: any = {}) { const f = [q.orderId && eq(shipments.orderId, q.orderId), q.status && eq(shipments.status, q.status), q.channel && eq(shipments.channel, q.channel), q.carrier && eq(shipments.carrierCode, q.carrier), q.trackingNumber && eq(shipments.trackingNumber, q.trackingNumber)].filter(Boolean) as any[]; const rows = await db.select().from(shipments).where(f.length ? and(...f) : undefined).orderBy(desc(shipments.createdAt)).limit(Number(q.pageSize ?? 50)).offset((Number(q.page ?? 1)-1)*Number(q.pageSize ?? 50)); return Promise.all(rows.map((r) => hydrate(db, r))); }
export async function createShipment(db: DbClient, input: any) { const o = await getOrderRow(db, input.orderId); if (input.currency && input.currency !== PriceCurrency.Eur) throw new BadRequestError("Shipping currency must be EUR"); if (input.carrierCode === CarrierCode.Other && !input.customCarrierName) throw new BadRequestError("Custom carrier name is required"); const [existing] = await db.select().from(shipments).where(and(eq(shipments.orderId, input.orderId), eq(shipments.status, ShipmentStatus.Draft))); if (existing) return hydrate(db, existing); const allItems = await db.select().from(orderItems).where(eq(orderItems.orderId, input.orderId)); const wanted = input.items?.length ? input.items : allItems.map((i) => ({ orderItemId: i.id, quantity: i.quantity })); for (const wi of wanted) { const item = allItems.find((i) => i.id === wi.orderItemId); if (!item) throw new BadRequestError("Shipment item must belong to order"); if (wi.quantity < 1 || wi.quantity > item.quantity) throw new BadRequestError("Shipment quantity exceeds order item quantity"); }
 const [mo] = await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, input.orderId)); const now = new Date().toISOString(); const id = randomUUID(); await db.insert(shipments).values({ id, orderId: input.orderId, marketplaceOrderId: input.marketplaceOrderId ?? mo?.id, channel: input.channel ?? mo?.channel, carrierCode: input.carrierCode, customCarrierName: input.customCarrierName, trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl, status: ShipmentStatus.Draft, shippingCost: input.shippingCost ?? 0, currency: "EUR", marketplaceFulfillmentStatus: mo ? MarketplaceFulfillmentStatus.Pending : undefined, customsSnapshot: JSON.stringify(input.customs ?? {}), createdAt: now, updatedAt: now }).run(); for (const wi of wanted) await db.insert(shipmentItems).values({ id: randomUUID(), shipmentId: id, orderItemId: wi.orderItemId, quantity: wi.quantity, createdAt: now }).run(); await event(db, id, "created", null, ShipmentStatus.Draft, input); return getShipment(db, id); }
async function transition(db: DbClient, id: string, status: ShipmentStatus, payload: any = {}) { const [row] = await db.select().from(shipments).where(eq(shipments.id, id)); if (!row) throw new NotFoundError("Shipment not found"); if (row.status === status) return hydrate(db, row); if (terminal.includes(row.status as ShipmentStatus)) throw new BadRequestError("Shipment is terminal"); if (!allowed[row.status]?.includes(status)) throw new BadRequestError(`Invalid shipment status transition ${row.status} -> ${status}`); if (status === ShipmentStatus.InTransit && row.carrierCode !== CarrierCode.LocalPickup && !row.trackingNumber) throw new BadRequestError("Tracking number is required before shipping"); const now = new Date().toISOString(); const patch: any = { status, updatedAt: now }; if (status === ShipmentStatus.InTransit) patch.shippedAt = payload.shippedAt ?? now; if (status === ShipmentStatus.Delivered) patch.deliveredAt = payload.deliveredAt ?? now; if (status === ShipmentStatus.Cancelled) patch.cancelledAt = payload.cancelledAt ?? now; if (status === ShipmentStatus.Returned) patch.returnedAt = payload.returnedAt ?? now; await db.update(shipments).set(patch).where(eq(shipments.id, id)).run(); await event(db, id, "status_changed", row.status, status, payload); const s = await getShipment(db, id); if (status === ShipmentStatus.InTransit && s.channel && !s.externalFulfillmentId) await enqueueJob(db, { type: "submit_marketplace_shipment", channel: s.channel, payload: { shipmentId: id }, idempotencyKey: `submit-shipment:${id}` }); return s; }
export const markReady = (db: DbClient, id: string) => transition(db,id,ShipmentStatus.Ready);
export const markShipped = (db: DbClient, id: string, p?: any) => transition(db,id,ShipmentStatus.InTransit,p);
export const markDelivered = (db: DbClient, id: string, p?: any) => transition(db,id,ShipmentStatus.Delivered,p);
export const markDeliveryFailed = (db: DbClient, id: string, p?: any) => transition(db,id,ShipmentStatus.DeliveryFailed,p);
export const cancelShipment = (db: DbClient, id: string, p?: any) => transition(db,id,ShipmentStatus.Cancelled,p);
export const markReturned = (db: DbClient, id: string, p?: any) => transition(db,id,ShipmentStatus.Returned,p);
export async function assignTracking(db: DbClient, id: string, input: any) { const s = await getShipment(db,id); await db.update(shipments).set({ trackingNumber: input.trackingNumber, trackingUrl: input.trackingUrl, carrierCode: input.carrierCode ?? s.carrierCode, customCarrierName: input.customCarrierName, updatedAt: new Date().toISOString() }).where(eq(shipments.id,id)).run(); await event(db,id,"tracking_assigned",s.status,s.status,input); return getShipment(db,id); }
export async function updateShipment(db: DbClient, id: string, input: any) { await getShipment(db,id); await db.update(shipments).set({ customCarrierName: input.customCarrierName, trackingUrl: input.trackingUrl, shippingCost: input.shippingCost, updatedAt: new Date().toISOString() }).where(eq(shipments.id,id)).run(); await event(db,id,"updated",undefined,undefined,input); return getShipment(db,id); }
export const getShipmentEvents = (db: DbClient, id: string) => db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId,id)).orderBy(desc(shipmentEvents.createdAt));
export const getShipmentTracking = (db: DbClient, id: string) => db.select().from(shipmentTrackingUpdates).where(eq(shipmentTrackingUpdates.shipmentId,id)).orderBy(desc(shipmentTrackingUpdates.createdAt));
export async function refreshTracking(db: DbClient, id: string, input: any = {}) { const s = await getShipment(db,id); const normalized = input.normalizedStatus ?? (String(input.externalStatus ?? "").toLowerCase().includes("deliver") ? ShipmentStatus.Delivered : undefined); await db.insert(shipmentTrackingUpdates).values({ id: randomUUID(), shipmentId: id, source: input.source ?? s.channel ?? s.carrierCode, externalStatus: input.externalStatus, normalizedStatus: normalized, location: input.location, description: input.description, occurredAt: input.occurredAt, payloadSnapshot: JSON.stringify(input.payload ?? {}), createdAt: new Date().toISOString() }).onConflictDoNothing().run(); if (normalized === ShipmentStatus.Delivered && s.status === ShipmentStatus.InTransit) await markDelivered(db,id); if (normalized === ShipmentStatus.DeliveryFailed && s.status === ShipmentStatus.InTransit) await markDeliveryFailed(db,id); return getShipmentTracking(db,id); }
/**
 * Sprint 80 correction: the merchandise amount comparable to order.totalAmount is derived from
 * the invoice's persisted LINE values, never the invoice's grand total directly - the grand total
 * also includes the invoice's own shipping charge/VAT, and (when pricesIncludeVat is false) VAT
 * itself, neither of which order.totalAmount ever carries (order.totalAmount is always the raw
 * merchandise price sum - see use-cases/order/useCases.ts, taxAmount is hardcoded 0). For each
 * line, lineTotal === taxableBase + vatAmount always holds (Automatic and ManualOverride alike -
 * see calculateInvoiceTotals), so lineTotal - taxVatAmount recovers that line's net taxable base
 * without recomputing VAT. In VAT-inclusive mode the order was priced as the gross amount, so
 * lineTotal (gross) is the comparable figure instead. Both already reflect line-level and
 * invoice-level-allocated discounts, since they are the final persisted, post-allocation values.
 */
function invoiceLineMerchandiseAmount(pricesIncludeVat: boolean, lineTotal: number, taxVatAmount: number): number {
  return pricesIncludeVat ? lineTotal : lineTotal - taxVatAmount;
}

/**
 * Sprint 80 correction: defensive validation of persisted invoice/line values before they are
 * trusted for sale completion - never repairs or mutates the invoice, only rejects impossible
 * data with a clear issue. Normal application paths (calculateInvoiceTotals, Sprint 79's
 * numeric-validation module) already guarantee these invariants at write time; this guards only
 * against an already-corrupted persisted row (e.g. direct SQL) reaching financial completion.
 */
function validateInvoiceFinancialSanity(inv: any, lines: any[]): string[] {
  const issues: string[] = [];
  if (!Number.isFinite(inv.totalAmount)) issues.push("SalesInvoice total is not a valid number");
  else if (inv.totalAmount < 0) issues.push("SalesInvoice total cannot be negative");
  if (!Number.isFinite(inv.taxVatAmount)) issues.push("SalesInvoice VAT is not a valid number");
  else if (inv.taxVatAmount < 0) issues.push("SalesInvoice VAT cannot be negative");
  if (Number.isFinite(inv.totalAmount) && Number.isFinite(inv.taxVatAmount) && inv.taxVatAmount > inv.totalAmount) issues.push("SalesInvoice VAT cannot exceed the invoice total");
  for (const l of lines) {
    if (!Number.isFinite(l.lineTotal)) { issues.push(`Invoice line "${l.titleSnapshot}" total is not a valid number`); continue; }
    if (!Number.isFinite(l.taxVatAmount)) { issues.push(`Invoice line "${l.titleSnapshot}" VAT is not a valid number`); continue; }
    if (l.taxVatAmount < 0) issues.push(`Invoice line "${l.titleSnapshot}" VAT cannot be negative`);
    if (l.taxVatAmount > l.lineTotal) issues.push(`Invoice line "${l.titleSnapshot}" VAT cannot exceed the line total`);
  }
  return issues;
}

/**
 * Sprint 80: the completed-sale financial snapshot's tax/revenue values must come from an
 * immutable, already-issued SalesInvoice - never recomputed from order.taxAmount (always 0 for
 * internal orders), VAT rates, tax treatment, or company-profile defaults. Eligible only when
 * exactly one SalesInvoice exists for the order, its status is Issued or Paid, its currency is
 * EUR, its persisted values pass sanity validation, and its persisted merchandise-line basis
 * (excluding invoice shipping) matches what the order actually charged - this is a read of
 * already-persisted invoice totals, not a recalculation of them (see erpSalesFinanceBridge.ts's
 * calculateInvoiceTotals for where that calculation actually lives).
 */
async function getEligibleSalesInvoiceForSaleCompletion(db: DbClient, orderId: string, orderTotalAmount: number): Promise<{ issues: string[]; invoice: { id: string; totalAmount: number; taxVat: number } | null }> {
  const rows = await db.select().from(invoices).where(and(eq(invoices.orderId, orderId), eq(invoices.invoiceType, ErpInvoiceType.SalesInvoice)));
  if (rows.length === 0) return { issues: ["No SalesInvoice exists for this order"], invoice: null };
  if (rows.length > 1) return { issues: ["Multiple historical SalesInvoice records exist for this order and are ambiguous"], invoice: null };
  const inv: any = rows[0];
  const issues: string[] = [];
  if (![ErpInvoiceStatus.Issued, ErpInvoiceStatus.Paid].includes(inv.status)) issues.push(`SalesInvoice status "${inv.status}" is not eligible for sale completion (must be Issued or Paid)`);
  if (inv.currency !== "EUR") issues.push("SalesInvoice currency must be EUR");
  if (issues.length) return { issues, invoice: null };
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
  issues.push(...validateInvoiceFinancialSanity(inv, lines));
  if (issues.length) return { issues, invoice: null };
  const merchandiseBasis = lines.reduce((sum: number, l: any) => sum + invoiceLineMerchandiseAmount(!!inv.pricesIncludeVat, l.lineTotal, l.taxVatAmount), 0);
  if (!Number.isFinite(merchandiseBasis) || merchandiseBasis < 0) issues.push("SalesInvoice merchandise basis is not a valid number");
  else if (roundMoney(merchandiseBasis) !== roundMoney(orderTotalAmount)) issues.push("SalesInvoice merchandise total does not match the order total");
  if (issues.length) return { issues, invoice: null };
  return { issues: [], invoice: { id: inv.id, totalAmount: inv.totalAmount, taxVat: inv.taxVatAmount } };
}
export async function getSaleCompletionReadiness(db: DbClient, orderId: string) { const o = await getOrderRow(db, orderId); const issues: string[] = []; if (o.paymentStatus !== PaymentStatus.Paid) issues.push("Order is unpaid"); const rows = await listShipments(db,{orderId}); const ship = rows.find((s)=>!terminal.includes(s.status as ShipmentStatus)); if (!ship || ![ShipmentStatus.InTransit,ShipmentStatus.Delivered].includes(ship.status as ShipmentStatus)) issues.push("Shipment must be at least in transit"); if (ship?.channel && ship.marketplaceFulfillmentStatus !== MarketplaceFulfillmentStatus.Accepted) issues.push("Marketplace fulfillment must be accepted"); const itemRows = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)); for (const item of itemRows) { const [p] = await db.select().from(products).where(eq(products.id,item.productId)); if (p?.purchaseCost == null) issues.push(`Missing cost data for ${item.productSku}`); } issues.push(...(await getEligibleSalesInvoiceForSaleCompletion(db, orderId, o.totalAmount)).issues); return { orderId, ready: issues.length === 0, issues, shipment: ship }; }
export async function completeSale(db: DbClient, orderId: string) {
  const driver = process.env.DATABASE_DRIVER === "postgres" || process.env.DATABASE_DRIVER === "supabase-postgres" ? process.env.DATABASE_DRIVER : "sqlite";
  const context = createSalesApplicationContextForDb({ db, driver, logger: {}, clock: { now: () => new Date() }, idGenerator: { newId: () => randomUUID() } });
  return new CompleteSaleApplicationAdapter(context, {
    findFinancials: async (id) => ((await db.select().from(saleFinancials).where(eq(saleFinancials.orderId, id)))[0] as LegacySaleFinancials | undefined) ?? null,
    getReadiness: async (id) => { const value = await getSaleCompletionReadiness(db, id); return { orderId: value.orderId, ready: value.ready, issues: value.issues, shipment: value.shipment ? { id: value.shipment.id, shippingCost: value.shipment.shippingCost } : null }; },
    getProductCosts: async (lines) => new Map(await Promise.all(lines.map(async (line) => { const [product] = await db.select().from(products).where(eq(products.id, line.productId ?? "")); return [line.productId ?? "", product?.purchaseCost ?? null] as const; }))),
    prepareSourceSnapshot: async (sale) => JSON.stringify({ order: await getOrderRow(db, sale.id), items: await db.select().from(orderItems).where(eq(orderItems.orderId, sale.id)) }),
    getEligibleInvoice: async (id) => (await getEligibleSalesInvoiceForSaleCompletion(db, id, (await getOrderRow(db, id)).totalAmount)).invoice,
  }).execute(orderId);
}
export async function reopenSale() { throw new BadRequestError("Completed sale reversal is deferred to a safe Sprint 15 path"); }
export function safeShippingError(error: unknown) { return { type: ShippingError.Unknown, message: clean(error), retryable: false }; }

export async function submitMarketplaceShipment(db: DbClient, shipmentId: string) {
  const s = await getShipment(db, shipmentId);
  if (!s.channel) return s;
  if (s.externalFulfillmentId && s.marketplaceFulfillmentStatus === MarketplaceFulfillmentStatus.Accepted) return s;
  const [mo] = s.marketplaceOrderId ? await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.id, s.marketplaceOrderId)) : await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.internalOrderId, s.orderId));
  if (!mo) { await db.update(shipments).set({ marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Failed, lastError: "Marketplace order not found", updatedAt: new Date().toISOString() }).where(eq(shipments.id, shipmentId)); await event(db, shipmentId, "marketplace_fulfillment_failed", s.status, s.status, {}, "Marketplace order not found"); throw { type: ShippingError.NotFound, message: "Marketplace order not found", retryable: false }; }
  const [conn] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.id, mo.marketplaceConnectionId));
  if (!conn?.encryptedAccessToken) { await db.update(shipments).set({ marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Failed, lastError: "Marketplace connection missing", updatedAt: new Date().toISOString() }).where(eq(shipments.id, shipmentId)); await event(db, shipmentId, "marketplace_fulfillment_failed", s.status, s.status, {}, "Marketplace connection missing"); throw { type: ShippingError.Authentication, message: "Marketplace connection missing", retryable: false }; }
  if (!s.trackingNumber && s.carrierCode !== CarrierCode.LocalPickup) throw { type: ShippingError.Validation, message: "Tracking number is required", retryable: false };
  const adapter = adapterResolver(s.channel);
  try {
    await db.update(shipments).set({ marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Submitted, lastError: null, updatedAt: new Date().toISOString() }).where(eq(shipments.id, shipmentId));
    const result: any = s.externalFulfillmentId ? await adapter.updateShipmentTracking(decryptCredential(conn.encryptedAccessToken), s.externalFulfillmentId, { shipment: s, externalOrderId: mo.externalOrderId }) : await adapter.submitShipment(decryptCredential(conn.encryptedAccessToken), { shipment: s, externalOrderId: mo.externalOrderId, trackingNumber: s.trackingNumber, carrierCode: s.carrierCode });
    await db.update(shipments).set({ externalFulfillmentId: result.externalFulfillmentId ?? s.externalFulfillmentId, marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Accepted, lastError: null, updatedAt: new Date().toISOString() }).where(eq(shipments.id, shipmentId));
    await event(db, shipmentId, "marketplace_fulfillment_accepted", s.status, s.status, { externalFulfillmentId: result.externalFulfillmentId });
    return getShipment(db, shipmentId);
  } catch (e) {
    const err = adapter.normalizeShipmentError(e);
    await db.update(shipments).set({ marketplaceFulfillmentStatus: MarketplaceFulfillmentStatus.Failed, lastError: `${err.type}: ${err.message}`, updatedAt: new Date().toISOString() }).where(eq(shipments.id, shipmentId));
    await event(db, shipmentId, "marketplace_fulfillment_failed", s.status, s.status, {}, err.message);
    throw { type: err.type, message: err.message, retryable: err.retryable };
  }
}
export async function refreshShipmentStatus(db: DbClient, shipmentId: string) { const s = await getShipment(db, shipmentId); if (!s.channel || !s.externalFulfillmentId) return s; const [mo] = s.marketplaceOrderId ? await db.select().from(marketplaceOrders).where(eq(marketplaceOrders.id, s.marketplaceOrderId)) : []; if (!mo) return s; const [conn] = await db.select().from(marketplaceConnections).where(eq(marketplaceConnections.id, mo.marketplaceConnectionId)); if (!conn?.encryptedAccessToken) throw { type: ShippingError.Authentication, message: "Marketplace connection missing", retryable: false }; const result = await adapterResolver(s.channel).fetchShipmentStatus(decryptCredential(conn.encryptedAccessToken), s.externalFulfillmentId); await db.update(shipments).set({ marketplaceFulfillmentStatus: String(result.marketplaceStatus ?? s.marketplaceFulfillmentStatus), updatedAt: new Date().toISOString() }).where(eq(shipments.id, shipmentId)); await event(db, shipmentId, "marketplace_fulfillment_refreshed", s.status, s.status, result); return getShipment(db, shipmentId); }
