// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaidProviderReadinessReview } from "./PaidProviderReadinessReview";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

const provider = (platform: string, configured: boolean) => ({
  platform, configured, status: configured ? "CONFIG_REVIEW_REQUIRED" : "NOT_CONFIGURED",
  requiredChecks: [`Verify ${platform} account`], connectionVerified: false, campaignsEnabled: false, spendAuthorized: false,
});
const valid = { providers: [provider("meta", true), provider("google_ads", false), provider("pinterest_ads", false)], campaignsEnabled: false, spendAuthorized: false };

/** Phase 6: configured credentials, verified connection and spending permission are never conflated. */
describe("ADS-006G paid provider readiness checklist", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("shows configuration presence separately from connection verification and spending", async () => {
    vi.mocked(api.get).mockResolvedValue(valid);
    render(<PaidProviderReadinessReview />);
    expect(api.get).not.toHaveBeenCalled(); // nothing is fetched until the owner asks
    await userEvent.setup().click(screen.getByRole("button", { name: "Check paid account readiness" }));
    expect(api.get).toHaveBeenCalledWith("/api/analytics/ads/providers/readiness");
    expect(await screen.findByText("Meta Ads: CONFIG REVIEW REQUIRED")).toBeInTheDocument();
    expect(screen.getByText(/Server config present: Yes — still requires account review/)).toBeInTheDocument();
    expect(screen.getAllByText(/Provider connection verified: NO\. Spending authorized: NO\./)).toHaveLength(3);
    expect(screen.getByText("Paid publishing and spending: DISABLED")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull(); // no credential entry
    expect(screen.getAllByRole("button")).toHaveLength(1); // no campaign, budget or spend control
  });

  it("refuses to render a response that claims verification, campaigns or spend permission", async () => {
    for (const tampered of [
      { ...valid, spendAuthorized: true },
      { ...valid, campaignsEnabled: true },
      { ...valid, providers: [{ ...provider("meta", true), connectionVerified: true }, provider("google_ads", false), provider("pinterest_ads", false)] },
      { ...valid, providers: [{ ...provider("meta", true), spendAuthorized: true }, provider("google_ads", false), provider("pinterest_ads", false)] },
      { ...valid, providers: [provider("meta", true), provider("google_ads", false)] },
      // The API is not trusted merely because it conforms to TypeScript's static types.
      { ...valid, providers: [{ ...provider("meta", true), configured: "false" }, provider("google_ads", false), provider("pinterest_ads", false)] },
      { ...valid, providers: [{ ...provider("meta", true), status: "NOT_CONFIGURED" }, provider("google_ads", false), provider("pinterest_ads", false)] },
      { ...valid, providers: [{ ...provider("meta", true), requiredChecks: [{ token: "fake-secret" }] }, provider("google_ads", false), provider("pinterest_ads", false)] },
      { ...valid, providers: [{ ...provider("meta", true), platform: "constructor" }, provider("google_ads", false), provider("pinterest_ads", false)] },
    ]) {
      vi.mocked(api.get).mockResolvedValueOnce(tampered);
      const { unmount } = render(<PaidProviderReadinessReview />);
      await userEvent.setup().click(screen.getByRole("button", { name: "Check paid account readiness" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected paid account readiness response. Nothing has been enabled.");
      expect(screen.queryByText(/DISABLED/)).toBeNull();
      expect(screen.queryByText("fake-secret")).toBeNull();
      unmount();
    }
  });
});
