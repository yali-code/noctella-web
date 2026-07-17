export type RefundProviderId = string;
export type RefundProviderOutcome = "success" | "retryable_failure" | "terminal_failure";
export type SafeRefundProviderMetadata = Readonly<Record<string, string | number | boolean | null>>;
export interface RefundProviderLineItem { readonly id: string; readonly amount: number; readonly quantity?: number | null; }
export interface RefundExecutionRequest { readonly refundId: string; readonly orderId: string; readonly returnRequestId?: string | null; readonly amount: number; readonly currency: string; readonly providerTransactionReference?: string | null; readonly marketplaceOrderReference?: string | null; readonly idempotencyKey: string; readonly reason?: string | null; readonly items?: readonly RefundProviderLineItem[]; readonly metadata?: SafeRefundProviderMetadata; }
export interface RefundCancelRequest { readonly refundId: string; readonly externalRefundId?: string | null; readonly idempotencyKey?: string | null; readonly metadata?: SafeRefundProviderMetadata; }
export interface RefundStatusRequest { readonly refundId: string; readonly externalRefundId?: string | null; readonly metadata?: SafeRefundProviderMetadata; }
export interface RefundProviderSuccessResult { readonly outcome: "success"; readonly externalRefundId: string; readonly providerStatus: string; readonly processedAt?: string | null; readonly metadata?: SafeRefundProviderMetadata; }
export interface RefundProviderRetryableFailureResult { readonly outcome: "retryable_failure"; readonly code: string; readonly message: string; readonly retryAfter?: number | null; readonly providerStatus?: string | null; readonly metadata?: SafeRefundProviderMetadata; }
export interface RefundProviderTerminalFailureResult { readonly outcome: "terminal_failure"; readonly code: string; readonly message: string; readonly providerStatus?: string | null; readonly metadata?: SafeRefundProviderMetadata; }
export type RefundProviderResult = RefundProviderSuccessResult | RefundProviderRetryableFailureResult | RefundProviderTerminalFailureResult;
export type RefundProviderResponse = RefundProviderResult | { providerRefundId: string; status: string };
export function isProviderSuccess(result: RefundProviderResponse): result is RefundProviderSuccessResult { return (result as RefundProviderResult).outcome === "success"; }
export function toProviderResult(result: RefundProviderResponse): RefundProviderResult { if ((result as RefundProviderResult).outcome) return result as RefundProviderResult; const legacy = result as {providerRefundId:string; status:string}; return { outcome:"success", externalRefundId: legacy.providerRefundId, providerStatus: legacy.status }; }
