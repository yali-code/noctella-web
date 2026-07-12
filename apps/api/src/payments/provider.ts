import type { PaymentStatus } from "@noctella/shared";

export interface InitializePaymentInput {
  orderDraftId: string;
  amount: number;
  currency: string;
}

export interface InitializePaymentResult {
  providerReference: string;
  status: PaymentStatus;
}

export interface VerifyPaymentInput {
  providerReference: string;
}

export interface VerifyPaymentResult {
  providerReference: string;
  status: PaymentStatus;
}

export interface CancelPaymentInput {
  providerReference: string;
}

export interface CancelPaymentResult {
  providerReference: string;
  status: PaymentStatus;
}

/**
 * Contract for any payment provider. Sprint 6A ships only mock providers
 * (Stripe/PayPal/CashOnDelivery placeholders) — no real HTTP requests, no
 * payment sessions. A future provider implements this same interface to
 * connect a real payment gateway.
 */
export interface PaymentProviderClient {
  initializePayment(input: InitializePaymentInput): Promise<InitializePaymentResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentResult>;
}
