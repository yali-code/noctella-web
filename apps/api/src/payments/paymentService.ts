import { PaymentProvider } from "@noctella/shared";
import { BadRequestError } from "../services/errors";
import { MockCashOnDeliveryProvider, MockPayPalProvider, MockStripeProvider } from "./mockProviders";
import type { PaymentProviderClient } from "./provider";

const providers: Record<PaymentProvider, PaymentProviderClient> = {
  [PaymentProvider.Stripe]: new MockStripeProvider(),
  [PaymentProvider.PayPal]: new MockPayPalProvider(),
  [PaymentProvider.CashOnDelivery]: new MockCashOnDeliveryProvider(),
};

/**
 * Sprint 76: fail-closed production safety gate. Every provider above is a mock (no real
 * gateway exists yet), so mock usage must never be silently possible in production. An explicit
 * MOCK_PAYMENTS_ENABLED override ("true"/"false") always wins; when unset, mock payments remain
 * enabled everywhere except NODE_ENV=production, which requires the explicit "true" opt-in
 * (e.g. Render staging sets this deliberately - see render.yaml).
 */
export function mockPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MOCK_PAYMENTS_ENABLED === "true") return true;
  if (env.MOCK_PAYMENTS_ENABLED === "false") return false;
  return env.NODE_ENV !== "production";
}

/**
 * Throws BadRequestError for any provider not in the supported enum, or when mock payments are
 * not enabled in the current environment. This is the single choke point every mock
 * initialize/verify/cancel call passes through, so the gate applies uniformly to all three and
 * fails before any mock provider call - and therefore before an order could ever be treated as
 * paid from a rejected initialization.
 */
export function selectPaymentProvider(provider: string): PaymentProviderClient {
  if (!mockPaymentsEnabled()) {
    throw new BadRequestError("Mock payment providers are not enabled in this environment");
  }
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
