import { PaymentProvider } from "@noctella/shared";
import { BadRequestError } from "../services/errors";
import { MockCashOnDeliveryProvider, MockPayPalProvider, MockStripeProvider } from "./mockProviders";
import type { PaymentProviderClient } from "./provider";

const providers: Record<PaymentProvider, PaymentProviderClient> = {
  [PaymentProvider.Stripe]: new MockStripeProvider(),
  [PaymentProvider.PayPal]: new MockPayPalProvider(),
  [PaymentProvider.CashOnDelivery]: new MockCashOnDeliveryProvider(),
};

/** Throws BadRequestError for any provider not in the supported enum. */
export function selectPaymentProvider(provider: string): PaymentProviderClient {
  const client = providers[provider as PaymentProvider];
  if (!client) {
    throw new BadRequestError(`Unsupported payment provider: "${provider}"`);
  }
  return client;
}

export async function initializeMockPayment(
  provider: string,
  input: { orderDraftId: string; amount: number; currency: string },
) {
  const client = selectPaymentProvider(provider);
  return client.initializePayment(input);
}

export async function verifyMockPayment(provider: string, input: { providerReference: string }) {
  const client = selectPaymentProvider(provider);
  return client.verifyPayment(input);
}

export async function cancelMockPayment(provider: string, input: { providerReference: string }) {
  const client = selectPaymentProvider(provider);
  return client.cancelPayment(input);
}
