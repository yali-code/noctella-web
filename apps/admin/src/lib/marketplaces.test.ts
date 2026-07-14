import { PublishChannel, PublishJobStatus, type ExternalListing, type PublishJob } from "@noctella/shared";
import { describe, expect, it, vi } from "vitest";
import { canRetry, externalListingLink, marketplaceApi, safeError } from "./marketplaces";

const fetchMock = vi.fn();
global.fetch = fetchMock;

function json(data: unknown) {
  return Promise.resolve({ ok: true, headers: { get: () => "application/json" }, json: () => Promise.resolve(data) } as unknown as Response);
}

describe("admin marketplace helpers", () => {
  it("maps safe metadata and sanitizes errors", () => {
    expect(safeError("token-abcdef123456 secret-longvalue987654")).not.toContain("abcdef123456");
    const listing: ExternalListing = { id: "l1", productId: "p1", channel: PublishChannel.Ebay, connectionId: "c1", externalListingId: "ext1", externalListingUrl: "https://listing", externalStatus: "active", payloadSnapshot: {} as never, publishedAt: "now", updatedAt: "now" };
    expect(externalListingLink(listing)).toBe("https://listing");
    expect(externalListingLink({ ...listing, externalListingUrl: undefined })).toContain("ext1");
  });

  it("calculates retry eligibility", () => {
    expect(canRetry({ status: PublishJobStatus.RetryPending, attemptCount: 2 } as PublishJob)).toBe(true);
    expect(canRetry({ status: PublishJobStatus.Failed, attemptCount: 1 } as PublishJob)).toBe(false);
    expect(canRetry({ status: PublishJobStatus.RetryPending, attemptCount: 3 } as PublishJob)).toBe(false);
  });

  it("wraps connection and publish job API calls", async () => {
    fetchMock.mockImplementation((url: string) => json({ url }));
    await marketplaceApi.connect(PublishChannel.Ebay); await marketplaceApi.verify(PublishChannel.Ebay); await marketplaceApi.refresh(PublishChannel.Ebay); await marketplaceApi.disconnect(PublishChannel.Ebay);
    await marketplaceApi.executePublish("p1", PublishChannel.Etsy); await marketplaceApi.listJobs(); await marketplaceApi.getJob("j1"); await marketplaceApi.retry("j1"); await marketplaceApi.externalListings("p1");
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining("/api/marketplaces/ebay/connect"),
      expect.stringContaining("/api/marketplaces/ebay/verify"),
      expect.stringContaining("/api/marketplaces/ebay/refresh"),
      expect.stringContaining("/api/marketplaces/ebay/disconnect"),
      expect.stringContaining("/api/products/p1/publish/execute"),
      expect.stringContaining("/api/publish-jobs"),
      expect.stringContaining("/api/publish-jobs/j1"),
      expect.stringContaining("/api/products/p1/external-listings"),
    ]));
  });
});
