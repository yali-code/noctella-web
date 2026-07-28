import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ErpInvoiceCalculationMode, ErpInvoiceStatus, OrderStatus, PaymentProvider, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";
import { createDatabaseRuntime } from "../src/db/runtime";
import type { DbClient } from "../src/db/client";
import * as schema from "../src/db/schema";
import { createCategory, seedInitialCategoriesIfEmpty } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { createOrderSchema } from "../src/validation/order";
import { upsertCompanyProfile } from "../src/services/companyProfile";
import { getInvoice, issueInvoice, listInvoices, updateInvoiceDraft, updateInvoiceLine } from "../src/services/erpSalesFinanceBridge";

const address = { fullName: "Restart Tester", line1: "1 Persistence Way", city: "Paris", postalCode: "75001", country: "FR" };

/** Sprint 79: mirrors the real-SQLite-restart pattern in databaseRestartPersistence.test.ts, scoped to the company profile and invoice subsystem. */
describe("Sprint 79 invoice and company-profile restart persistence", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempDir = undefined;
  });

  it("persists company profile, an edited invoice Draft (calculation mode, tax treatment, VAT, snapshots), invoice events, and an issued invoice number across two independent runtimes", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "noctella-invoice-restart-"));
    const dbFile = path.join(tempDir, "invoice-restart-test.sqlite");
    const env = { DATABASE_DRIVER: "sqlite", DATABASE_URL: dbFile } as unknown as NodeJS.ProcessEnv;

    const first = createDatabaseRuntime(env);
    const dbFirst = first.db as DbClient;

    await seedInitialCategoriesIfEmpty(dbFirst);
    const category = await createCategory(dbFirst, { name: "Restart Invoice Category", displayOrder: 0, isActive: true });

    const profile = await upsertCompanyProfile(dbFirst, { legalName: "Noctella Restart Trading Ltd.", registrationNumber: "RESTART-UIC-1", vatNumber: "RESTARTVAT1", addressLine1: "1 Restart Row", city: "Testville", postalCode: "00000", country: "FR", email: "billing@restart-test.invalid", phone: "+00 000", defaultVatRate: 0 });

    const product = await createProduct(dbFirst, { sku: "SKU-RESTART-INVOICE", title: "Restart Invoice Product", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: category.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 300, stockQuantity: 1 });

    await createPaymentSession(dbFirst, { provider: PaymentProvider.Stripe, providerReference: "restart-inv-ref-1", status: PaymentStatus.Paid, amount: 300, currency: "EUR", idempotencyKey: "restart-inv-payment-1" });
    const order = await createOrder(dbFirst, createOrderSchema.parse({ orderDraftId: "restart-inv-draft-1", guestEmail: "restart-invoice@example.com", status: OrderStatus.Pending, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "restart-inv-ref-1", currency: "EUR", billingAddress: address, shippingAddress: address, subtotalAmount: 300, totalAmount: 300, items: [{ productId: product.id, quantity: 1 }] }));

    // The automatic Sales Invoice Draft created inside createOrder() itself.
    const autoInvoices = await listInvoices(dbFirst, { orderId: order.id });
    expect(autoInvoices.items).toHaveLength(1);
    const draftId = autoInvoices.items[0].id;

    await updateInvoiceDraft(dbFirst, draftId, { calculationMode: ErpInvoiceCalculationMode.ManualOverride, taxTreatment: "IntraEUReverseCharge", pricesIncludeVat: true, shippingAmount: 12, shippingVatRate: 0, discountAmount: 5, notes: "Restart test note" });
    const [firstLine] = (await getInvoice(dbFirst, draftId)).lines;
    await updateInvoiceLine(dbFirst, draftId, firstLine.id, { vatRate: 19, manualVatAmount: 47.5 });

    const issued = await issueInvoice(dbFirst, draftId, {});
    expect(issued.invoiceNumber).toMatch(/^NOCT-\d{4}-000001$/);

    const eventsBeforeRestart = await dbFirst.select().from(schema.invoiceEvents).where(eq(schema.invoiceEvents.invoiceId, draftId));
    expect(eventsBeforeRestart.length).toBeGreaterThan(0);

    await first.shutdown();

    const second = createDatabaseRuntime(env);
    const dbSecond = second.db as DbClient;
    await seedInitialCategoriesIfEmpty(dbSecond);

    const [restartedProfile] = await dbSecond.select().from(schema.companyProfile).where(eq(schema.companyProfile.id, "default"));
    expect(restartedProfile).toBeDefined();
    expect(restartedProfile.legalName).toBe("Noctella Restart Trading Ltd.");
    expect(restartedProfile.updatedAt).toBe(profile!.updatedAt);

    const [restartedInvoice] = await dbSecond.select().from(schema.invoices).where(eq(schema.invoices.id, draftId));
    expect(restartedInvoice.status).toBe(ErpInvoiceStatus.Issued);
    expect(restartedInvoice.invoiceNumber).toBe(issued.invoiceNumber);
    expect(restartedInvoice.calculationMode).toBe(ErpInvoiceCalculationMode.ManualOverride);
    expect(restartedInvoice.taxTreatment).toBe("IntraEUReverseCharge");
    expect(restartedInvoice.pricesIncludeVat).toBe(true);
    expect(restartedInvoice.discountAmount).toBe(5);
    expect(restartedInvoice.notes).toBe("Restart test note");
    expect(JSON.parse(restartedInvoice.sellerSnapshot).legalName).toBe("Noctella Restart Trading Ltd.");

    const restartedLines = await dbSecond.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, draftId));
    expect(restartedLines).toHaveLength(1);
    expect(restartedLines[0].vatRate).toBe(19);
    expect(restartedLines[0].taxVatAmount).toBe(47.5);

    const restartedEvents = await dbSecond.select().from(schema.invoiceEvents).where(eq(schema.invoiceEvents.invoiceId, draftId));
    expect(restartedEvents).toHaveLength(eventsBeforeRestart.length);
    expect(restartedEvents.map((e: any) => e.id).sort()).toEqual(eventsBeforeRestart.map((e: any) => e.id).sort());

    await second.shutdown();
  });
});
