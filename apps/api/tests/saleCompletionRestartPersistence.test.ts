import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CarrierCode, ErpInvoiceStatus, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType, ShipmentStatus } from "@noctella/shared";
import { createDatabaseRuntime } from "../src/db/runtime";
import type { DbClient } from "../src/db/client";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { completeSale } from "../src/services/shipments";
import { reverseCompletedSale } from "../src/services/returns";
import { adjustedFinancials, issueInvoice, listInvoices } from "../src/services/erpSalesFinanceBridge";
import { upsertCompanyProfile } from "../src/services/companyProfile";

const address = { fullName: "Restart Tester", line1: "1 Persistence Way", city: "Paris", postalCode: "75001", country: "FR" };

describe("Sprint 80: issued-invoice VAT, completed-sale financials, and reversal persist across independent API runtimes", () => {
  let tempDir: string | undefined;
  afterEach(async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); tempDir = undefined; });

  it("persists invoice VAT, sale financials, and a full reversal's finance entry across two independent runtimes opened against the same file", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-sale-completion-restart-"));
    const dbFile = path.join(tempDir, "restart-test.sqlite");
    const env = { DATABASE_DRIVER: "sqlite", DATABASE_URL: dbFile } as unknown as NodeJS.ProcessEnv;

    const first = createDatabaseRuntime(env);
    const dbFirst = first.db as DbClient;

    await upsertCompanyProfile(dbFirst, { legalName: "Noctella Restart Ltd.", registrationNumber: "T-RESTART", vatNumber: "TESTVATRESTART", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 20, defaultPricesIncludeVat: true });
    const category = await createCategory(dbFirst, { name: "Restart Category", displayOrder: 0, isActive: true });
    const product = await createProduct(dbFirst, { sku: "SKU-RESTART-VAT", title: "Restart Item", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 120, purchaseCost: 42, stockQuantity: 1 });
    await createPaymentSession(dbFirst, { provider: PaymentProvider.Stripe, providerReference: "restart-vat-ref", status: PaymentStatus.Paid, amount: 120, currency: "EUR", idempotencyKey: "restart-vat-pay" });
    const order = await createOrder(dbFirst, { orderDraftId: "restart-vat-draft", guestEmail: "restart@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "restart-vat-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 120, totalAmount: 120, items: [{ productId: product.id, quantity: 1 }] });
    const [draftInvoice] = (await listInvoices(dbFirst, { orderId: order.id })).items as any[];
    expect(draftInvoice.totalAmount).toBe(120);
    expect(draftInvoice.taxVatAmount).toBe(20);
    const issued: any = await issueInvoice(dbFirst, draftInvoice.id, {});
    await dbFirst.insert(schema.shipments).values({ id: "restart-ship", orderId: order.id, carrierCode: CarrierCode.LocalPickup, status: ShipmentStatus.InTransit, shippingCost: 0, currency: "EUR", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const completed: any = await completeSale(dbFirst, order.id);
    expect(completed.financials).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });

    const t = new Date().toISOString();
    await dbFirst.insert(schema.returnRequests).values({ id: "restart-return", orderId: order.id, status: "completed", reason: "Return", requestedResolution: "Refund", requestedAt: t, completedAt: t, createdAt: t, updatedAt: t });
    await dbFirst.insert(schema.returnItems).values({ id: "restart-return-item", returnRequestId: "restart-return", orderItemId: order.items[0].id, productId: product.id, quantityRequested: 1, quantityApproved: 1, quantityReceived: 1, createdAt: t, updatedAt: t });
    await dbFirst.insert(schema.refunds).values({ id: "restart-refund", orderId: order.id, type: "full", status: "succeeded", currency: "EUR", subtotalAmount: 120, shippingAmount: 0, taxAmount: 0, totalAmount: 120, idempotencyKey: "restart-refund-key", submittedAt: t, succeededAt: t, createdAt: t, updatedAt: t });
    const reversal: any = await reverseCompletedSale(dbFirst, { orderId: order.id, returnRequestId: "restart-return", refundId: "restart-refund" });

    await first.shutdown();

    const second = createDatabaseRuntime(env);
    const dbSecond = second.db as DbClient;

    const [invoiceAfterRestart] = await dbSecond.select().from(schema.invoices).where(eq(schema.invoices.id, issued.id));
    expect(invoiceAfterRestart.status).toBe(ErpInvoiceStatus.Issued);
    expect(invoiceAfterRestart.totalAmount).toBe(120);
    expect(invoiceAfterRestart.taxVatAmount).toBe(20);

    const [financialsAfterRestart] = await dbSecond.select().from(schema.saleFinancials).where(eq(schema.saleFinancials.orderId, order.id));
    expect(financialsAfterRestart).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });

    const [reversalAfterRestart] = await dbSecond.select().from(schema.saleReversals).where(eq(schema.saleReversals.id, reversal.id));
    expect(reversalAfterRestart.financialsReversed).toBe(true);
    expect(reversalAfterRestart.stockReversed).toBe(true);

    const [reversalEntryAfterRestart] = await dbSecond.select().from(schema.financeEntries).where(eq(schema.financeEntries.saleReversalId, reversal.id));
    expect(reversalEntryAfterRestart.amount).toBe(-120);

    const completeSaleEntries = await dbSecond.select().from(schema.financeEntries).where(eq(schema.financeEntries.orderId, order.id));
    expect(completeSaleEntries.find((e: any) => e.entryType === "CompleteSale")?.amount).toBe(120);
    expect(completeSaleEntries.find((e: any) => e.entryType === "SaleReversal")?.amount).toBe(-120);

    // The original snapshot (audit) and the effective (reversal-aware) projection both persist correctly.
    expect(financialsAfterRestart).toMatchObject({ grossRevenue: 120, taxVat: 20, netRevenue: 100, itemCost: 42, profit: 58 });
    const effectiveAfterRestart = await adjustedFinancials(dbSecond, order.id);
    expect(effectiveAfterRestart).toMatchObject({ grossRevenue: 0, taxVat: 0, netRevenue: 0, itemCost: 0, profit: 0 });

    await second.shutdown();
  });
});
