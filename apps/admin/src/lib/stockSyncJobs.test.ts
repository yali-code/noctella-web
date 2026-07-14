import { describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { cancelBackgroundJob, canCancelJob, canRetryJob, getBackgroundJob, getConflict, getStockSyncStatus, listBackgroundJobs, listConflicts, listingLink, productLink, resolveConflict, retryBackgroundJob, safeError, stockSyncAudit } from "./stockSyncJobs";

vi.mock("./api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const mockedApi = vi.mocked(api);

describe("stock sync admin helpers", () => {
  it("maps background job list/detail calls and retry/cancel eligibility", async () => {
    mockedApi.get.mockResolvedValueOnce({ items: [{ id: "job-1", status: "failed" }] });
    await expect(listBackgroundJobs("?status=failed&type=stock_sync_listing&channel=ebay&productId=p1")).resolves.toEqual({ items: [{ id: "job-1", status: "failed" }] });
    expect(mockedApi.get).toHaveBeenCalledWith("/api/background-jobs?status=failed&type=stock_sync_listing&channel=ebay&productId=p1");
    mockedApi.get.mockResolvedValueOnce({ id: "job-1" });
    await getBackgroundJob("job-1");
    expect(mockedApi.get).toHaveBeenCalledWith("/api/background-jobs/job-1");
    expect(canRetryJob({ id: "1", type: "t", status: "dead_letter", attemptCount: 1, maxAttempts: 5, runAfter: "now" })).toBe(true);
    expect(canCancelJob({ id: "1", type: "t", status: "processing", attemptCount: 1, maxAttempts: 5, runAfter: "now" })).toBe(true);
    await retryBackgroundJob("job-1"); await cancelBackgroundJob("job-1");
    expect(mockedApi.post).toHaveBeenCalledWith("/api/background-jobs/job-1/retry", {});
    expect(mockedApi.post).toHaveBeenCalledWith("/api/background-jobs/job-1/cancel", {});
  });

  it("maps summary, conflicts, resolution payloads, audit, links and safe error redaction", async () => {
    mockedApi.get.mockResolvedValueOnce({ jobs: [], latestAudit: [] });
    await getStockSyncStatus();
    expect(mockedApi.get).toHaveBeenCalledWith("/api/stock-sync/status");
    mockedApi.get.mockResolvedValueOnce({ items: [{ id: "conflict-1" }] });
    await listConflicts("?status=open&channel=etsy");
    expect(mockedApi.get).toHaveBeenCalledWith("/api/stock-sync/conflicts?status=open&channel=etsy");
    mockedApi.get.mockResolvedValueOnce({ id: "conflict-1" });
    await getConflict("conflict-1");
    expect(mockedApi.get).toHaveBeenCalledWith("/api/stock-sync/conflicts/conflict-1");
    await resolveConflict("conflict-1", "RetryLocalToMarketplace");
    expect(mockedApi.post).toHaveBeenCalledWith("/api/stock-sync/conflicts/conflict-1/resolve", { action: "RetryLocalToMarketplace" });
    mockedApi.get.mockResolvedValueOnce({ items: [{ id: "audit-1" }] });
    await stockSyncAudit();
    expect(mockedApi.get).toHaveBeenCalledWith("/api/stock-sync/audit");
    expect(safeError("Bearer secret token=abc")).not.toContain("secret");
    expect(productLink("p1")).toBe("/products/p1");
    expect(listingLink("ext id")).toBe("/external-listings?listing=ext%20id");
  });
});
