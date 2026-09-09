export const DEFAULT_MARKETPLACE_REQUEST_TIMEOUT_MS = 10_000;
export const MIN_MARKETPLACE_REQUEST_TIMEOUT_MS = 1;
export const MAX_MARKETPLACE_REQUEST_TIMEOUT_MS = 30_000;
export const MARKETPLACE_REQUEST_TIMEOUT_RULE = "must be a decimal integer from 1 to 30000";

export function resolveMarketplaceRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MARKETPLACE_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_MARKETPLACE_REQUEST_TIMEOUT_MS;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid marketplace configuration: MARKETPLACE_REQUEST_TIMEOUT_MS ${MARKETPLACE_REQUEST_TIMEOUT_RULE}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_MARKETPLACE_REQUEST_TIMEOUT_MS || parsed > MAX_MARKETPLACE_REQUEST_TIMEOUT_MS) {
    throw new Error(`Invalid marketplace configuration: MARKETPLACE_REQUEST_TIMEOUT_MS ${MARKETPLACE_REQUEST_TIMEOUT_RULE}`);
  }
  return parsed;
}
