// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaidCampaignPerformanceReview } from "./PaidCampaignPerformanceReview";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const report = (provider: string, campaignId: string, spendEur: number) => ({
  provider, campaignId, status: "REPORT_AVAILABLE", source: "EXISTING_ANALYTICS_SNAPSHOTS", marketplaceAttributionVerified: false, spendAuthorized: false,
  period: { start: "2026-09-14T21:00:00.000Z", end: "2026-09-21T21:00:00.000Z" },
  evidence: { evidenceLevel: "SPEND_AND_TRAFFIC_ONLY", spendEur, impressions: 7000, clicks: 140, providerReportedConversions: null, providerReportedConversionValueEur: null, marketplaceConfirmedOrders: null, reportedRoas: null, attributedMarketplaceRevenueEur: null, cannotInferMarketplacePurchasesFromClicks: true, warnings: [] },
  advice: { recommendation: "REVIEW_SPEND_AND_TRAFFIC", reasons: [], eligibleForAutomaticAction: false, budgetChangeEur: null, campaignPauseExecuted: false, spendAuthorized: false },
});

/** The existing paid performance view must never show a response for an outdated selection. */
describe("Paid performance review: stale responses", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("drops an older campaign's late response and a late error after the provider changes", async () => {
    const first = deferred<unknown>(), second = deferred<unknown>(), third = deferred<unknown>();
    vi.mocked(api.get).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never).mockReturnValueOnce(third.promise as never);
    const user = userEvent.setup();
    render(<PaidCampaignPerformanceReview />);
    const input = screen.getByLabelText("Provider campaign ID");
    await user.type(input, "111111111111");
    await user.click(screen.getByRole("button", { name: "Review paid performance" }));
    await user.clear(input);
    await user.type(input, "222222222222");
    await user.click(screen.getByRole("button", { name: "Review paid performance" }));
    await act(async () => second.resolve(report("meta", "222222222222", 12.5)));
    expect(await screen.findByText("€12.50")).toBeInTheDocument();
    await act(async () => first.resolve(report("meta", "111111111111", 99)));
    expect(screen.queryByText("€99.00")).toBeNull();
    expect(screen.getByText("€12.50")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Review paid performance" }));
    await user.selectOptions(screen.getByLabelText("Advertising platform"), "google_ads");
    expect(screen.queryByText("€12.50")).toBeNull();
    await act(async () => third.reject(new Error("late meta failure")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Review paid performance" })).toBeEnabled();
  });
});
