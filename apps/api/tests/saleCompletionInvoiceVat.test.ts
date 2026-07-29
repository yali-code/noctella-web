import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, beforeEach } from "vitest";
import { CarrierCode, ErpInvoiceStatus, MarketplaceFulfillmentStatus, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType, ShipmentStatus } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { completeSale, getSaleCompletionReadiness } from "../src/services/shipments";
import { reverseCompletedSale, getSaleReversalReadiness } from "../src/services/returns";
import { adjustedFinancials, createInvoiceDraft, financeSummary, issueInvoice, listFinanceEntries, listInvoices, setInvoiceStatus, updateInvoiceDraft } from "../src/services/erpSalesFinanceBridge";
import { upsertCompanyProfile } from "../src/services/companyProfile";

/**
 * Sprint 80: completed-sale financials must be sourced from the immutable, already-issued
 * SalesInvoice - never recomputed from order.taxAmount (always 0 for internal orders), VAT
 * rates, tax treatment, or company-profile defaults. This file proves the eligibility gate,
 * the exact acceptance calculation, completion idempotency, and full-reversal behavior.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;
const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };
const companyProfileVatInclusive = { legalName: "Noctella Test Trading Ltd.", registrationNumber: "TEST-UIC-VAT", vatNumber: "TESTVATVAT", addressLine1: "1 Test Row", city: "Testville", postalCode: "00000", country: "FR", email: "billing@example-noctella-vat.invalid", phone: "+00 000 000 000", defaultVatRate: 20, defaultPricesIncludeVat: true };

function memoryDb() { const sqlite = new Database(":memory:"); sqlite.pragma("foreign_keys = ON"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any as Db }; }
let seq = 0;
/** Product priced at EUR 120 gross (VAT-inclusive, 20%), purchaseCost EUR 42 (as if already
 * landed-cost-synced from a purchase - see purchaseLandedCostProductSync.test.ts for that path). */
async function seedAcceptanceProduct(db: any) {
  seq += 1;
  const cat = await createCategory(db, { name: `Cat-VAT-${seq}`, displayOrder: 0, isActive: true });
  return createProduct(db, { sku: `SKU-VAT-${seq}`, title: `Acceptance Item ${seq}`, slug: `acceptance-item-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 120, purchaseCost: 42, stockQuantity: 1, images: [] });
}
async function paidOrder(db: any, product: any, totalAmount = 120) {
  seq += 1;
  const ref = `pay-ref-vat-${seq}`;
  await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: ref, status: PaymentStatus.Paid, amount: totalAmount, currency: "EUR", idempotencyKey: `test:${ref}` });
  return createOrder(db, { orderDraftId: `draft-vat-${seq}`, guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: ref, currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: totalAmount, totalAmount, items: [{ productId: product.id, quantity: 1 as const }] });
}
async function shipInTransit(db: any, orderId: string, shippingCost = 0) {
  const id = `ship-vat-${seq}-${Math.random()}`;
  await db.insert(schema.shipments).values({ id, orderId, carrierCode: CarrierCode.LocalPickup, status: ShipmentStatus.InTransit, shippingCost, currency: "EUR", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return id;
}
async function draftInvoiceFor(db: any, orderId: string) { return (await listInvoices(db, { orderId })).items[0] as any; }

describe("Sprint 80: completed-sale financials are sourced from the issued SalesInvoice, not order.taxAmount", () => {
  let db: Db;
  beforeEach(async () => { const m = memoryDb(); db = m.db; await upsertCompanyProfile(db, companyProfileVatInclusive); });

  describe("invoice eligibility gates completion", () => {
    it("missing invoice blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await setInvoiceStatus(db, invoice.id, ErpInvoiceStatus.Cancelled); // remove the only SalesInvoice's eligibility without deleting the row
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.ready).toBe(false);
      expect(readiness.issues.join(" ")).toMatch(/not eligible/i);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("Draft invoice blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.issues.join(" ")).toMatch(/must be Issued or Paid/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("Issued invoice permits completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id);
      expect((await getSaleCompletionReadiness(db, order.id)).ready).toBe(true);
      expect((await completeSale(db, order.id)).status).toBe(OrderStatus.Completed);
    });

    it("Paid invoice permits completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await setInvoiceStatus(db, invoice.id, ErpInvoiceStatus.Paid);
      await shipInTransit(db, order.id);
      expect((await getSaleCompletionReadiness(db, order.id)).ready).toBe(true);
      expect((await completeSale(db, order.id)).status).toBe(OrderStatus.Completed);
    });

    it("Cancelled invoice blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await setInvoiceStatus(db, invoice.id, ErpInvoiceStatus.Cancelled);
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.issues.join(" ")).toMatch(/must be Issued or Paid/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("Voided invoice blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await setInvoiceStatus(db, invoice.id, ErpInvoiceStatus.Voided);
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.issues.join(" ")).toMatch(/must be Issued or Paid/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("invoice/order total mismatch blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      // A caller-supplied Draft discount desyncs the invoice total from what the order actually charged.
      await updateInvoiceDraft(db, invoice.id, { discountAmount: 10 });
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.issues.join(" ")).toMatch(/total does not match/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("non-EUR invoice blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await db.update(schema.invoices).set({ currency: "USD" }).where(eq(schema.invoices.id, invoice.id));
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.issues.join(" ")).toMatch(/currency must be EUR/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("historical duplicate invoice ambiguity blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      // Simulate a pre-Sprint-79 historical duplicate SalesInvoice for the same order (see
      // invoiceMigrationHistoricalDuplicatesSprint79.test.ts - a real, tolerated data shape).
      const t = new Date().toISOString();
      await db.insert(schema.invoices).values({ id: "dup-invoice", orderId: order.id, customerId: null, invoiceNumber: null, invoiceType: "SalesInvoice", status: ErpInvoiceStatus.Draft, currency: "EUR", calculationMode: "Automatic", taxTreatment: "StandardVAT", pricesIncludeVat: true, sellerSnapshot: "{}", customerSnapshot: "{}", subtotal: 100, shippingAmount: 0, shippingVatRate: 0, shippingVatAmount: 0, discountAmount: 0, taxVatAmount: 20, totalAmount: 120, sourceSnapshot: "{}", createdAt: t, updatedAt: t });
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.issues.join(" ")).toMatch(/ambiguous/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("caller cannot supply or override VAT manually - completeSale takes only an orderId", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id);
      const result: any = await completeSale(db, order.id);
      expect(result.status).toBe(OrderStatus.Completed);
      expect(result.financials.taxVat).toBe(20);
      // No caller-supplied VAT/amount parameter exists on completeSale's signature at all.
      expect(completeSale.length).toBe(2);
    });

    it("company-profile edits after issue do not alter completed-sale tax", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id);
      await upsertCompanyProfile(db, { defaultVatRate: 0, defaultPricesIncludeVat: false });
      const result: any = await completeSale(db, order.id);
      expect(result.financials.taxVat).toBe(20);
      expect(result.financials.grossRevenue).toBe(120);
    });
  });

  describe("exact acceptance calculation (EUR 120 / 20 / 100 / 42 / 58)", () => {
    it("produces grossRevenue 120, taxVat 20, netRevenue 100, itemCost 42, profit 58", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      expect(invoice.totalAmount).toBe(120);
      expect(invoice.taxVatAmount).toBe(20);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id, 0);
      const result: any = await completeSale(db, order.id);
      expect(result.status).toBe(OrderStatus.Completed);
      expect(result.financials).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58, currency: "EUR" });
    });
  });

  describe("Sprint 80 correction: merchandise-basis consistency supports both pricing modes and invoice shipping", () => {
    /** Product priced at EUR 100 net (VAT-exclusive, 20%), purchaseCost EUR 42. */
    async function seedExclusiveProduct(db: any) {
      seq += 1;
      const cat = await createCategory(db, { name: `Cat-EXCL-${seq}`, displayOrder: 0, isActive: true });
      return createProduct(db, { sku: `SKU-EXCL-${seq}`, title: `Exclusive Item ${seq}`, slug: `exclusive-item-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 100, purchaseCost: 42, stockQuantity: 1, images: [] });
    }

    it("VAT-exclusive default mode (pricesIncludeVat: false): completion succeeds and produces the exact acceptance figures", async () => {
      await upsertCompanyProfile(db, { defaultVatRate: 20, defaultPricesIncludeVat: false });
      const product = await seedExclusiveProduct(db);
      const order = await paidOrder(db, product, 100);
      const invoice = await draftInvoiceFor(db, order.id);
      expect(invoice.pricesIncludeVat).toBe(false);
      expect(invoice.totalAmount).toBe(120);
      expect(invoice.taxVatAmount).toBe(20);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id, 0);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.ready).toBe(true);
      const result: any = await completeSale(db, order.id);
      expect(result.status).toBe(OrderStatus.Completed);
      expect(result.financials).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58, currency: "EUR" });
    });

    it("VAT-inclusive mode (pricesIncludeVat: true) produces the identical figures as the exclusive scenario", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product, 120);
      const invoice = await draftInvoiceFor(db, order.id);
      expect(invoice.pricesIncludeVat).toBe(true);
      expect(invoice.totalAmount).toBe(120);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id, 0);
      const result: any = await completeSale(db, order.id);
      expect(result.financials).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });
    });

    it("a legitimate invoice-level shipping charge is excluded from the merchandise comparison but included in gross revenue and VAT", async () => {
      await upsertCompanyProfile(db, { defaultVatRate: 20, defaultPricesIncludeVat: false });
      const product = await seedExclusiveProduct(db);
      const order = await paidOrder(db, product, 100);
      const invoice = await draftInvoiceFor(db, order.id);
      await updateInvoiceDraft(db, invoice.id, { shippingAmount: 10, shippingVatRate: 20 });
      const issued: any = await issueInvoice(db, invoice.id, {});
      expect(issued.totalAmount).toBe(132); // 100 net + 20 VAT + 10 shipping + 2 shipping VAT
      expect(issued.taxVatAmount).toBe(22); // line VAT (20) + shipping VAT (2)
      // The sale-side shipment cost is a completely separate figure (what the seller pays to ship
      // to the end customer) from the invoice's shipping CHARGE (what the customer is billed) -
      // set to a distinct, nonzero value here to prove neither is confused with the other.
      await shipInTransit(db, order.id, 5);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.ready).toBe(true);
      expect(readiness.issues).toEqual([]);
      const result: any = await completeSale(db, order.id);
      expect(result.status).toBe(OrderStatus.Completed);
      // grossRevenue includes the FULL issued invoice total (merchandise + shipping + all VAT).
      expect(result.financials.grossRevenue).toBe(132);
      // taxVat includes both the line VAT and the shipping VAT.
      expect(result.financials.taxVat).toBe(22);
      // shippingCost is the sale-side shipment's own cost (5), never the invoice's shipping charge (10) - not subtracted twice.
      expect(result.financials.shippingCost).toBe(5);
      expect(result.financials.netRevenue).toBe(132 - 22 - 5);
      expect(result.financials.itemCost).toBe(42);
      expect(result.financials.profit).toBe(132 - 22 - 5 - 42);
    });

    it("a genuine merchandise-total mismatch (not merely invoice shipping/VAT) still blocks completion", async () => {
      await upsertCompanyProfile(db, { defaultVatRate: 20, defaultPricesIncludeVat: false });
      const product = await seedExclusiveProduct(db);
      const order = await paidOrder(db, product, 100);
      const invoice = await draftInvoiceFor(db, order.id);
      // A Draft discount reduces the actual merchandise basis below what the order charged.
      await updateInvoiceDraft(db, invoice.id, { discountAmount: 10 });
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.ready).toBe(false);
      expect(readiness.issues.join(" ")).toMatch(/merchandise total does not match/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });
  });

  describe("Sprint 80 correction: defensive validation of persisted invoice values", () => {
    it("a corrupted invoice VAT (negative) blocks completion with a clear issue, never silently coerced", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      const [line] = await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.id));
      await db.update(schema.invoiceLines).set({ taxVatAmount: -5 }).where(eq(schema.invoiceLines.id, line.id));
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.ready).toBe(false);
      expect(readiness.issues.join(" ")).toMatch(/VAT cannot be negative/);
      expect((await completeSale(db, order.id)).status).toBe("blocked");
    });

    it("a corrupted invoice VAT exceeding the invoice total blocks completion", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await db.update(schema.invoices).set({ taxVatAmount: 999 }).where(eq(schema.invoices.id, invoice.id));
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.ready).toBe(false);
      expect(readiness.issues.join(" ")).toMatch(/VAT cannot exceed the invoice total/);
    });

    it("a non-finite persisted invoice total (Infinity) blocks completion rather than propagating it", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await db.update(schema.invoices).set({ totalAmount: Number.POSITIVE_INFINITY }).where(eq(schema.invoices.id, invoice.id));
      await shipInTransit(db, order.id);
      const readiness = await getSaleCompletionReadiness(db, order.id);
      expect(readiness.ready).toBe(false);
      expect(readiness.issues.join(" ")).toMatch(/not a valid number/);
    });
  });

  describe("completion idempotency", () => {
    it("repeated completion returns the same snapshot, creates no duplicate finance entry, and never recalculates from later mutable records", async () => {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id);
      const first: any = await completeSale(db, order.id);
      // Mutating the product price/purchaseCost after completion must not affect the replay.
      await db.update(schema.products).set({ purchaseCost: 999, priceEur: 999 }).where(eq(schema.products.id, product.id));
      const second: any = await completeSale(db, order.id);
      expect(second.alreadyCompleted).toBe(true);
      // Compared on the financial fields only - the first-completion response and a replay read
      // back from the DB row have known, pre-existing, unrelated shape differences in
      // sourceSnapshot/saleId (the repository persists JSON.stringify(snapshot), while the
      // in-memory first-completion response carries the richer order+items snapshot instead).
      expect(second.financials).toMatchObject({ grossRevenue: first.financials.grossRevenue, taxVat: first.financials.taxVat, netRevenue: first.financials.netRevenue, itemCost: first.financials.itemCost, profit: first.financials.profit, id: first.financials.id, completedAt: first.financials.completedAt });
      expect((await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId, order.id)))).toHaveLength(1);
      expect((await listFinanceEntries(db, { entryType: "CompleteSale" })).items).toHaveLength(1);
    });
  });

  describe("full-sale reversal uses the original persisted snapshot, not current mutable state", () => {
    async function completedOrder() {
      const product = await seedAcceptanceProduct(db);
      const order = await paidOrder(db, product);
      const invoice = await draftInvoiceFor(db, order.id);
      await issueInvoice(db, invoice.id, {});
      await shipInTransit(db, order.id, 0);
      await completeSale(db, order.id);
      return { product, order };
    }

    it("full reversal negates the original grossRevenue exactly and does not use a EUR 0 marker", async () => {
      const { order, product } = await completedOrder();
      const [sf] = await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId, order.id));
      expect(sf).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });
      // A full return + full refund is required for reverseCompletedSale's readiness (see returnsCompatibility.ts).
      const t = new Date().toISOString();
      await db.insert(schema.returnRequests).values({ id: "ret-full", orderId: order.id, status: "completed", reason: "Return", requestedResolution: "Refund", requestedAt: t, completedAt: t, createdAt: t, updatedAt: t });
      await db.insert(schema.returnItems).values({ id: "ri-full", returnRequestId: "ret-full", orderItemId: order.items[0].id, productId: product.id, quantityRequested: 1, quantityApproved: 1, quantityReceived: 1, createdAt: t, updatedAt: t });
      await db.insert(schema.refunds).values({ id: "refund-full", orderId: order.id, type: "full", status: "succeeded", currency: "EUR", subtotalAmount: 120, shippingAmount: 0, taxAmount: 0, totalAmount: 120, idempotencyKey: "refund-full-vat", createdAt: t, updatedAt: t });
      expect((await getSaleReversalReadiness(db, order.id)).ready).toBe(true);
      const reversal: any = await reverseCompletedSale(db, { orderId: order.id, returnRequestId: "ret-full", refundId: "refund-full" });
      const [entry] = await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.saleReversalId, reversal.id));
      // The exact "full reversal economic effect": grossRevenue reversal -120 (not the old 0 marker).
      expect(entry.amount).toBe(-120);
      expect(entry.amount).not.toBe(0);
      const embeddedOriginal = JSON.parse(reversal.sourceSnapshot).saleFinancial;
      expect(embeddedOriginal).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });
      // The full breakdown's negation is derivable from the preserved original snapshot without recomputation.
      expect(-embeddedOriginal.taxVat).toBe(-20);
      expect(-embeddedOriginal.netRevenue).toBe(-100);
      expect(-embeddedOriginal.itemCost).toBe(-42);
      expect(-embeddedOriginal.profit).toBe(-58);
    });

    it("reversal is idempotent and does not recompute from a since-changed invoice, product price, or company profile", async () => {
      const { order, product } = await completedOrder();
      const t = new Date().toISOString();
      await db.insert(schema.returnRequests).values({ id: "ret-idem", orderId: order.id, status: "completed", reason: "Return", requestedResolution: "Refund", requestedAt: t, completedAt: t, createdAt: t, updatedAt: t });
      await db.insert(schema.returnItems).values({ id: "ri-idem", returnRequestId: "ret-idem", orderItemId: order.items[0].id, productId: product.id, quantityRequested: 1, quantityApproved: 1, quantityReceived: 1, createdAt: t, updatedAt: t });
      await db.insert(schema.refunds).values({ id: "refund-idem", orderId: order.id, type: "full", status: "succeeded", currency: "EUR", subtotalAmount: 120, shippingAmount: 0, taxAmount: 0, totalAmount: 120, idempotencyKey: "refund-idem-vat", createdAt: t, updatedAt: t });
      const first: any = await reverseCompletedSale(db, { orderId: order.id, returnRequestId: "ret-idem", refundId: "refund-idem" });
      await db.update(schema.products).set({ purchaseCost: 1 }).where(eq(schema.products.id, product.id));
      await upsertCompanyProfile(db, { defaultVatRate: 0 });
      const second: any = await reverseCompletedSale(db, { orderId: order.id, returnRequestId: "ret-idem", refundId: "refund-idem" });
      expect(second.id).toBe(first.id);
      expect((await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.saleReversalId, first.id)))).toHaveLength(1);
    });

    it("Sprint 80 correction: a full reversal is effective in adjustedFinancials/financeSummary - before reversal shows 120/20/100/42/58, after reversal shows 0/0/0/0/0, while the original snapshot stays preserved for audit", async () => {
      const { order, product } = await completedOrder();
      const before = await adjustedFinancials(db, order.id);
      expect(before).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });
      const summaryBefore = await financeSummary(db);
      expect(summaryBefore).toMatchObject({ grossRevenue: 120, itemCost: 42, profit: 58 });

      const t = new Date().toISOString();
      await db.insert(schema.returnRequests).values({ id: "ret-fx", orderId: order.id, status: "completed", reason: "Return", requestedResolution: "Refund", requestedAt: t, completedAt: t, createdAt: t, updatedAt: t });
      await db.insert(schema.returnItems).values({ id: "ri-fx", returnRequestId: "ret-fx", orderItemId: order.items[0].id, productId: product.id, quantityRequested: 1, quantityApproved: 1, quantityReceived: 1, createdAt: t, updatedAt: t });
      await db.insert(schema.refunds).values({ id: "refund-fx", orderId: order.id, type: "full", status: "succeeded", currency: "EUR", subtotalAmount: 120, shippingAmount: 0, taxAmount: 0, totalAmount: 120, idempotencyKey: "refund-fx-vat", createdAt: t, updatedAt: t });
      const reversal: any = await reverseCompletedSale(db, { orderId: order.id, returnRequestId: "ret-fx", refundId: "refund-fx" });

      const after = await adjustedFinancials(db, order.id);
      expect(after).toMatchObject({ grossRevenue: 0, taxVat: 0, netRevenue: 0, itemCost: 0, profit: 0 });
      // Not double-subtracted: the full refund that made the reversal possible must not ALSO
      // reduce an already-zeroed net/profit figure into the negative.
      expect(after.netRetainedRevenue).toBe(0);
      expect(after.adjustedProfit).toBe(0);

      const summaryAfter = await financeSummary(db);
      expect(summaryAfter).toMatchObject({ grossRevenue: 0, itemCost: 0, profit: 0 });

      // The original sale_financials row (audit trail) is untouched.
      const [sf] = await db.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId, order.id));
      expect(sf).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });
      const [entry] = await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.saleReversalId, reversal.id));
      expect(entry.amount).toBe(-120);
      expect(JSON.parse(reversal.sourceSnapshot).saleFinancial).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });

      // Repeated reversal remains idempotent and the effective figures stay at zero.
      await reverseCompletedSale(db, { orderId: order.id, returnRequestId: "ret-fx", refundId: "refund-fx" });
      expect(await adjustedFinancials(db, order.id)).toMatchObject({ grossRevenue: 0, taxVat: 0, netRevenue: 0, itemCost: 0, profit: 0 });
    });

    it("Sprint 80 correction: a partial refund without a full reversal keeps existing net-of-refund behavior unchanged", async () => {
      const { order } = await completedOrder();
      await db.insert(schema.refunds).values({ id: "refund-partial-vat", orderId: order.id, type: "partial", status: "succeeded", currency: "EUR", subtotalAmount: 30, shippingAmount: 0, taxAmount: 0, totalAmount: 30, idempotencyKey: "refund-partial-vat-key", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const result = await adjustedFinancials(db, order.id);
      // No reversal exists, so figures remain the original ones, net only of the partial refund - unchanged pre-existing behavior.
      expect(result.grossRevenue).toBe(120);
      expect(result.totalRefunded).toBe(30);
      expect(result.netRetainedRevenue).toBe(100 - 30);
      expect(result.adjustedProfit).toBe(58 - 30);
    });
  });
});
