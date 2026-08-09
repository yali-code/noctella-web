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
export interface InitializeStripeCheckoutInput { provider:"stripe"; orderDraftId:string; guestEmail:string; billingAddress:Record<string,unknown>; shippingAddress:Record<string,unknown>; notes?:string; items:Array<{productId:string;quantity:1}> }
export interface InitializeStripeCheckoutResult { paymentId:string; checkoutUrl:string }
export function initializeStripeCheckout(input:InitializeStripeCheckoutInput){return api.post<InitializeStripeCheckoutResult>("/api/payments/initialize",input);}
export function getPaymentStatus(paymentId:string){return api.get<{status:string;order?:{id:string;orderNumber:string}}>(`/api/payments/${encodeURIComponent(paymentId)}/status`);}

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
