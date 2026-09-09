import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MARKETPLACE_REQUEST_TIMEOUT_MS,
  MAX_MARKETPLACE_REQUEST_TIMEOUT_MS,
  MIN_MARKETPLACE_REQUEST_TIMEOUT_MS,
  resolveMarketplaceRequestTimeoutMs,
} from "../src/config/marketplaceConfig";
import { EbayAdapter } from "../src/services/marketplaceAdapters";
import { marketplacePauseLeaseMs } from "../src/services/productLifecycle";

const originalTimeout = process.env.MARKETPLACE_REQUEST_TIMEOUT_MS;

beforeEach(() => {
  delete process.env.MARKETPLACE_REQUEST_TIMEOUT_MS;
});

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.MARKETPLACE_REQUEST_TIMEOUT_MS;
  else process.env.MARKETPLACE_REQUEST_TIMEOUT_MS = originalTimeout;
  vi.restoreAllMocks();
});

describe("Sprint 165 marketplace request timeout contract", () => {
  it("preserves the optional default and accepts the exact bounds and ordinary value", () => {
    expect(resolveMarketplaceRequestTimeoutMs({})).toBe(DEFAULT_MARKETPLACE_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_MARKETPLACE_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(MIN_MARKETPLACE_REQUEST_TIMEOUT_MS).toBe(1);
    expect(MAX_MARKETPLACE_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(resolveMarketplaceRequestTimeoutMs({ MARKETPLACE_REQUEST_TIMEOUT_MS: "1" })).toBe(1);
    expect(resolveMarketplaceRequestTimeoutMs({ MARKETPLACE_REQUEST_TIMEOUT_MS: "10000" })).toBe(10_000);
    expect(resolveMarketplaceRequestTimeoutMs({ MARKETPLACE_REQUEST_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(resolveMarketplaceRequestTimeoutMs({ MARKETPLACE_REQUEST_TIMEOUT_MS: " 10000 " })).toBe(10_000);
  });

  it.each([
    "", "   ", "0", "-1", "1.5", "-1.5", "1e4", "+10000", "NaN", "Infinity", "-Infinity",
    "abc", "10000ms", "30001", "9007199254740993",
  ])("rejects invalid explicit value %# without exposing it", (raw) => {
    try { resolveMarketplaceRequestTimeoutMs({ MARKETPLACE_REQUEST_TIMEOUT_MS: raw }); } catch (error) {
      expect((error as Error).message).toBe(
        "Invalid marketplace configuration: MARKETPLACE_REQUEST_TIMEOUT_MS must be a decimal integer from 1 to 30000",
      );
      return;
    }
    throw new Error("Expected invalid marketplace timeout to be rejected");
  });

  it("passes a valid injected adapter timeout to the timer", async () => {
    const timer = vi.spyOn(global, "setTimeout");
    vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ id: "account" }) } as Response);
    await new EbayAdapter({ MARKETPLACE_REQUEST_TIMEOUT_MS: "25000" }).verifyConnection("token");
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 25_000);
  });

  it("rejects an invalid injected adapter timeout before fetch", async () => {
    const fetch = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await expect(new EbayAdapter({ MARKETPLACE_REQUEST_TIMEOUT_MS: "secret-invalid-165" }).verifyConnection("token")).rejects.toThrow(
      /MARKETPLACE_REQUEST_TIMEOUT_MS.*1 to 30000/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the shared environment resolver while preserving the lifecycle lease formula", () => {
    expect(marketplacePauseLeaseMs()).toBe(60_000);
    process.env.MARKETPLACE_REQUEST_TIMEOUT_MS = "30000";
    expect(marketplacePauseLeaseMs()).toBe(90_000);
    expect(marketplacePauseLeaseMs(1)).toBe(60_000);
    expect(marketplacePauseLeaseMs(30_000)).toBe(90_000);
    process.env.MARKETPLACE_REQUEST_TIMEOUT_MS = "NaN";
    expect(() => marketplacePauseLeaseMs()).toThrow(/MARKETPLACE_REQUEST_TIMEOUT_MS/);
  });
});
