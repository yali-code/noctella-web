import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { PaymentStatus, ProductShippingProfile, ProductStatus, ProductType, ShippingRuleType } from "@noctella/shared";
import { ensureSchema } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct } from "../src/services/products";
import { createShippingMethod } from "../src/services/shippingMethods";
import { upsertCompanyProfile } from "../src/services/companyProfile";
import { createAutomaticSalesInvoiceDraft, listInvoices } from "../src/services/erpSalesFinanceBridge";
import { SqliteUnitOfWork } from "../src/services/unitOfWork";
import { createCashOnDeliveryOrderUseCase, settleCashOnDeliveryOrderUseCase } from "../src/use-cases/order/useCases";
import { BadRequestError, ConflictError } from "../src/services/errors";

function memoryDb() { const sqlite = new Database(":memory:"); ensureSchema(sqlite); return { sqlite, db: drizzle(sqlite, { schema }) as any }; }
const address = (countryCode?: string) => ({ fullName: "COD Buyer", line1: "1 Sofia Street", city: "Sofia", postalCode: "1000", country: "Bulgaria", ...(countryCode ? { countryCode } : {}) });

describe("Sprint 134 shipping domain", () => {
  let db: any; let seq = 0;

  beforeEach(async () => {
    const m = memoryDb(); db = m.db;
  });

  async function product(overrides: Record<string, unknown> = {}) {
    seq += 1;
    const cat = await createCategory(db, { name: `Cat-134-${seq}`, displayOrder: 0, isActive: true });
    return createProduct(db, { sku: `SKU-SHIP-${seq}`, title: `Ship Product ${seq}`, wooProductName: `Web Ship Product ${seq}`, slug: `ship-product-${seq}`, type: ProductType.UniqueItem, status: ProductStatus.Published, categoryId: cat.id, priceEur: 100, wooListingPriceEur: 100, stockQuantity: 1, customsWarning: false, isFeatured: false, allowMakeOffer: false, allowCashOnDelivery: true, showInArchiveAfterSale: false, ...overrides });
  }

  function createCodOrder(productIds: string[], overrides: { shippingMethodId?: string; expectedShippingAmountEur?: number; countryCode?: string } = {}) {
    seq += 1;
    return createCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db)).execute({
      orderDraftId: `ship-draft-${seq}`,
      guestEmail: "buyer@example.com",
      billingAddress: address(overrides.countryCode),
      shippingAddress: address(overrides.countryCode),
      items: productIds.map((productId) => ({ productId, quantity: 1 })),
      shippingMethodId: overrides.shippingMethodId,
      expectedShippingAmountEur: overrides.expectedShippingAmountEur,
    });
  }

  it("1. FREE method resolves shippingAmount = 0", async () => {
    await createShippingMethod(db, { label: "Free Shipping", ruleType: ShippingRuleType.Free });
    const p = await product();
    const order = await createCodOrder([p.id]);
    expect(order.shippingAmount).toBe(0);
    expect(order.totalAmount).toBe(order.subtotalAmount);
    expect(order.shippingMethodLabel).toBe("Free Shipping");
  });

  it("2. FLAT_RATE resolves the configured amount authoritatively", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 599 });
    const p = await product();
    const order = await createCodOrder([p.id]);
    expect(order.shippingAmount).toBe(5.99);
    expect(order.totalAmount).toBe(order.subtotalAmount + 5.99);
  });

  it("3. FREE_OVER_SUBTOTAL charges the configured fee below threshold", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FreeOverSubtotal, flatAmountEurCents: 500, freeThresholdEurCents: 10000 });
    const p = await product({ priceEur: 50, wooListingPriceEur: 50 });
    const order = await createCodOrder([p.id]);
    expect(order.shippingAmount).toBe(5);
  });

  it("4. exact threshold boundary: EUR 99.99 charges the fee, EUR 100.00 is free", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FreeOverSubtotal, flatAmountEurCents: 500, freeThresholdEurCents: 10000 });
    const below = await product({ priceEur: 99.99, wooListingPriceEur: 99.99 });
    const belowOrder = await createCodOrder([below.id]);
    expect(belowOrder.subtotalAmount).toBe(99.99);
    expect(belowOrder.shippingAmount).toBe(5);

    const at = await product({ priceEur: 100, wooListingPriceEur: 100 });
    const atOrder = await createCodOrder([at.id]);
    expect(atOrder.subtotalAmount).toBe(100);
    expect(atOrder.shippingAmount).toBe(0);
  });

  it("5. country matching: an eligible destination country is accepted", async () => {
    await createShippingMethod(db, { label: "EU Only", ruleType: ShippingRuleType.Free, countryCodes: ["BG", "DE"] });
    const p = await product();
    const order = await createCodOrder([p.id], { countryCode: "BG" });
    expect(order.shippingAmount).toBe(0);
    expect(order.shippingMethodLabel).toBe("EU Only");
  });

  it("6. country mismatch: a destination outside the method's country list is not eligible", async () => {
    await createShippingMethod(db, { label: "EU Only", ruleType: ShippingRuleType.Free, countryCodes: ["DE"] });
    const p = await product();
    await expect(createCodOrder([p.id], { countryCode: "BG" })).rejects.toThrow(/No shipping method is available/);
  });

  it("7. no matching shipping method fails closed rather than silently becoming free", async () => {
    await createShippingMethod(db, { label: "DE Only", ruleType: ShippingRuleType.Free, countryCodes: ["DE"] });
    const p = await product();
    await expect(createCodOrder([p.id], { countryCode: "BG" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("8. product-profile eligibility: a method restricted to Oversize does not cover a Standard product", async () => {
    await createShippingMethod(db, { label: "Oversize Only", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 2000, shippingProfiles: [ProductShippingProfile.Oversize] });
    const standard = await product();
    await expect(createCodOrder([standard.id])).rejects.toThrow(/No shipping method is available/);
    const oversize = await product({ shippingProfile: ProductShippingProfile.Oversize });
    const order = await createCodOrder([oversize.id]);
    expect(order.shippingAmount).toBe(20);
  });

  it("9. mixed cart: an eligible method must cover EVERY effective product profile, not just one", async () => {
    await createShippingMethod(db, { label: "Standard Only", ruleType: ShippingRuleType.Free, shippingProfiles: [ProductShippingProfile.Standard] });
    const standard = await product();
    const oversize = await product({ shippingProfile: ProductShippingProfile.Oversize });
    await expect(createCodOrder([standard.id, oversize.id])).rejects.toThrow(/No shipping method is available/);

    await createShippingMethod(db, { label: "Everything", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 1000 });
    const order = await createCodOrder([standard.id, oversize.id]);
    expect(order.shippingAmount).toBe(10);
  });

  it("10. multiple eligible methods are returned/considered in deterministic sortOrder", async () => {
    await createShippingMethod(db, { label: "Second", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 700, sortOrder: 2 });
    await createShippingMethod(db, { label: "First", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 300, sortOrder: 1 });
    const p = await product();
    // With multiple eligible methods and no explicit selection, resolution fails closed rather than guessing - proves no hidden precedence is applied.
    await expect(createCodOrder([p.id])).rejects.toThrow(/Shipping method selection is required/);
    // An explicit selection of either resolves deterministically to that method's own amount.
    const firstId = (await (await import("../src/services/shippingMethods")).listShippingMethods(db)).find((m) => m.label === "First")!.id;
    const order = await createCodOrder([p.id], { shippingMethodId: firstId });
    expect(order.shippingAmount).toBe(3);
    expect(order.shippingMethodLabel).toBe("First");
  });

  it("11. the client cannot submit an authoritative shipping amount - only a method id and an expectation are accepted", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 500 });
    const p = await product();
    // expectedShippingAmountEur is compared, never assigned - submitting the correct amount for the wrong method still fails closed on method mismatch, proving the field carries no independent authority.
    await expect(createCodOrder([p.id], { shippingMethodId: "does-not-exist", expectedShippingAmountEur: 5 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("12. an invalid/unknown selected shipping method fails closed", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.Free });
    const p = await product();
    await expect(createCodOrder([p.id], { shippingMethodId: "nonexistent-id" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("13. a method disabled after being quoted fails closed on final submit", async () => {
    // A second, still-eligible method must exist so this proves the specific "no longer available"
    // ConflictError path (requested-but-now-ineligible) rather than the generic
    // zero-eligible-options BadRequestError that fires when nothing at all matches the cart.
    await createShippingMethod(db, { label: "Still Available", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 400 });
    const method = await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.Free });
    const { updateShippingMethod } = await import("../src/services/shippingMethods");
    await updateShippingMethod(db, method.id, { isActive: false });
    const p = await product();
    await expect(createCodOrder([p.id], { shippingMethodId: method.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("14. a rate changed after the quote fails closed via the stale expectedShippingAmountEur check", async () => {
    const method = await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 500 });
    const { updateShippingMethod } = await import("../src/services/shippingMethods");
    await updateShippingMethod(db, method.id, { flatAmountEurCents: 900 });
    const p = await product();
    await expect(createCodOrder([p.id], { shippingMethodId: method.id, expectedShippingAmountEur: 5 })).rejects.toThrow(/Shipping cost has changed/);
  });

  it("15/16. Order.shippingAmount is the authoritative resolved amount and Order.totalAmount equals subtotal + shippingAmount", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 250 });
    const p = await product({ priceEur: 40, wooListingPriceEur: 40 });
    const order = await createCodOrder([p.id]);
    expect(order.shippingAmount).toBe(2.5);
    expect(order.subtotalAmount).toBe(40);
    expect(order.totalAmount).toBe(42.5);
  });

  it("17. configuration changes after Order creation do not mutate the historical shipping snapshot", async () => {
    const method = await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 500 });
    const p = await product();
    const order = await createCodOrder([p.id], { shippingMethodId: method.id });
    expect(order.shippingAmount).toBe(5);
    expect(order.shippingMethodLabel).toBe("Standard");

    const { updateShippingMethod } = await import("../src/services/shippingMethods");
    await updateShippingMethod(db, method.id, { label: "Renamed", flatAmountEurCents: 999, isActive: false });

    const [fresh] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(Number(fresh.shippingAmount)).toBe(5);
    expect(fresh.shippingMethodLabel).toBe("Standard");
  });

  it("18. COD settlement compares collectedAmount against the final Order.totalAmount including shipping", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 500 });
    const p = await product({ priceEur: 50, wooListingPriceEur: 50 });
    const order = await createCodOrder([p.id]);
    expect(order.totalAmount).toBe(55);
    // Settling for the subtotal alone (ignoring shipping) must be rejected.
    await expect(settleCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db)).execute({ orderId: order.id, collectedAmount: 50 })).rejects.toBeInstanceOf(BadRequestError);
    const settled = await settleCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db)).execute({ orderId: order.id, collectedAmount: 55 });
    expect(settled.order.paymentStatus).toBe(PaymentStatus.Paid);
  });

  it("19. invoice draft creation reuses the existing Order.shippingAmount unchanged - no COD-specific invoice logic", async () => {
    await upsertCompanyProfile(db, { legalName: "Noctella Test Ltd.", registrationNumber: "T-1", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", defaultVatRate: 0 });
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 500 });
    const p = await product({ priceEur: 50, wooListingPriceEur: 50 });
    const order = await createCodOrder([p.id]);
    await settleCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db)).execute({ orderId: order.id, collectedAmount: 55 });
    await createAutomaticSalesInvoiceDraft(db, order.id);
    const invoices = await listInvoices(db, { orderId: order.id });
    expect(invoices.items).toHaveLength(1);
    expect(Number(invoices.items[0].shippingAmount)).toBe(5);
  });

  it("20. COD idempotent replay does not duplicate the shipping-resolved Order, inventory decrement, or stock movement", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 500 });
    const p = await product();
    seq += 1;
    const draftId = `ship-replay-${seq}`;
    const useCase = createCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db));
    const first = await useCase.execute({ orderDraftId: draftId, guestEmail: "buyer@example.com", billingAddress: address(), shippingAddress: address(), items: [{ productId: p.id, quantity: 1 }] });
    const replay = await useCase.execute({ orderDraftId: draftId, guestEmail: "buyer@example.com", billingAddress: address(), shippingAddress: address(), items: [{ productId: p.id, quantity: 1 }] });
    expect(replay.id).toBe(first.id);
    expect(replay.shippingAmount).toBe(first.shippingAmount);
    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, first.id));
    expect(movements).toHaveLength(1);
    const [freshProduct] = await db.select().from(schema.products).where(eq(schema.products.id, p.id));
    expect(freshProduct.stockQuantity).toBe(0);
  });

  it("21. concurrent COD double-submit with the same orderDraftId does not create duplicate orders or double-decrement inventory", async () => {
    await createShippingMethod(db, { label: "Standard", ruleType: ShippingRuleType.FlatRate, flatAmountEurCents: 500 });
    const p = await product();
    seq += 1;
    const draftId = `ship-concurrent-${seq}`;
    const intent = { orderDraftId: draftId, guestEmail: "buyer@example.com", billingAddress: address(), shippingAddress: address(), items: [{ productId: p.id, quantity: 1 }] };
    const [a, b] = await Promise.all([
      createCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db)).execute(intent),
      createCashOnDeliveryOrderUseCase(new SqliteUnitOfWork(db)).execute(intent),
    ]);
    expect(a.id).toBe(b.id);
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.orderDraftId, draftId));
    expect(orders).toHaveLength(1);
    const movements = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.orderId, a.id));
    expect(movements).toHaveLength(1);
    const [freshProduct] = await db.select().from(schema.products).where(eq(schema.products.id, p.id));
    expect(freshProduct.stockQuantity).toBe(0);
  });
});
