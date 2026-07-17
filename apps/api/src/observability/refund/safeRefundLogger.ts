import type { RefundLogger } from "../../services/refundApplicationContext";
const forbidden =
  /(authorization|token|password|secret|credential|raw|card|cvv|pan|address|email|phone|stack|db|connection)/i;
export function safeRefundLogMeta(meta: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta))
    if (!forbidden.test(k))
      out[k] = typeof v === "string" ? v.slice(0, 240) : v;
  return Object.freeze(out);
}
export function createSafeRefundLogger(logger: RefundLogger) {
  return Object.freeze({
    debug: (m: string, meta?: Record<string, unknown>) =>
      logger.debug?.(m, safeRefundLogMeta(meta)),
    info: (m: string, meta?: Record<string, unknown>) =>
      logger.info?.(m, safeRefundLogMeta(meta)),
    warn: (m: string, meta?: Record<string, unknown>) =>
      logger.warn?.(m, safeRefundLogMeta(meta)),
    error: (m: string, meta?: Record<string, unknown>) =>
      logger.error?.(m, safeRefundLogMeta(meta)),
  });
}
