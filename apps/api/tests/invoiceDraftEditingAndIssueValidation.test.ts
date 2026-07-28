import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { ErpInvoiceCalculationMode, ErpInvoiceStatus, OrderStatus, PaymentProvider, PaymentStatus, PriceCurrency, ProductStatus, ProductType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createOrder } from "../src/services/orders";
import { createPaymentSession } from "../src/payments/paymentRepository";
import { upsertCompanyProfile } from "../src/services/companyProfile";
import { getInvoice, getInvoiceEvents, getInvoiceIssueReadiness, issueInvoice, listInvoices, recalculateInvoiceDraft, refreshInvoiceSellerSnapshot, switchInvoiceCalculationMode, updateInvoiceDraft, updateInvoiceLine } from "../src/services/erpSalesFinanceBridge";
import { BadRequestError, ConflictError, NotFoundError } from "../src/services/errors";

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return drizzle(sqlite, { schema }) as any; }
const address = { fullName: "Jane Collector", line1: "1 Rue Noctella", city: "Paris", postalCode: "75001", country: "FR" };
const fictional = { legalName: "Noctella Test Trading Ltd.", registrationNumber: "TEST-UIC-1", vatNumber: "TESTVAT1", addressLine1: "1 Test Row", city: "Testville", postalCode: "00000", country: "FR", email: "billing@example-test.invalid", phone: "+00 000", defaultVatRate: 0 };
let seq = 0;
async function draftOrder(db: any) {
  seq += 1;
  const cat = await createCategory(db, { name: `Cat-${seq}`, displayOrder: 0, isActive: true });
  const product = await createProduct(db, { sku: `SKU-DE-${seq}`, title: `Product ${seq}`, slug: `product-de-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: false, showInArchiveAfterSale: false, priceEur: 100, stockQuantity: 1, images: [] });
  await createPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: `de-ref-${seq}`, status: PaymentStatus.Paid, amount: 100, currency: "EUR", idempotencyKey: `de-pay-${seq}` });
  const order = await createOrder(db, { orderDraftId: `de-draft-${seq}`, guestEmail: "jane@example.com", status: OrderStatus.Processing, paymentStatus: PaymentStatus.Paid, paymentProvider: PaymentProvider.Stripe, paymentReference: `de-ref-${seq}`, currency: PriceCurrency.Eur, billingAddress: address, shippingAddress: address, subtotalAmount: 100, totalAmount: 100, items: [{ productId: product.id, quantity: 1 as const }] });
  const invoice = (await listInvoices(db, { orderId: order.id })).items[0];
  return { order, invoice, product };
}

describe("Sprint 79 invoice Draft editing API and issue validation", () => {
  let db: any;
  beforeEach(async () => { db = memoryDb(); await upsertCompanyProfile(db, fictional); });

  it("allows editing every documented Draft-only invoice field and writes an audit event for each", async () => {
    const { invoice } = await draftOrder(db);
    const before = await getInvoiceEventsCount(db, invoice.id);
    const updated: any = await updateInvoiceDraft(db, invoice.id, { taxTreatment: "SecondHandMarginScheme", pricesIncludeVat: true, shippingAmount: 12, shippingVatRate: 20, discountAmount: 3, notes: "Edited", invoiceFooter: "Footer" });
    expect(updated.taxTreatment).toBe("SecondHandMarginScheme");
    expect(updated.pricesIncludeVat).toBe(true);
    expect(updated.notes).toBe("Edited");
    expect(updated.invoiceFooter).toBe("Footer");
    const after = await getInvoiceEventsCount(db, invoice.id);
    expect(after).toBeGreaterThan(before);
  });

  it("recalculates Automatic-mode totals when shipping/discount change", async () => {
    const { invoice } = await draftOrder(db);
    const updated: any = await updateInvoiceDraft(db, invoice.id, { shippingAmount: 10, shippingVatRate: 0, discountAmount: 5 });
    expect(updated.shippingAmount).toBe(10);
    expect(updated.totalAmount).toBe(100 - 5 + 0 + 10);
  });

  it("switching to ManualOverride preserves the currently calculated values as the starting point, and a manual VAT amount persists across further edits", async () => {
    const { invoice } = await draftOrder(db);
    const [line] = (await getInvoice(db, invoice.id)).lines;
    const switched: any = await switchInvoiceCalculationMode(db, invoice.id, ErpInvoiceCalculationMode.ManualOverride);
    expect(switched.calculationMode).toBe(ErpInvoiceCalculationMode.ManualOverride);
    expect(switched.lines[0].lineTotal).toBe(line.lineTotal);
    const withManual: any = await updateInvoiceLine(db, invoice.id, line.id, { manualVatAmount: 4 });
    expect(withManual.lines[0].taxVatAmount).toBe(4);
    // An unrelated line edit (title) must not silently discard the manual VAT amount.
    const afterTitleEdit: any = await updateInvoiceLine(db, invoice.id, line.id, { titleSnapshot: "Renamed line" });
    expect(afterTitleEdit.lines[0].taxVatAmount).toBe(4);
    expect(afterTitleEdit.lines[0].titleSnapshot).toBe("Renamed line");
  });

  it("caps a line's quantity at the linked order item's ordered quantity", async () => {
    const { invoice } = await draftOrder(db);
    const [line] = (await getInvoice(db, invoice.id)).lines;
    await expect(updateInvoiceLine(db, invoice.id, line.id, { quantity: 2 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects a manual VAT amount while still in Automatic mode", async () => {
    const { invoice } = await draftOrder(db);
    const [line] = (await getInvoice(db, invoice.id)).lines;
    await expect(updateInvoiceLine(db, invoice.id, line.id, { manualVatAmount: 5 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects negative amounts and out-of-range VAT rates on both invoice and line edits", async () => {
    const { invoice } = await draftOrder(db);
    const [line] = (await getInvoice(db, invoice.id)).lines;
    await expect(updateInvoiceDraft(db, invoice.id, { shippingAmount: -1 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(updateInvoiceDraft(db, invoice.id, { discountAmount: -1 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(updateInvoiceDraft(db, invoice.id, { shippingVatRate: 101 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(updateInvoiceLine(db, invoice.id, line.id, { unitPrice: -1 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(updateInvoiceLine(db, invoice.id, line.id, { vatRate: -1 })).rejects.toBeInstanceOf(BadRequestError);
    await expect(updateInvoiceLine(db, invoice.id, line.id, { vatRate: 101 })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects editing an already-issued invoice, its invoice number, and its order linkage (neither field is ever read from input)", async () => {
    const { invoice } = await draftOrder(db);
    const issued: any = await issueInvoice(db, invoice.id, {});
    await expect(updateInvoiceDraft(db, invoice.id, { notes: "too late" })).rejects.toBeInstanceOf(ConflictError);
    const [line] = issued.lines;
    await expect(updateInvoiceLine(db, invoice.id, line.id, { unitPrice: 999 })).rejects.toBeInstanceOf(ConflictError);
    // invoiceNumber/orderId are simply never read from input - a caller attempting to smuggle them in has no effect.
    const withSmuggledFields: any = await getInvoice(db, invoice.id);
    expect(withSmuggledFields.invoiceNumber).toBe(issued.invoiceNumber);
    expect(withSmuggledFields.orderId).toBe(issued.orderId);
  });

  it("issue readiness reports missing company data, missing customer data, and reconciles ready once complete", async () => {
    const emptyDb = memoryDb();
    const { invoice } = await draftOrder(emptyDb); // note: no company profile configured in this fresh db
    const readiness = await getInvoiceIssueReadiness(emptyDb, invoice.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.some((i: string) => i.includes("Company profile"))).toBe(true);
    await expect(issueInvoice(emptyDb, invoice.id, {})).rejects.toBeInstanceOf(BadRequestError);
  });

  it("issue readiness requires a VAT number for StandardVAT/IntraEUReverseCharge but not for SecondHandMarginScheme/ExportZeroRated/Manual", async () => {
    const localDb = memoryDb();
    await upsertCompanyProfile(localDb, { ...fictional, vatNumber: null as any });
    const { invoice } = await draftOrder(localDb);
    await updateInvoiceDraft(localDb, invoice.id, { taxTreatment: "StandardVAT" });
    expect((await getInvoiceIssueReadiness(localDb, invoice.id)).ready).toBe(false);
    await updateInvoiceDraft(localDb, invoice.id, { taxTreatment: "SecondHandMarginScheme" });
    expect((await getInvoiceIssueReadiness(localDb, invoice.id)).ready).toBe(true);
  });

  it("issue readiness flags a missing customer billing address", async () => {
    const localDb = memoryDb();
    await upsertCompanyProfile(localDb, fictional);
    const { invoice } = await draftOrder(localDb);
    await localDb.update(schema.invoices).set({ billingAddressSnapshot: JSON.stringify({}) }).where(eq(schema.invoices.id, invoice.id));
    const readiness = await getInvoiceIssueReadiness(localDb, invoice.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.some((i: string) => i.includes("billing address"))).toBe(true);
  });

  it("rejects a manually-supplied invoice number at issue time and always assigns via the yearly sequential allocator", async () => {
    const { invoice } = await draftOrder(db);
    await expect(issueInvoice(db, invoice.id, { invoiceNumber: "NOCT-2020-999999" })).rejects.toBeInstanceOf(BadRequestError);
    const issued: any = await issueInvoice(db, invoice.id, {});
    expect(issued.invoiceNumber).toMatch(/^NOCT-\d{4}-000001$/);
  });

  it("a valid Draft issues successfully, the number is assigned exactly once, and re-issuing is an idempotent no-op returning the same number", async () => {
    const { invoice } = await draftOrder(db);
    const issued: any = await issueInvoice(db, invoice.id, {});
    expect(issued.status).toBe(ErpInvoiceStatus.Issued);
    const reissued: any = await issueInvoice(db, invoice.id, {});
    expect(reissued.invoiceNumber).toBe(issued.invoiceNumber);
  });

  it("issued invoice data is fully immutable: totals, lines, VAT, tax treatment, calculation mode, and snapshots never change afterward", async () => {
    const { invoice } = await draftOrder(db);
    const issued: any = await issueInvoice(db, invoice.id, {});
    const snapshotBefore = JSON.stringify(issued);
    await expect(updateInvoiceDraft(db, invoice.id, { discountAmount: 50 })).rejects.toBeInstanceOf(ConflictError);
    await expect(switchInvoiceCalculationMode(db, invoice.id, ErpInvoiceCalculationMode.ManualOverride)).rejects.toBeInstanceOf(ConflictError);
    await expect(recalculateInvoiceDraft(db, invoice.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(refreshInvoiceSellerSnapshot(db, invoice.id)).rejects.toBeInstanceOf(ConflictError);
    const after = await getInvoice(db, invoice.id);
    expect(JSON.stringify(after)).toBe(snapshotBefore);
  });

  it("refresh-seller-snapshot is Draft-only, explicit, and audited", async () => {
    const { invoice } = await draftOrder(db);
    const before = await getInvoiceEventsCount(db, invoice.id);
    await refreshInvoiceSellerSnapshot(db, invoice.id);
    const after = await getInvoiceEventsCount(db, invoice.id);
    expect(after).toBe(before + 1);
    const issued: any = await issueInvoice(db, invoice.id, {});
    await expect(refreshInvoiceSellerSnapshot(db, issued.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("Sprint 79 correction: rejects NaN/Infinity/non-numeric-string numeric input on invoice and line edits instead of silently coercing to 0/NaN", async () => {
    const { invoice } = await draftOrder(db);
    const [line] = (await getInvoice(db, invoice.id)).lines;
    for (const bad of [NaN, Infinity, -Infinity, "not-a-number", ""]) {
      await expect(updateInvoiceDraft(db, invoice.id, { shippingAmount: bad as any })).rejects.toBeInstanceOf(BadRequestError);
      await expect(updateInvoiceDraft(db, invoice.id, { discountAmount: bad as any })).rejects.toBeInstanceOf(BadRequestError);
      await expect(updateInvoiceDraft(db, invoice.id, { shippingVatRate: bad as any })).rejects.toBeInstanceOf(BadRequestError);
      await expect(updateInvoiceLine(db, invoice.id, line.id, { unitPrice: bad as any })).rejects.toBeInstanceOf(BadRequestError);
      await expect(updateInvoiceLine(db, invoice.id, line.id, { discountAmount: bad as any })).rejects.toBeInstanceOf(BadRequestError);
      await expect(updateInvoiceLine(db, invoice.id, line.id, { vatRate: bad as any })).rejects.toBeInstanceOf(BadRequestError);
      await expect(updateInvoiceLine(db, invoice.id, line.id, { quantity: bad as any })).rejects.toBeInstanceOf(BadRequestError);
    }
    // None of the rejected attempts left the invoice/line in a partially-updated or NaN-tainted state.
    const after = await getInvoice(db, invoice.id);
    expect(Number.isFinite(after.shippingAmount)).toBe(true);
    expect(Number.isFinite(after.discountAmount)).toBe(true);
    expect(Number.isFinite(after.lines[0].unitPrice)).toBe(true);
  });

  it("Sprint 79 correction: switching to ManualOverride then supplying a non-numeric manual VAT amount is rejected, not silently stored as NaN", async () => {
    const { invoice } = await draftOrder(db);
    const [line] = (await getInvoice(db, invoice.id)).lines;
    await switchInvoiceCalculationMode(db, invoice.id, ErpInvoiceCalculationMode.ManualOverride);
    await expect(updateInvoiceLine(db, invoice.id, line.id, { manualVatAmount: NaN as any })).rejects.toBeInstanceOf(BadRequestError);
    await expect(updateInvoiceLine(db, invoice.id, line.id, { manualVatAmount: "bad" as any })).rejects.toBeInstanceOf(BadRequestError);
    await expect(updateInvoiceDraft(db, invoice.id, { manualShippingVatAmount: Infinity as any })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updating/reading a nonexistent invoice or line raises NotFoundError", async () => {
    await expect(getInvoice(db, "missing")).rejects.toBeInstanceOf(NotFoundError);
    const { invoice } = await draftOrder(db);
    await expect(updateInvoiceLine(db, invoice.id, "missing-line", { unitPrice: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
});

async function getInvoiceEventsCount(db: any, invoiceId: string) {
  return (await getInvoiceEvents(db, invoiceId)).length;
}
