import type { RefundCancelRequest, RefundExecutionRequest, RefundProviderResponse, RefundStatusRequest } from "./types";
import type { RefundProviderCapabilities } from "./providerCapabilities";
export interface PaymentRefundPort { readonly capabilities?: RefundProviderCapabilities; executeRefund(request: RefundExecutionRequest): RefundProviderResponse | Promise<RefundProviderResponse>; cancelRefund(request: RefundCancelRequest): RefundProviderResponse | Promise<RefundProviderResponse>; getRefundStatus(request: RefundStatusRequest): RefundProviderResponse | Promise<RefundProviderResponse>; }
