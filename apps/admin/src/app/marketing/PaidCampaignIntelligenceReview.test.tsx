// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaidCampaignIntelligenceReview } from "./PaidCampaignIntelligenceReview";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

const window = (end: string, spend: number | null) => ({
  period: { start: `2026-09-${end}T21:00:00.000Z`, end: `2026-09-${end}T21:00:00.000Z` },
  spendEur: spend, impressions: 7000, clicks: 140,
  rates: { days: 7, spendEurPerDay: spend === null ? null : spend / 7, cpcEur: spend === null ? null : spend / 140, cpmEur: spend === null ? null : spend / 7, ctr: 0.02, gaps: spend === null ? ["SPEND_UNKNOWN"] : [] },
});
const analysed = {
  provider: "meta", campaignId: "120210000000000001", currency: "EUR", source: "EXISTING_ANALYTICS_SNAPSHOTS", status: "ANALYSED",
  windows: [window("21", 210), window("14", null)],
  trend: { spendPerDayChange: 2, ctrChange: 0, cpcChange: 2, cpmChange: 2 },
  anomalies: [{ code: "SPEND_SPIKE", detail: "Spend/day 30 EUR vs baseline median 10 EUR." }, { code: "DELIVERY_WITHOUT_SPEND", detail: "Impressions recorded with zero spend." }],
  recommendations: [{ code: "REVIEW_DATA_QUALITY", reason: "Review first." }, { code: "INVESTIGATE_SPEND_SPIKE", reason: "Check budget." }],
  dataQuality: { untrustedWindows: 1, overlappingWindowsExcluded: 0 },
  marketplaceAttributionVerified: false, marketplaceRoas: null, organicMetricsIncluded: false,
  eligibleForAutomaticAction: false, budgetChangeEur: null, spendAuthorized: false,
};
async function analyse() {
  const user = userEvent.setup();
  render(<PaidCampaignIntelligenceReview />);
  await user.type(screen.getByLabelText("Intelligence campaign ID"), "120210000000000001");
  await user.click(screen.getByRole("button", { name: "Analyse paid campaign" }));
}

describe("ADS-007 Admin paid intelligence (advisory only)", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("shows windows, unknowns, separated data-quality warnings and advisory recommendations", async () => {
    vi.mocked(api.get).mockResolvedValue(analysed);
    await analyse();
    expect(api.get).toHaveBeenCalledWith("/api/analytics/ads/intelligence/meta/120210000000000001");
    expect(await screen.findByText(/Data-quality warnings/)).toBeInTheDocument();
    expect(screen.getByText(/1 stored window\(s\) failed provenance checks/)).toBeInTheDocument();
    expect(screen.getByText(/delivery without spend/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Performance anomalies" })).toHaveTextContent("spend spike");
    expect(screen.getByText("€210.00")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0); // missing spend is not zero
    expect(screen.getByText(/Marketplace ROAS:/)).toHaveTextContent("not computed");
    expect(screen.getByText(/Advisory only: no budget, bid or campaign change/)).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1); // only the analyse button - no campaign controls
  });

  it("refuses responses that claim authority, attribution, ROAS or organic data", async () => {
    for (const tampered of [{ spendAuthorized: true }, { eligibleForAutomaticAction: true }, { budgetChangeEur: 10 }, { marketplaceRoas: 3.2 }, { marketplaceAttributionVerified: true }, { organicMetricsIncluded: true }, { currency: "USD" }]) {
      vi.mocked(api.get).mockResolvedValueOnce({ ...analysed, ...tampered });
      const { unmount } = render(<PaidCampaignIntelligenceReview />);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Intelligence campaign ID"), "120210000000000001");
      await user.click(screen.getByRole("button", { name: "Analyse paid campaign" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected intelligence response. Nothing displayed.");
      unmount();
    }
  });

  it("validates the campaign id before calling the API", async () => {
    const user = userEvent.setup();
    render(<PaidCampaignIntelligenceReview />);
    await user.type(screen.getByLabelText("Intelligence campaign ID"), "12ab");
    await user.click(screen.getByRole("button", { name: "Analyse paid campaign" }));
    expect(screen.getByRole("alert")).toHaveTextContent("5–25 digits");
    expect(api.get).not.toHaveBeenCalled();
  });
});
