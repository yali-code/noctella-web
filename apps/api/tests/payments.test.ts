import { PaymentProvider, PaymentStatus, ProductStatus, ProductType } from "@noctella/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BadRequestError, NotFoundError } from "../src/services/errors";
import {
  cancelMockPayment,
  initializeMockPayment,
  selectPaymentProvider,
  verifyMockPayment,
} from "../src/payments/paymentService";
import {
  cancelPaymentSession,
  initializePaymentSession,
  verifyPaymentSession,
} from "../src/payments/paymentRepository";
import { createTestDb } from "./testDb";
import { orders, payments } from "../src/db/schema";
import { createCategory } from "../src/services/categories";
import { createProduct, getProductById } from "../src/services/products";

describe("payment provider selection", () => {
  it("selects the Stripe mock provider", () => {
    expect(() => selectPaymentProvider(PaymentProvider.Stripe)).not.toThrow();
  });

  it("selects the PayPal mock provider", () => {
    expect(() => selectPaymentProvider(PaymentProvider.PayPal)).not.toThrow();
  });

  it("selects the Cash on Delivery mock provider", () => {
    expect(() => selectPaymentProvider(PaymentProvider.CashOnDelivery)).not.toThrow();
  });

  it("throws BadRequestError for an invalid provider", () => {
    expect(() => selectPaymentProvider("bitcoin")).toThrow(BadRequestError);
  });
});

describe("payment service — mock initialize/verify/cancel", () => {
  const providers = [PaymentProvider.Stripe, PaymentProvider.PayPal, PaymentProvider.CashOnDelivery];

  for (const provider of providers) {
    it(`initializes a mock payment for ${provider}`, async () => {
      const result = await initializeMockPayment(provider, {
        orderDraftId: "draft-1",
        amount: 500,
        currency: "EUR",
      });
      expect(result.status).toBe(PaymentStatus.Pending);
      expect(result.providerReference).toContain("draft-1");
    });

    it(`verifies a mock payment for ${provider}`, async () => {
      const result = await verifyMockPayment(provider, { providerReference: "ref-123" });
      expect(result.status).toBe(PaymentStatus.Paid);
      expect(result.providerReference).toBe("ref-123");
    });

    it(`cancels a mock payment for ${provider}`, async () => {
      const result = await cancelMockPayment(provider, { providerReference: "ref-123" });
      expect(result.status).toBe(PaymentStatus.Cancelled);
      expect(result.providerReference).toBe("ref-123");
    });
  }

  it("rejects initialize for an invalid provider", async () => {
    await expect(
      initializeMockPayment("bitcoin", { orderDraftId: "draft-1", amount: 500, currency: "EUR" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects verify for an invalid provider", async () => {
    await expect(verifyMockPayment("bitcoin", { providerReference: "ref-123" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("rejects cancel for an invalid provider", async () => {
    await expect(cancelMockPayment("bitcoin", { providerReference: "ref-123" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

describe("payment session persistence", () => {
  async function seededProduct(db: ReturnType<typeof createTestDb>) {
    const category = await createCategory(db, { name: `Cat-${Math.random()}`, displayOrder: 0, isActive: true });
    return createProduct(db, {
      sku: `SKU-PAY-${Math.random()}`,
      title: "Payment Test Product",
      type: ProductType.UniqueItem,
      status: ProductStatus.Published,
      categoryId: category.id,
      customsWarning: false,
      isFeatured: false,
      allowMakeOffer: false,
      allowCashOnDelivery: false,
      showInArchiveAfterSale: false,
      priceEur: 500,
      stockQuantity: 1,
    });
  }

  it("initialize persists a Pending payment session with correct amount, currency, provider and providerReference", async () => {
    const db = createTestDb();
    const result = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-a",
      amount: 250,
      currency: "EUR",
    });
    expect(result.status).toBe(PaymentStatus.Pending);
    expect(result.provider).toBe(PaymentProvider.Stripe);
    expect(result.providerReference).toContain("draft-a");

    const [row] = await db.select().from(payments).where(eq(payments.providerReference, result.providerReference));
    expect(row.amount).toBe(250);
    expect(row.currency).toBe("EUR");
    expect(row.provider).toBe(PaymentProvider.Stripe);
  });

  it("orderId remains NULL after initialize", async () => {
    const db = createTestDb();
    const result = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-b",
      amount: 100,
      currency: "EUR",
    });
    const [row] = await db.select().from(payments).where(eq(payments.providerReference, result.providerReference));
    expect(row.orderId).toBeNull();
  });

  it("repeated initialize with the same provider + orderDraftId returns the same session and creates only one row", async () => {
    const db = createTestDb();
    const first = await initializePaymentSession(db, {
      provider: PaymentProvider.PayPal,
      orderDraftId: "draft-c",
      amount: 300,
      currency: "EUR",
    });
    const second = await initializePaymentSession(db, {
      provider: PaymentProvider.PayPal,
      orderDraftId: "draft-c",
      amount: 300,
      currency: "EUR",
    });
    expect(second.providerReference).toBe(first.providerReference);
    expect(second.status).toBe(first.status);

    const rows = await db.select().from(payments).where(eq(payments.providerReference, first.providerReference));
    expect(rows).toHaveLength(1);
  });

  it("a different provider for the same orderDraftId creates a different session", async () => {
    const db = createTestDb();
    const stripe = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-d",
      amount: 400,
      currency: "EUR",
    });
    const paypal = await initializePaymentSession(db, {
      provider: PaymentProvider.PayPal,
      orderDraftId: "draft-d",
      amount: 400,
      currency: "EUR",
    });
    expect(paypal.providerReference).not.toBe(stripe.providerReference);
  });

  it("verify updates Pending to Paid", async () => {
    const db = createTestDb();
    const session = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-e",
      amount: 100,
      currency: "EUR",
    });
    const verified = await verifyPaymentSession(db, {
      provider: PaymentProvider.Stripe,
      providerReference: session.providerReference,
    });
    expect(verified.status).toBe(PaymentStatus.Paid);
  });

  it("cancel updates Pending to Cancelled", async () => {
    const db = createTestDb();
    const session = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-f",
      amount: 100,
      currency: "EUR",
    });
    const cancelled = await cancelPaymentSession(db, {
      provider: PaymentProvider.Stripe,
      providerReference: session.providerReference,
    });
    expect(cancelled.status).toBe(PaymentStatus.Cancelled);
  });

  it("verify for an unknown providerReference throws NotFoundError", async () => {
    const db = createTestDb();
    await expect(
      verifyPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cancel for an unknown providerReference throws NotFoundError", async () => {
    const db = createTestDb();
    await expect(
      cancelPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("verify on a Cancelled session is rejected with BadRequestError and leaves status unchanged", async () => {
    const db = createTestDb();
    const session = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-g",
      amount: 100,
      currency: "EUR",
    });
    await cancelPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: session.providerReference });

    await expect(
      verifyPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: session.providerReference }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const [row] = await db.select().from(payments).where(eq(payments.providerReference, session.providerReference));
    expect(row.status).toBe(PaymentStatus.Cancelled);
  });

  it("cancel on a Paid session is rejected with BadRequestError and leaves status unchanged", async () => {
    const db = createTestDb();
    const session = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-h",
      amount: 100,
      currency: "EUR",
    });
    await verifyPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: session.providerReference });

    await expect(
      cancelPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: session.providerReference }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const [row] = await db.select().from(payments).where(eq(payments.providerReference, session.providerReference));
    expect(row.status).toBe(PaymentStatus.Paid);
  });

  it("payment session persistence never creates or updates an Order row", async () => {
    const db = createTestDb();
    const before = await db.select().from(orders);
    const session = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-i",
      amount: 100,
      currency: "EUR",
    });
    await verifyPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: session.providerReference });
    const after = await db.select().from(orders);
    expect(after).toHaveLength(before.length);
  });

  it("payment session persistence never changes Product stock, price or status", async () => {
    const db = createTestDb();
    const product = await seededProduct(db);
    const session = await initializePaymentSession(db, {
      provider: PaymentProvider.Stripe,
      orderDraftId: "draft-j",
      amount: 500,
      currency: "EUR",
    });
    await verifyPaymentSession(db, { provider: PaymentProvider.Stripe, providerReference: session.providerReference });

    const unchanged = await getProductById(db, product.id);
    expect(unchanged.status).toBe(ProductStatus.Published);
    expect(unchanged.stockQuantity).toBe(1);
    expect(unchanged.priceEur).toBe(500);
  });
});
