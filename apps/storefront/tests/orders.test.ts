import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { buildCreateOrderPayload, createOrderFromPaidPayment } from "../src/lib/orders";
import type { OrderDraft } from "../src/lib/orderDraft";
import type { PaymentSelection } from "../src/lib/paymentSelection";

function mockFetchOnce(status: number, body: unknown, ok: boolean) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  }) as unknown as typeof fetch;
}

const draft: OrderDraft = {
  id: "draft-1",
  items: [
    {
      productId: "product-1",
      slug: "cart-slug",
      title: "Cart Title",
      eurPrice: 1200,
      quantity: 1,
      productType: "unique_item",
    },
  ],
  customer: { email: "jane@example.com", firstName: "Jane", lastName: "Collector", phone: "+331" },
  shippingAddress: {
    line1: "1 Rue Noctella",
    city: "Paris",
    postalCode: "75001",
    country: "France",
    countryCode: "FR",
  },
  billingSameAsShipping: true,
  currencySummary: { eurSubtotal: 1200 },
  status: "draft",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

const payment: PaymentSelection = {
  orderDraftId: "draft-1",
  provider: "stripe",
  providerReference: "mock_ref",
  status: "paid",
  amount: 1200,
  currency: "EUR",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

describe("createOrderFromPaidPayment", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("builds the expected create-order payload", () => {
    expect(buildCreateOrderPayload(draft, payment)).toEqual({
      orderDraftId: "draft-1",
      guestEmail: "jane@example.com",
      paymentStatus: "paid",
      paymentProvider: "stripe",
      paymentReference: "mock_ref",
      currency: "EUR",
      billingAddress: {
        fullName: "Jane Collector",
        line1: "1 Rue Noctella",
        line2: undefined,
        city: "Paris",
        region: undefined,
        postalCode: "75001",
        country: "France",
        phone: "+331",
      },
      shippingAddress: {
        fullName: "Jane Collector",
        line1: "1 Rue Noctella",
        line2: undefined,
        city: "Paris",
        region: undefined,
        postalCode: "75001",
        country: "France",
        phone: "+331",
      },
      subtotalAmount: 1200,
      totalAmount: 1200,
      notes: undefined,
      items: [{ productId: "product-1", quantity: 1 }],
    });
  });

  it("handles a successful create-order response", async () => {
    mockFetchOnce(201, { id: "order-1", orderNumber: "NOC-20260713-000001" }, true);

    const result = await createOrderFromPaidPayment(draft, payment);

    expect(result.orderNumber).toBe("NOC-20260713-000001");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/orders");
    expect(JSON.parse(options.body as string)).toMatchObject({
      orderDraftId: "draft-1",
      paymentStatus: "paid",
      paymentReference: "mock_ref",
    });
  });

  it("surfaces create-order failures", async () => {
    mockFetchOnce(400, { error: "Orders can only be created from paid payments" }, false);

    await expect(createOrderFromPaidPayment(draft, { ...payment, status: "pending" })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
