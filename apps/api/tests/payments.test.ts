import { PaymentProvider, PaymentStatus } from "@noctella/shared";
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../src/services/errors";
import {
  cancelMockPayment,
  initializeMockPayment,
  selectPaymentProvider,
  verifyMockPayment,
} from "../src/payments/paymentService";

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
