import { api } from "./api";

export interface InitializeMockPaymentInput {
  provider: string;
  orderDraftId: string;
  amount: number;
  currency: string;
}

export interface InitializeMockPaymentResult {
  providerReference: string;
  status: string;
}

export function initializeMockPayment(
  input: InitializeMockPaymentInput,
): Promise<InitializeMockPaymentResult> {
  return api.post<InitializeMockPaymentResult>("/api/payments/initialize", input);
}

export interface VerifyMockPaymentInput {
  provider: string;
  providerReference: string;
}

export interface VerifyMockPaymentResult {
  providerReference: string;
  status: string;
}

export function verifyMockPayment(input: VerifyMockPaymentInput): Promise<VerifyMockPaymentResult> {
  return api.post<VerifyMockPaymentResult>("/api/payments/verify", input);
}

export interface CancelMockPaymentInput {
  provider: string;
  providerReference: string;
}

export interface CancelMockPaymentResult {
  providerReference: string;
  status: string;
}

export function cancelMockPayment(input: CancelMockPaymentInput): Promise<CancelMockPaymentResult> {
  return api.post<CancelMockPaymentResult>("/api/payments/cancel", input);
}
