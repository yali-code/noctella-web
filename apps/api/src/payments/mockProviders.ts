import { PaymentStatus } from "@noctella/shared";
import type {
  CancelPaymentInput,
  CancelPaymentResult,
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentProviderClient,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from "./provider";

/**
 * Shared mock behavior for all three providers below: deterministic,
 * in-memory-only fake responses. No network calls, no payment sessions.
 */
abstract class BaseMockPaymentProvider implements PaymentProviderClient {
  protected abstract referencePrefix: string;

  async initializePayment(input: InitializePaymentInput): Promise<InitializePaymentResult> {
    return {
      providerReference: `${this.referencePrefix}_${input.orderDraftId}`,
      status: PaymentStatus.Pending,
    };
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    return {
      providerReference: input.providerReference,
      status: PaymentStatus.Paid,
    };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentResult> {
    return {
      providerReference: input.providerReference,
      status: PaymentStatus.Cancelled,
    };
  }
}

export class MockStripeProvider extends BaseMockPaymentProvider {
  protected referencePrefix = "mock_stripe";
}

export class MockPayPalProvider extends BaseMockPaymentProvider {
  protected referencePrefix = "mock_paypal";
}

export class MockCashOnDeliveryProvider extends BaseMockPaymentProvider {
  protected referencePrefix = "mock_cod";
}
