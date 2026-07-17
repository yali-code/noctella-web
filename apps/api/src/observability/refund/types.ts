import type { RefundEventEnvelope } from "../../domain/refund";
export type RefundSignalMeta = Readonly<Record<string, unknown>>;
export interface RefundObservability {
  refundTransitionRecorded?(event: RefundEventEnvelope): void | Promise<void>;
  refundExecutionStarted?(meta: RefundSignalMeta): void | Promise<void>;
  refundExecutionSucceeded?(meta: RefundSignalMeta): void | Promise<void>;
  refundExecutionFailed?(meta: RefundSignalMeta): void | Promise<void>;
  refundQueueRequested?(meta: RefundSignalMeta): void | Promise<void>;
  refundQueueFailed?(meta: RefundSignalMeta): void | Promise<void>;
  refundProviderResolved?(meta: RefundSignalMeta): void | Promise<void>;
  refundProviderUnsupported?(meta: RefundSignalMeta): void | Promise<void>;
  refundStaleVersionDetected?(meta: RefundSignalMeta): void | Promise<void>;
  refundIdempotentReplayDetected?(meta: RefundSignalMeta): void | Promise<void>;
}
