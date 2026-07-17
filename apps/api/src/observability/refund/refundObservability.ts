import type { RefundObservability } from "./types";
import type { RefundLogger } from "../../services/refundApplicationContext";
import { safeRefundLogMeta } from "./safeRefundLogger";
const call = async (
  fn: undefined | ((m: any) => void | Promise<void>),
  meta: any,
  logger?: RefundLogger,
) => {
  try {
    await fn?.(meta);
  } catch (e) {
    try {
      logger?.warn?.(
        "refund observability failed",
        safeRefundLogMeta({
          error: e instanceof Error ? e.message : "observability failed",
        }),
      );
    } catch {
      /* swallow */
    }
  }
};
export async function emitRefundSignal(
  observer: RefundObservability | undefined,
  method: keyof RefundObservability,
  meta: any,
  logger?: RefundLogger,
) {
  await call(observer?.[method] as any, meta, logger);
}
export const noopRefundObservability: RefundObservability = Object.freeze({});
