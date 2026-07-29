import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CarrierCode, ErpInvoiceStatus, LandedCostAllocationMethod, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType, ReturnReason, ReturnResolution, ReturnStockDisposition, ShipmentStatus, SupplierType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createSupplier, createPurchase, markOrdered, receivePurchase, allocatePurchaseCosts } from "../src/services/erpPurchasingBridge";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { completeSale } from "../src/services/shipments";
import { approveReturn, authorizeReturn, completeReturn, createReturnRequest, inspectReturnItem, receiveReturn, reverseCompletedSale } from "../src/services/returns";
import { dispatchDueSalesInvoiceOutboxEvents } from "../src/services/salesInvoiceOutbox";
import { issueInvoice, listInvoices, updateInvoiceDraft } from "../src/services/erpSalesFinanceBridge";
import { upsertCompanyProfile } from "../src/services/companyProfile";

const address = { fullName: "Acceptance Tester", line1: "1 Acceptance Way", city: "Paris", postalCode: "75001", country: "FR" };

/**
 * Sprint 80: one continuous, automated run of the full manual acceptance flow (see the Sprint 80
 * discovery report's "Manual acceptance sequence") against an isolated, disposable, file-backed
 * SQLite database - never the real dev.sqlite, never HERMLE or any real record.
 */
describe("Sprint 80 acceptance lifecycle: supplier -> purchase -> landed cost -> receipt -> publish -> paid sale -> invoice -> complete -> full reversal", () => {
  let tempDir: string | undefined;
  afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); tempDir = undefined; });

  it("runs the complete acceptance chain and produces the exact EUR 120/20/100/42/58 figures, then a full reversal using the original EUR 20 VAT", async () => {
    // A real file-backed SQLite database plus the full supplier/purchase/receipt/publish/sale/
    // invoice/complete/return/reversal chain in one test genuinely takes longer than the 5s default.
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-acceptance-sprint80-"));
    const sqlite = new Database(path.join(tempDir, "acceptance.sqlite"));
    sqlite.pragma("foreign_keys = ON");
    ensureSchema(sqlite);
    const db = drizzle(sqlite, { schema }) as any;

    // Company profile: VAT-inclusive pricing, 20% default rate.
    await upsertCompanyProfile(db, { legalName: "Noctella Acceptance Ltd.", registrationNumber: "T-ACCEPT", vatNumber: "TESTVATACCEPT", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 20, defaultPricesIncludeVat: true });

    // Supplier.
    const supplier = await createSupplier(db, { name: "Acceptance Supplier", supplierType: SupplierType.Dealer });
    expect(supplier.id).toBeTruthy();

    // Product (Draft, unlinked, no stock/cost yet).
    const category = await createCategory(db, { name: "Acceptance Category", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-ACCOUNTING-ACCEPTANCE-01", title: "Accounting Acceptance Test Item", slug: "accounting-acceptance-test-item", type: ProductType.UniqueItem, status: ProductStatus.Draft, categoryId: category.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 120, stockQuantity: 0 });
    expect(product.purchaseCost == null).toBe(true);

    // Purchase with the acceptance scenario's exact landed-cost inputs, linked to the product.
    const purchase = await createPurchase(db, { supplierId: supplier.id, lines: [{ productId: product.id, titleSnapshot: "Accounting Acceptance Test Item", quantity: 1, unitPurchaseCost: 25 }], buyerPremium: 5, shippingCost: 10, packagingCost: 2, customsCost: 0, taxVat: 0, miscellaneousCost: 0, currency: "EUR" });
    expect(purchase.itemSubtotal).toBe(25);
    expect(purchase.totalCost).toBe(42);

    await markOrdered(db, purchase.id);
    const landed = await allocatePurchaseCosts(db, purchase.id, { allocationMethod: LandedCostAllocationMethod.Equal });
    expect(landed.lines[0].landedTotalCost).toBe(42);

    const received = await receivePurchase(db, purchase.id, { idempotencyKey: "acceptance-receive", lines: [{ purchaseLineId: purchase.lines[0].id, quantityReceived: 1 }] });
    expect(received.status).toBe("Received");

    const [productAfterReceipt] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(productAfterReceipt.stockQuantity).toBe(1);
    expect(productAfterReceipt.purchaseCost).toBe(42);

    // Publish.
    await db.update(schema.products).set({ status: ProductStatus.Published }).where(eq(schema.products.id, product.id));

    // Paid internal sale (storefront/internal path - the one that durably auto-enqueues an invoice draft).
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "acceptance-pay-ref", status: PaymentStatus.Paid, amount: 120, currency: "EUR", idempotencyKey: "acceptance-pay" });
    const order = await createOrder(db, { orderDraftId: "acceptance-draft", guestEmail: "acceptance@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "acceptance-pay-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 120, totalAmount: 120, items: [{ productId: product.id, quantity: 1 as const }] });

    const [productAfterSale] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(productAfterSale.stockQuantity).toBe(0);
    expect(productAfterSale.status).toBe(ProductStatus.Sold);

    // Durable invoice outbox - force a dispatch sweep in case the post-commit best-effort attempt
    // hasn't landed, then confirm exactly one Draft SalesInvoice exists.
    await dispatchDueSalesInvoiceOutboxEvents(db, "acceptance-test", 10);
    const invoicesForOrder = (await listInvoices(db, { orderId: order.id })).items as any[];
    expect(invoicesForOrder).toHaveLength(1);
    const draftInvoice = invoicesForOrder[0];
    expect(draftInvoice.status).toBe(ErpInvoiceStatus.Draft);
    expect(draftInvoice.totalAmount).toBe(120);
    expect(draftInvoice.taxVatAmount).toBe(20);

    // Configure/edit VAT (Automatic mode is already correct here; exercise the edit path anyway
    // to prove it stays consistent) and issue.
    await updateInvoiceDraft(db, draftInvoice.id, { shippingVatRate: 20 });
    const issued: any = await issueInvoice(db, draftInvoice.id, {});
    expect(issued.status).toBe(ErpInvoiceStatus.Issued);
    expect(issued.totalAmount).toBe(120);
    expect(issued.taxVatAmount).toBe(20);

    // Complete sale.
    await db.insert(schema.shipments).values({ id: "acceptance-shipment", orderId: order.id, carrierCode: CarrierCode.LocalPickup, status: ShipmentStatus.InTransit, shippingCost: 0, currency: "EUR", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const completed: any = await completeSale(db, order.id);
    expect(completed.status).toBe(OrderStatus.Completed);
    expect(completed.financials).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58, currency: "EUR" });

    // Return, driven through the real authorize -> receive -> inspect(ReturnToStock) -> approve ->
    // complete lifecycle (the same one the Admin UI uses) - completeReturn is what actually
    // performs the ReturnIn stock movement and the Sold -> Published restoration.
    const returnRequest: any = await createReturnRequest(db, { orderId: order.id, channel: "Internal", reason: ReturnReason.Other, requestedResolution: ReturnResolution.Refund, items: [{ orderItemId: order.items[0].id, quantityRequested: 1 }] });
    await authorizeReturn(db, returnRequest.id, {});
    await receiveReturn(db, returnRequest.id, {});
    await inspectReturnItem(db, returnRequest.id, { orderItemId: order.items[0].id, quantityReceived: 1, stockDisposition: ReturnStockDisposition.ReturnToStock });
    await approveReturn(db, returnRequest.id, {});
    await completeReturn(db, returnRequest.id);

    const [productAfterReturn] = await db.select().from(schema.products).where(eq(schema.products.id, product.id));
    expect(productAfterReturn.stockQuantity).toBe(1);
    expect(productAfterReturn.status).toBe(ProductStatus.Published);

    // Full refund/reversal, using the now-Completed return above - the reversal must use the
    // original persisted completed-sale snapshot's EUR 20 VAT, not anything from the return.
    const t = new Date().toISOString();
    await db.insert(schema.refunds).values({ id: "acceptance-refund", orderId: order.id, type: "full", status: "succeeded", currency: "EUR", subtotalAmount: 120, shippingAmount: 0, taxAmount: 0, totalAmount: 120, idempotencyKey: "acceptance-refund-key", createdAt: t, updatedAt: t });
    const reversal: any = await reverseCompletedSale(db, { orderId: order.id, returnRequestId: returnRequest.id, refundId: "acceptance-refund" });
    const embeddedOriginal = JSON.parse(reversal.sourceSnapshot).saleFinancial;
    expect(embeddedOriginal.taxVat).toBe(20);
    const [reversalEntry] = await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.saleReversalId, reversal.id));
    expect(reversalEntry.amount).toBe(-120);

    sqlite.close();
  }, 30_000);
});
