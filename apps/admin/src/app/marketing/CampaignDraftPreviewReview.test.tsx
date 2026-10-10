// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignDraftPreviewReview } from "./CampaignDraftPreviewReview";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

const entry = (errors: string[]) => ({
  fingerprint: "a".repeat(64),
  draft: {
    provider: "meta", productId: "NOC-000007", objective: "MARKETPLACE_TRAFFIC", status: "DRAFT",
    destination: { marketplace: "ebay", url: "https://www.ebay.de/itm/1" },
    creative: { format: "CAROUSEL", headline: "Olympus OM-1", primaryText: "As photographed.", callToAction: "View the original listing", mediaPhotoIds: ["ph-1", "ph-2"] },
    targeting: { keywordHints: ["film-camera"], categoryHint: "cat", geography: null, demographics: null, ownerMustConfirm: true },
    budget: { currency: "EUR", proposedDailyEur: null, hardDailyLimitEur: 5, hardTotalLimitEur: 20, guardDecision: "BLOCKED" }, notes: [],
  },
  validation: { valid: errors.length === 0, errors, executionBlockers: ["PROVIDER_EXECUTION_DISABLED"], executionEnabled: false, spendAuthorized: false },
  approval: { status: errors.length ? "DRAFT_INVALID" : "NOT_APPROVED", executionAuthorized: false, spendAuthorized: false },
});
const preview = {
  productId: "NOC-000007", provider: "meta", scope: "DRAFT_PREVIEW_ONLY", capabilityLimitsSource: "PLANNING_DEFAULTS_UNVERIFIED",
  media: { selected: [{ photoId: "ph-1", url: "/x" }, { photoId: "ph-2", url: "/y" }], excluded: [{ photoId: "ph-3", reason: "NOT_READY" }] },
  drafts: [entry(["BUDGET_NOT_PROPOSED", "BUDGET_BLOCKED"])],
  ownerApprovalRecorded: false, executionEnabled: false, spendAuthorized: false,
};
async function submit(productId = "NOC-000007") {
  const user = userEvent.setup();
  render(<CampaignDraftPreviewReview />);
  await user.type(screen.getByLabelText("Draft product ID"), productId);
  await user.click(screen.getByRole("button", { name: "Preview campaign draft" }));
}

describe("ADS-008 Admin campaign draft preview", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("shows media, validation and keeps draft approval separate from execution authorization", async () => {
    vi.mocked(api.get).mockResolvedValue(preview);
    await submit();
    expect(api.get).toHaveBeenCalledWith("/api/analytics/ads/campaign-draft/NOC-000007?provider=meta&requestedDailyEur=2&hardDailyLimitEur=5&hardTotalLimitEur=20");
    expect(await screen.findByText(/Approved ERP media: ph-1, ph-2/)).toHaveTextContent("ph-3 (not ready)");
    expect(screen.getByText(/invalid — budget not proposed, budget blocked/)).toBeInTheDocument();
    expect(screen.getByText("Draft approval").nextSibling).toHaveTextContent("Not recorded — approvals cannot be saved yet (draft invalid)");
    expect(screen.getByText("Execution authorization").nextSibling).toHaveTextContent("Disabled — provider execution disabled");
    expect(screen.getByText(/geography and demographics not set/)).toBeInTheDocument();
    // No approve/launch/budget control: the only button is the preview request.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Preview campaign draft"]);
  });

  it("refuses responses implying a recorded approval, execution or spend authority", async () => {
    for (const tampered of [
      { ...preview, ownerApprovalRecorded: true }, { ...preview, executionEnabled: true }, { ...preview, spendAuthorized: true },
      { ...preview, drafts: [{ ...entry([]), approval: { status: "APPROVED_FOR_EXECUTION_REVIEW", executionAuthorized: true, spendAuthorized: false } }] },
      { ...preview, drafts: [{ ...entry([]), draft: { ...entry([]).draft, status: "ACTIVE" } }] },
    ]) {
      vi.mocked(api.get).mockResolvedValueOnce(tampered);
      const user = userEvent.setup();
      const { unmount } = render(<CampaignDraftPreviewReview />);
      await user.type(screen.getByLabelText("Draft product ID"), "NOC-000007");
      await user.click(screen.getByRole("button", { name: "Preview campaign draft" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected campaign draft response. Nothing displayed.");
      unmount();
    }
  });

  it("validates product id and EUR amounts before calling the API", async () => {
    await submit("bad id!");
    expect(screen.getByRole("alert")).toHaveTextContent("valid ERP product ID");
    expect(api.get).not.toHaveBeenCalled();
  });
});
