import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { cancelMockPayment, initializeMockPayment, verifyMockPayment } from "../src/lib/payments";

function mockFetchOnce(status: number, body: unknown, ok: boolean) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("initializeMockPayment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the expected request payload", async () => {
    mockFetchOnce(201, { providerReference: "mock_stripe_draft-1", status: "pending" }, true);

    await initializeMockPayment({
      provider: "stripe",
      orderDraftId: "draft-1",
      amount: 500,
      currency: "EUR",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(options.body as string);
    expect(sentBody).toEqual({
      provider: "stripe",
      orderDraftId: "draft-1",
      amount: 500,
      currency: "EUR",
    });
  });

  it("handles a successful mock initialization response", async () => {
    mockFetchOnce(201, { providerReference: "mock_paypal_draft-1", status: "pending" }, true);

    const result = await initializeMockPayment({
      provider: "paypal",
      orderDraftId: "draft-1",
      amount: 250,
      currency: "EUR",
    });

    expect(result.providerReference).toBe("mock_paypal_draft-1");
    expect(result.status).toBe("pending");
  });

  it("handles a failed initialization", async () => {
    mockFetchOnce(400, { error: "Unsupported payment provider" }, false);

    await expect(
      initializeMockPayment({
        provider: "bitcoin",
        orderDraftId: "draft-1",
        amount: 250,
        currency: "EUR",
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("verifyMockPayment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles a successful verification", async () => {
    mockFetchOnce(200, { providerReference: "mock_stripe_draft-1", status: "paid" }, true);
    const result = await verifyMockPayment({ provider: "stripe", providerReference: "mock_stripe_draft-1" });
    expect(result.status).toBe("paid");
  });

  it("handles a failed verification", async () => {
    mockFetchOnce(400, { error: "Verification failed" }, false);
    await expect(
      verifyMockPayment({ provider: "stripe", providerReference: "mock_stripe_draft-1" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("cancelMockPayment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles a successful cancellation", async () => {
    mockFetchOnce(200, { providerReference: "mock_stripe_draft-1", status: "cancelled" }, true);
    const result = await cancelMockPayment({ provider: "stripe", providerReference: "mock_stripe_draft-1" });
    expect(result.status).toBe("cancelled");
  });
});
