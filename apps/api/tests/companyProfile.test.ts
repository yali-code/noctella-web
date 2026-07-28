import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { getCompanyProfile, upsertCompanyProfile } from "../src/services/companyProfile";
import { createInvoiceDraft, getInvoice, listInvoices } from "../src/services/erpSalesFinanceBridge";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { BadRequestError, ConflictError } from "../src/services/errors";
import { OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType } from "@noctella/shared";

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }) as any; }
const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };
const fictional = { legalName: "Noctella Test Trading Ltd.", registrationNumber: "TEST-UIC-1", vatNumber: "TESTVAT1", addressLine1: "1 Test Row", city: "Testville", postalCode: "00000", country: "FR", email: "billing@example-test.invalid", phone: "+00 000" };

describe("Sprint 79 company profile", () => {
  let db: any;
  beforeEach(() => { db = memoryDb(); });

  it("returns null before configuration, then creates and reads back the profile", async () => {
    expect(await getCompanyProfile(db)).toBeNull();
    const created = await upsertCompanyProfile(db, fictional);
    expect(created!.legalName).toBe(fictional.legalName);
    expect(created!.defaultVatRate).toBe(20);
    expect(created!.defaultTaxTreatment).toBe("StandardVAT");
    const fetched = await getCompanyProfile(db);
    expect(fetched!.legalName).toBe(fictional.legalName);
  });

  it("enforces mandatory fields on create and update", async () => {
    await expect(upsertCompanyProfile(db, { ...fictional, legalName: "" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, email: "  " })).rejects.toBeInstanceOf(BadRequestError);
    const created = await upsertCompanyProfile(db, fictional);
    await expect(upsertCompanyProfile(db, { registrationNumber: "" })).rejects.toBeInstanceOf(BadRequestError);
    void created;
  });

  it("rejects an out-of-range default VAT rate and an invalid default tax treatment", async () => {
    await expect(upsertCompanyProfile(db, { ...fictional, defaultVatRate: 150 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultVatRate: -1 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultTaxTreatment: "NotARealTreatment" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("Sprint 79 correction: rejects NaN/Infinity/non-numeric-string default VAT rate and payment terms instead of silently storing garbage", async () => {
    await expect(upsertCompanyProfile(db, { ...fictional, defaultVatRate: NaN })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultVatRate: Infinity })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultVatRate: "not-a-number" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultVatRate: "" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultPaymentTermsDays: NaN })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultPaymentTermsDays: "thirty" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(upsertCompanyProfile(db, { ...fictional, defaultPaymentTermsDays: 14.5 })).rejects.toBeInstanceOf(BadRequestError);
    // A valid numeric string is still accepted (HTTP/form inputs commonly carry numbers as strings).
    const created = await upsertCompanyProfile(db, { ...fictional, defaultVatRate: "19" as any });
    expect(created!.defaultVatRate).toBe(19 as any);
  });

  it("updates in place (single active profile row) and enforces optimistic concurrency", async () => {
    const created = await upsertCompanyProfile(db, fictional);
    const updated = await upsertCompanyProfile(db, { legalName: "Noctella Renamed Ltd.", expectedUpdatedAt: created!.updatedAt });
    expect(updated!.legalName).toBe("Noctella Renamed Ltd.");
    expect(updated!.id).toBe(created!.id);
    expect((await db.select().from(schema.companyProfile)).length).toBe(1);
    await expect(upsertCompanyProfile(db, { legalName: "Stale Write", expectedUpdatedAt: "not-the-real-timestamp" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("invoice seller snapshots are isolated from later company-profile edits (point-in-time copy, not a live reference)", async () => {
    await upsertCompanyProfile(db, fictional);
    const cat = await createCategory(db, { name: "Cat", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-CP-1", title: "Product", slug: "product-cp-1", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 100, stockQuantity: 1, images: [] });
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "cp-ref", status: PaymentStatus.Paid, amount: 100, currency: "EUR", idempotencyKey: "cp-payment" });
    const order = await createOrder(db, { orderDraftId: "cp-draft", guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "cp-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 100, totalAmount: 100, items: [{ productId: product.id, quantity: 1 as const }] });
    const draft: any = await createInvoiceDraft(db, order.id, {});
    const sellerAtCreation = JSON.parse(draft.sellerSnapshot);
    expect(sellerAtCreation.legalName).toBe(fictional.legalName);

    await upsertCompanyProfile(db, { legalName: "Noctella Renamed After Draft Ltd." });
    const [reread] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, draft.id));
    expect(JSON.parse(reread.sellerSnapshot).legalName).toBe(fictional.legalName);
  });

  it("Sprint 79 correction: bank/IBAN/BIC values are returned only through the authorized company-profile detail/edit path and the single-invoice detail view, never from the bulk invoice list", async () => {
    const withBank = { ...fictional, bankName: "Noctella Test Bank", iban: "FR7630006000011234567890189", bic: "AGRIFRPP" };
    const saved = await upsertCompanyProfile(db, withBank);
    // Authorized path: GET company profile (ERP/Admin only) legitimately returns the bank fields.
    expect(saved!.bankName).toBe(withBank.bankName);
    expect(saved!.iban).toBe(withBank.iban);
    expect(saved!.bic).toBe(withBank.bic);

    const cat = await createCategory(db, { name: "Cat-Priv", displayOrder: 0, isActive: true });
    const product = await createProduct(db, { sku: "SKU-CP-PRIV", title: "Product", slug: "product-cp-priv", type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 100, stockQuantity: 1, images: [] });
    await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "cp-priv-ref", status: PaymentStatus.Paid, amount: 100, currency: "EUR", idempotencyKey: "cp-priv-payment" });
    const order = await createOrder(db, { orderDraftId: "cp-priv-draft", guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: "cp-priv-ref", currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 100, totalAmount: 100, items: [{ productId: product.id, quantity: 1 as const }] });
    const draft: any = await createInvoiceDraft(db, order.id, {});

    // Authorized path: the single-invoice detail view legitimately embeds the bank fields
    // (needed on the printed/issued document for wire transfer instructions).
    const detail: any = await getInvoice(db, draft.id);
    expect(JSON.parse(detail.sellerSnapshot).iban).toBe(withBank.iban);

    // The bulk invoice list must never carry the seller snapshot (or any bank field within it).
    const list = await listInvoices(db, { orderId: order.id });
    expect(list.items).toHaveLength(1);
    const listedInvoice = list.items[0] as any;
    expect(listedInvoice.sellerSnapshot).toBeUndefined();
    expect(JSON.stringify(listedInvoice)).not.toContain(withBank.iban);
    expect(JSON.stringify(listedInvoice)).not.toContain(withBank.bic);
    expect(JSON.stringify(listedInvoice)).not.toContain(withBank.bankName);

    // Storefront-facing order/product data never touches the company profile at all.
    expect(JSON.stringify(order)).not.toContain(withBank.iban);
    expect(JSON.stringify(product)).not.toContain(withBank.iban);
  });
});
